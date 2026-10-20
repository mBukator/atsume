import { XMLParser } from 'fast-xml-parser';
import { err, ok, type Result } from '../result';
import { normalizeUrl } from '../url';
import { decodeText, type HttpClient, type RequestOptions } from '../net/http';

export interface SitemapEntry {
  readonly loc: string;
  readonly lastModified: string | null;
}

export type SitemapDocument =
  | { readonly kind: 'urlset'; readonly entries: readonly SitemapEntry[] }
  | { readonly kind: 'index'; readonly sitemaps: readonly string[] };

export type SitemapError =
  | { readonly kind: 'malformed'; readonly message: string }
  | { readonly kind: 'unrecognised' };

// `removeNSPrefix` collapses `<sm:urlset>` to `<urlset>`, which real sitemaps
// use often enough to matter.
const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  removeNSPrefix: true,
  parseTagValue: false,
});

const asArray = (value: unknown): unknown[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

const readLoc = (node: unknown): string | null => {
  if (typeof node === 'string') return node.trim() === '' ? null : node.trim();
  if (typeof node !== 'object' || node === null) return null;
  const loc = (node as Record<string, unknown>)['loc'];
  return typeof loc === 'string' && loc.trim() !== '' ? loc.trim() : null;
};

const readLastMod = (node: unknown): string | null => {
  if (typeof node !== 'object' || node === null) return null;
  const value = (node as Record<string, unknown>)['lastmod'];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
};

export const parseSitemap = (xml: string): Result<SitemapDocument, SitemapError> => {
  let doc: unknown;
  try {
    doc = parser.parse(xml) as unknown;
  } catch (cause) {
    return err({ kind: 'malformed', message: cause instanceof Error ? cause.message : 'parse failed' });
  }
  if (typeof doc !== 'object' || doc === null) return err({ kind: 'unrecognised' });

  const root = doc as Record<string, unknown>;

  const index = root['sitemapindex'];
  if (index !== undefined && index !== null) {
    const nodes = asArray((index as Record<string, unknown>)['sitemap']);
    const sitemaps = nodes.map(readLoc).filter((loc): loc is string => loc !== null);
    return ok({ kind: 'index', sitemaps });
  }

  const urlset = root['urlset'];
  if (urlset !== undefined && urlset !== null) {
    const nodes = asArray((urlset as Record<string, unknown>)['url']);
    const entries: SitemapEntry[] = [];
    for (const node of nodes) {
      const loc = readLoc(node);
      if (loc !== null) entries.push({ loc, lastModified: readLastMod(node) });
    }
    return ok({ kind: 'urlset', entries });
  }

  return err({ kind: 'unrecognised' });
};

export interface SitemapCollectOptions {
  readonly maxUrls: number;
  readonly maxIndexDepth: number;
  /**
   * A hard ceiling on documents fetched. `maxUrls` cannot bound this on its
   * own: an index yields no URLs, so a root index with hundreds of children
   * would fetch every one of them before the counter moved at all.
   */
  readonly maxDocuments: number;
  /** Absolute epoch time to stop by, whatever has been collected so far. */
  readonly deadline: number;
  readonly now: () => number;
  readonly request: RequestOptions;
}

export interface SitemapCollection {
  readonly urls: readonly string[];
  readonly sitemapsRead: number;
  readonly failures: readonly { readonly url: string; readonly reason: string }[];
  /** True when a bound stopped the walk early rather than it running out. */
  readonly truncated: boolean;
}

/**
 * Walks sitemap indexes breadth-first. A malformed or unreachable sitemap is
 * recorded and stepped over: sitemaps are a seeding optimisation, and one bad
 * file should not stop discovery.
 */
export const collectSitemapUrls = async (
  http: HttpClient,
  roots: readonly string[],
  options: SitemapCollectOptions,
): Promise<SitemapCollection> => {
  const urls: string[] = [];
  const failures: { url: string; reason: string }[] = [];
  const seen = new Set<string>();
  let sitemapsRead = 0;
  let truncated = false;

  const exhausted = (): boolean => {
    if (urls.length >= options.maxUrls) return true;
    if (sitemapsRead >= options.maxDocuments) return true;
    if (options.now() >= options.deadline) return true;
    return false;
  };

  let frontier: { url: string; depth: number }[] = roots.map((url) => ({ url, depth: 0 }));

  while (frontier.length > 0) {
    // Checked at the top and inside, so exhausting a bound between levels is
    // recorded as truncation rather than passing for a walk that ran out.
    if (exhausted()) {
      truncated = true;
      break;
    }

    const next: { url: string; depth: number }[] = [];

    for (const { url, depth } of frontier) {
      if (exhausted()) {
        truncated = true;
        break;
      }
      const normalized = normalizeUrl(url);
      if (!normalized.ok) {
        failures.push({ url, reason: 'not a valid http(s) URL' });
        continue;
      }
      if (seen.has(normalized.value)) continue;
      seen.add(normalized.value);

      const response = await http.get(normalized.value, {
        ...options.request,
        accept: 'application/xml,text/xml,*/*;q=0.5',
      });
      if (!response.ok) {
        failures.push({ url, reason: response.error.kind });
        continue;
      }
      if (response.value.status >= 400) {
        failures.push({ url, reason: `HTTP ${response.value.status}` });
        continue;
      }

      sitemapsRead += 1;
      const parsed = parseSitemap(decodeText(response.value));
      if (!parsed.ok) {
        failures.push({ url, reason: parsed.error.kind });
        continue;
      }

      if (parsed.value.kind === 'index') {
        if (depth >= options.maxIndexDepth) {
          failures.push({ url, reason: 'sitemap index nested too deeply' });
          continue;
        }
        for (const child of parsed.value.sitemaps) next.push({ url: child, depth: depth + 1 });
        continue;
      }

      for (const entry of parsed.value.entries) {
        if (urls.length >= options.maxUrls) break;
        const entryUrl = normalizeUrl(entry.loc);
        if (entryUrl.ok) urls.push(entryUrl.value);
      }
    }

    frontier = next;
  }

  return { urls, sitemapsRead, failures, truncated };
};
