import * as cheerio from 'cheerio';
import type { MediaCandidate, MediaHints, MediaKind } from '../media';
import { emptyHints } from '../media';
import { normalizeUrl } from '../url';

/** One entry from the renderer's network log. */
export interface NetworkRecord {
  readonly url: string;
  /** Playwright's resource type: `image`, `media`, `xhr`, `fetch`, ... */
  readonly resourceType: string;
  readonly contentType: string | null;
  readonly contentLength: number | null;
  readonly status: number;
}

/** A `background-image` value read off a rendered element. */
export interface ComputedBackground {
  readonly value: string;
  /** A short description of the element, kept as provenance for the UI. */
  readonly selector: string;
}

export interface PageContextInput {
  readonly pageUrl: string;
  readonly html: string;
  readonly networkLog?: readonly NetworkRecord[];
  readonly computedBackgrounds?: readonly ComputedBackground[];
  /** Text of stylesheets fetched for this page, in no particular order. */
  readonly stylesheets?: readonly string[];
}

/**
 * Everything an extractor is allowed to look at. Built once per page so the
 * HTML is parsed once rather than by each of nine extractors.
 */
export interface PageContext {
  readonly pageUrl: string;
  /** `<base href>` if present, otherwise the page URL. All resolution uses this. */
  readonly baseUrl: string;
  readonly html: string;
  readonly $: cheerio.CheerioAPI;
  readonly networkLog: readonly NetworkRecord[];
  readonly computedBackgrounds: readonly ComputedBackground[];
  readonly stylesheets: readonly string[];
}

export const buildPageContext = (input: PageContextInput): PageContext => {
  const $ = cheerio.load(input.html);

  const declaredBase = $('base[href]').first().attr('href');
  let baseUrl = input.pageUrl;
  if (declaredBase !== undefined) {
    const resolved = normalizeUrl(declaredBase, input.pageUrl);
    if (resolved.ok) baseUrl = resolved.value;
  }

  return {
    pageUrl: input.pageUrl,
    baseUrl,
    html: input.html,
    $,
    networkLog: input.networkLog ?? [],
    computedBackgrounds: input.computedBackgrounds ?? [],
    stylesheets: input.stylesheets ?? [],
  };
};

/** An extractor is a pure function over a context. No network, no browser. */
export type Extractor = (context: PageContext) => MediaCandidate[];

export const resolveAgainst = (context: PageContext, raw: string): string | null => {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  const resolved = normalizeUrl(trimmed, context.baseUrl);
  return resolved.ok ? resolved.value : null;
};

const positiveInt = (raw: string | null | undefined): number | null => {
  if (raw === undefined || raw === null) return null;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
};

export const hintsFrom = (attributes: {
  readonly alt?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly width?: string | null | undefined;
  readonly height?: string | null | undefined;
  readonly type?: string | null | undefined;
  readonly descriptor?: string | null | undefined;
}): MediaHints => ({
  ...emptyHints(),
  alt: attributes.alt ?? null,
  title: attributes.title ?? null,
  width: positiveInt(attributes.width),
  height: positiveInt(attributes.height),
  declaredMimeType: attributes.type ?? null,
  srcsetDescriptor: attributes.descriptor ?? null,
});

export const directCandidate = (
  url: string,
  kind: MediaKind,
  foundBy: MediaCandidate['foundBy'],
  foundOn: string,
  hints: MediaHints = emptyHints(),
): MediaCandidate => ({
  url,
  kind,
  acquisition: { strategy: 'direct', url },
  hints,
  foundBy,
  foundOn,
});
