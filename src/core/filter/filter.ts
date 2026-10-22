import type { FilterOptions } from '../config';
import type { AssetId } from '../ids';
import { type Asset, type FilterVerdict, knownBytes, knownDimensions, type MediaKind } from '../media';
import { extensionOf } from '../url';

export interface FilterInput {
  readonly url: string;
  readonly kind: MediaKind;
  readonly width: number | null;
  readonly height: number | null;
  readonly bytes: number | null;
  /** What the server said it was. Null means the probe never got an answer. */
  readonly contentType: string | null;
}

export const filterInputOf = (asset: Asset): FilterInput => {
  const { width, height } = knownDimensions(asset);
  return {
    url: asset.url,
    kind: asset.kind,
    width,
    height,
    bytes: knownBytes(asset),
    contentType: asset.probe.status === 'probed' ? asset.probe.contentType : null,
  };
};

/**
 * A tight denylist, never an allowlist. Plenty of CDNs serve real JPEGs as
 * `application/octet-stream`, and some as `text/plain`; excluding those would
 * cost more than the problem being solved. Only types that are unambiguously a
 * document belong here.
 */
const NON_MEDIA_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
  'application/json',
]);

export const isNonMediaContentType = (contentType: string): boolean =>
  NON_MEDIA_TYPES.has(contentType.split(';')[0]?.trim().toLowerCase() ?? '');

const included: FilterVerdict = { verdict: 'included' };
const excluded = (reason: Extract<FilterVerdict, { verdict: 'excluded' }>['reason']): FilterVerdict => ({
  verdict: 'excluded',
  reason,
});

/**
 * Pure and cheap by design: the selection grid re-filters client-side on every
 * keystroke, and re-running discovery to change a minimum width would be
 * absurd.
 */
export const evaluateFilter = (input: FilterInput, options: FilterOptions): FilterVerdict => {
  // The server gets the last word, and it is asked first: "not a file at all"
  // is a more useful answer than "you filtered out that kind". `classifyKind`
  // cannot stand in here — a text/html response to `/photo.jpg` still reads as
  // an image, because the extension wins whenever the MIME is not media.
  if (input.contentType !== null && isNonMediaContentType(input.contentType)) {
    return excluded('not-media');
  }

  if (!options.kinds.includes(input.kind)) return excluded('media-kind');

  if (options.extensions.length > 0) {
    const extension = extensionOf(input.url);
    if (extension === null || !options.extensions.includes(extension)) {
      return excluded('extension');
    }
  }

  if (options.urlInclude !== null && !safeTest(options.urlInclude, input.url)) {
    return excluded('url-include');
  }
  if (options.urlExclude !== null && safeTest(options.urlExclude, input.url)) {
    return excluded('url-exclude');
  }

  const wantsDimensions = options.minWidth > 0 || options.minHeight > 0;
  if (wantsDimensions && (input.width === null || input.height === null)) {
    // Unmeasurable assets are kept by default. Silently dropping the things we
    // could not measure is the failure mode people notice last.
    if (!options.keepUnmeasured) return excluded('unknown-dimensions');
  } else {
    if (input.width !== null && input.width < options.minWidth) return excluded('min-width');
    if (input.height !== null && input.height < options.minHeight) return excluded('min-height');
  }

  if (options.minBytes > 0) {
    if (input.bytes === null) {
      if (!options.keepUnmeasured) return excluded('unknown-size');
    } else if (input.bytes < options.minBytes) {
      return excluded('min-bytes');
    }
  }

  return included;
};

const cache = new Map<string, RegExp>();

/** Patterns are validated at parse time; this guards against a stale cache miss. */
const safeTest = (pattern: string, value: string): boolean => {
  let expression = cache.get(pattern);
  if (expression === undefined) {
    try {
      expression = new RegExp(pattern);
    } catch {
      return false;
    }
    cache.set(pattern, expression);
  }
  return expression.test(value);
};

export interface FilterTally {
  readonly eligible: number;
  readonly filteredOut: number;
  readonly byReason: Readonly<Record<string, number>>;
}

export interface FilterOutcome {
  readonly tally: FilterTally;
  readonly verdicts: ReadonlyMap<AssetId, FilterVerdict>;
}

export const applyFilters = (
  assets: readonly Asset[],
  options: FilterOptions,
): FilterOutcome => {
  const verdicts = new Map<AssetId, FilterVerdict>();
  const byReason: Record<string, number> = {};
  let eligible = 0;
  let filteredOut = 0;

  for (const asset of assets) {
    const verdict = evaluateFilter(filterInputOf(asset), options);
    verdicts.set(asset.id, verdict);

    if (verdict.verdict === 'included') {
      eligible += 1;
    } else if (verdict.verdict === 'excluded') {
      filteredOut += 1;
      byReason[verdict.reason] = (byReason[verdict.reason] ?? 0) + 1;
    }
  }

  return { tally: { eligible, filteredOut, byReason }, verdicts };
};
