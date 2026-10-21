import type { MediaCandidate } from '../media';
import { classifyKindOrDefault, isHlsUrl } from './css-urls';
import { directCandidate, type Extractor, hintsFrom, resolveAgainst } from './context';

interface MetaRule {
  readonly selector: string;
  readonly attribute: 'property' | 'name';
  readonly keys: readonly string[];
  readonly kind: 'image' | 'video';
  readonly foundBy: MediaCandidate['foundBy'];
}

const META_RULES: readonly MetaRule[] = [
  {
    selector: 'meta[property]',
    attribute: 'property',
    keys: ['og:image', 'og:image:url', 'og:image:secure_url'],
    kind: 'image',
    foundBy: 'open-graph',
  },
  {
    selector: 'meta[property]',
    attribute: 'property',
    keys: ['og:video', 'og:video:url', 'og:video:secure_url'],
    kind: 'video',
    foundBy: 'open-graph',
  },
  {
    selector: 'meta[name]',
    attribute: 'name',
    keys: ['twitter:image', 'twitter:image:src'],
    kind: 'image',
    foundBy: 'twitter-card',
  },
  {
    selector: 'meta[name]',
    attribute: 'name',
    keys: ['twitter:player:stream'],
    kind: 'video',
    foundBy: 'twitter-card',
  },
];

/**
 * `og:image:width` follows its `og:image` in document order, so the dimensions
 * are read forward from each match rather than looked up globally.
 */
export const extractMeta: Extractor = (context) => {
  const candidates: MediaCandidate[] = [];
  const metas = context.$('meta').toArray();

  for (const rule of META_RULES) {
    metas.forEach((element, index) => {
      const $element = context.$(element);
      const key = ($element.attr(rule.attribute) ?? '').toLowerCase();
      if (!rule.keys.includes(key)) return;

      const content = $element.attr('content');
      if (content === undefined) return;
      const url = resolveAgainst(context, content);
      if (url === null) return;

      const dimensions = readFollowingDimensions(context.$, metas, index, key, rule.attribute);

      if (rule.kind === 'video' && isHlsUrl(url)) {
        candidates.push({
          url,
          kind: 'video',
          acquisition: { strategy: 'hls', manifestUrl: url },
          hints: hintsFrom(dimensions),
          foundBy: 'hls-manifest',
          foundOn: context.pageUrl,
        });
        return;
      }

      candidates.push(
        directCandidate(
          url,
          classifyKindOrDefault(url, dimensions.type, rule.kind),
          rule.foundBy,
          context.pageUrl,
          hintsFrom(dimensions),
        ),
      );
    });
  }

  return candidates;
};

const readFollowingDimensions = (
  $: ReturnType<typeof import('cheerio').load>,
  metas: readonly unknown[],
  from: number,
  key: string,
  attribute: 'property' | 'name',
): {
  width: string | undefined;
  height: string | undefined;
  alt: string | undefined;
  type: string | null;
} => {
  const base = key.replace(/:(url|secure_url)$/, '');
  let width: string | undefined;
  let height: string | undefined;
  let alt: string | undefined;
  let type: string | null = null;

  for (let index = from + 1; index < metas.length; index += 1) {
    const element = metas[index];
    if (element === undefined) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cheerio element
    const $element = $(element as never);
    const property = ($element.attr(attribute) ?? '').toLowerCase();
    if (!property.startsWith(`${base}:`)) break;

    const content = $element.attr('content');
    if (content === undefined) continue;
    if (property === `${base}:width`) width = content;
    if (property === `${base}:height`) height = content;
    if (property === `${base}:alt`) alt = content;
    if (property === `${base}:type`) type = content;
  }

  return { width, height, alt, type };
};

const MEDIA_TYPE_KEYS = new Set(['imageobject', 'videoobject']);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const typeNames = (node: Record<string, unknown>): string[] => {
  const raw = node['@type'];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.filter((value): value is string => typeof value === 'string').map((value) => value.toLowerCase());
};

const urlStrings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(urlStrings);
  const record = asRecord(value);
  if (record === null) return [];
  const nested = record['url'] ?? record['contentUrl'] ?? record['@id'];
  return typeof nested === 'string' ? [nested] : [];
};

interface JsonLdHit {
  readonly url: string;
  readonly kind: 'image' | 'video';
  readonly width: number | null;
  readonly height: number | null;
  readonly caption: string | null;
}

const numberOrNull = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
};

/**
 * Walks the whole graph rather than checking the top level: schema.org blocks
 * routinely bury an `ImageObject` several levels down inside `@graph`, or hang
 * it off an article's `publisher.logo`.
 */
export const walkJsonLd = (root: unknown, sink: JsonLdHit[], depth = 0): void => {
  if (depth > 12) return;

  if (Array.isArray(root)) {
    for (const entry of root) walkJsonLd(entry, sink, depth + 1);
    return;
  }

  const node = asRecord(root);
  if (node === null) return;

  const types = typeNames(node);
  const isMediaObject = types.some((type) => MEDIA_TYPE_KEYS.has(type));

  if (isMediaObject) {
    const kind = types.includes('videoobject') ? 'video' : 'image';
    const target = node['contentUrl'] ?? node['url'];
    for (const url of urlStrings(target)) {
      sink.push({
        url,
        kind,
        width: numberOrNull(node['width']),
        height: numberOrNull(node['height']),
        caption: typeof node['caption'] === 'string' ? node['caption'] : null,
      });
    }
  }

  for (const key of ['image', 'thumbnailUrl', 'thumbnail', 'primaryImageOfPage', 'logo']) {
    const value = node[key];
    if (value === undefined) continue;
    if (typeof value === 'string' || Array.isArray(value)) {
      for (const url of urlStrings(value)) {
        sink.push({ url, kind: 'image', width: null, height: null, caption: null });
      }
    }
  }

  for (const value of Object.values(node)) walkJsonLd(value, sink, depth + 1);
};

export const extractJsonLd: Extractor = (context) => {
  const candidates: MediaCandidate[] = [];
  const seen = new Set<string>();

  context.$('script[type="application/ld+json"]').each((_index, element) => {
    const raw = context.$(element).text().trim();
    if (raw === '') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      // Malformed JSON-LD is common and not worth failing a page over.
      return;
    }

    const hits: JsonLdHit[] = [];
    walkJsonLd(parsed, hits);

    for (const hit of hits) {
      const url = resolveAgainst(context, hit.url);
      if (url === null || seen.has(url)) continue;
      seen.add(url);

      if (hit.kind === 'video' && isHlsUrl(url)) {
        candidates.push({
          url,
          kind: 'video',
          acquisition: { strategy: 'hls', manifestUrl: url },
          hints: hintsFrom({}),
          foundBy: 'hls-manifest',
          foundOn: context.pageUrl,
        });
        continue;
      }

      candidates.push(
        directCandidate(
          url,
          classifyKindOrDefault(url, null, hit.kind),
          'json-ld',
          context.pageUrl,
          hintsFrom({
            alt: hit.caption ?? undefined,
            width: hit.width === null ? undefined : String(hit.width),
            height: hit.height === null ? undefined : String(hit.height),
          }),
        ),
      );
    }
  });

  return candidates;
};
