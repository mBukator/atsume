import * as cheerio from 'cheerio';
import type { CrawlOptions } from '../config';
import { normalizeUrl } from '../url';

export type ScopeDecision =
  | { readonly kind: 'in-scope' }
  | { readonly kind: 'off-origin'; readonly host: string }
  | { readonly kind: 'too-deep'; readonly depth: number };

export const decideScope = (
  url: string,
  depth: number,
  seedUrl: string,
  options: CrawlOptions,
): ScopeDecision => {
  if (depth > options.maxDepth) return { kind: 'too-deep', depth };

  let target: URL;
  let seed: URL;
  try {
    target = new URL(url);
    seed = new URL(seedUrl);
  } catch {
    return { kind: 'off-origin', host: url };
  }

  const host = target.host.toLowerCase();
  if (host === seed.host.toLowerCase()) return { kind: 'in-scope' };
  if (options.sameOriginOnly) return { kind: 'off-origin', host };

  const hostname = target.hostname.toLowerCase();
  const allowed = options.additionalHosts.some((entry) => entry.toLowerCase() === hostname);
  return allowed ? { kind: 'in-scope' } : { kind: 'off-origin', host };
};

const SKIP_SCHEMES = /^(mailto|tel|javascript|data|blob|about|ftp|sms):/i;

/**
 * Link discovery only. Media extraction is a separate concern with its own
 * module, so this deliberately ignores everything that is not a navigable link.
 */
export const extractLinks = (html: string, pageUrl: string): string[] => {
  const $ = cheerio.load(html);

  // `<base href>` retargets every relative URL on the page, including ones
  // that look obviously relative to the document.
  const declaredBase = $('base[href]').first().attr('href');
  let base = pageUrl;
  if (declaredBase !== undefined) {
    const resolved = normalizeUrl(declaredBase, pageUrl);
    if (resolved.ok) base = resolved.value;
  }

  const found = new Set<string>();

  $('a[href], area[href]').each((_index, element) => {
    const href = $(element).attr('href');
    if (href === undefined) return;
    const trimmed = href.trim();
    if (trimmed === '' || trimmed.startsWith('#') || SKIP_SCHEMES.test(trimmed)) return;

    const resolved = normalizeUrl(trimmed, base);
    if (resolved.ok) found.add(resolved.value);
  });

  return [...found];
};

/** `<meta name="robots" content="noindex, nofollow">` and its `googlebot` twin. */
export const readMetaRobots = (html: string): { readonly noindex: boolean; readonly nofollow: boolean } => {
  const $ = cheerio.load(html);
  let noindex = false;
  let nofollow = false;

  $('meta[name]').each((_index, element) => {
    const name = ($(element).attr('name') ?? '').toLowerCase();
    if (name !== 'robots' && name !== 'googlebot') return;
    const content = ($(element).attr('content') ?? '').toLowerCase();
    for (const token of content.split(',')) {
      const value = token.trim();
      if (value === 'noindex' || value === 'none') noindex = true;
      if (value === 'nofollow' || value === 'none') nofollow = true;
    }
  });

  return { noindex, nofollow };
};
