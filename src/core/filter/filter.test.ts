import { describe, expect, it } from 'vitest';
import { filterOptionsSchema } from '../config';
import type { AssetId, JobId } from '../ids';
import type { Asset, MediaKind } from '../media';
import { emptyHints } from '../media';
import { applyFilters, evaluateFilter, filterInputOf, type FilterInput } from './filter';

const input = (overrides: Partial<FilterInput> = {}): FilterInput => ({
  url: 'https://cdn.test/photo.jpg',
  kind: 'image',
  width: 1200,
  height: 800,
  bytes: 500_000,
  contentType: null,
  ...overrides,
});

const options = (overrides: Record<string, unknown> = {}) => filterOptionsSchema.parse(overrides);

const verdict = (given: Partial<FilterInput>, opts: Record<string, unknown> = {}): string => {
  const result = evaluateFilter(input(given), options(opts));
  return result.verdict === 'excluded' ? result.reason : result.verdict;
};

describe('media kind and extension', () => {
  it('includes an asset that passes every default', () => {
    expect(verdict({})).toBe('included');
  });

  it('excludes a kind the user turned off', () => {
    expect(verdict({ kind: 'video' }, { kinds: ['image'] })).toBe('media-kind');
    expect(verdict({ kind: 'gif' }, { kinds: ['image', 'video'] })).toBe('media-kind');
  });

  it('treats gif as its own kind, not a subset of image', () => {
    expect(verdict({ kind: 'gif' }, { kinds: ['gif'] })).toBe('included');
  });

  it('applies an extension allowlist when one is given', () => {
    expect(verdict({}, { extensions: ['png', 'webp'] })).toBe('extension');
    expect(verdict({}, { extensions: ['jpg'] })).toBe('included');
  });

  it('excludes an extensionless URL once an allowlist exists', () => {
    expect(verdict({ url: 'https://cdn.test/asset/9912' }, { extensions: ['jpg'] })).toBe('extension');
  });

  it('ignores extensions entirely when the list is empty', () => {
    expect(verdict({ url: 'https://cdn.test/asset/9912' })).toBe('included');
  });
});

describe('what the server said it was', () => {
  it('drops an asset the probe revealed to be a page', () => {
    // A lightbox link that turned out to point at a detail page, or a `.jpg`
    // URL that answers with an error page. Either way it is not a file.
    expect(verdict({ contentType: 'text/html' })).toBe('not-media');
    expect(verdict({ contentType: 'text/html; charset=utf-8' })).toBe('not-media');
    expect(verdict({ contentType: 'application/json' })).toBe('not-media');
  });

  it('overrides the kind the extractor guessed', () => {
    // The URL still looks like an image and the kind still says image; only the
    // response tells the truth, so this must not depend on either.
    expect(verdict({ url: 'https://cdn.test/photo.jpg', kind: 'image', contentType: 'text/html' })).toBe(
      'not-media',
    );
  });

  it('keeps an image its host mislabels', () => {
    // Excluding these would lose far more real files than it saves.
    expect(verdict({ contentType: 'application/octet-stream' })).toBe('included');
    expect(verdict({ contentType: 'text/plain' })).toBe('included');
    expect(verdict({ contentType: 'image/jpeg' })).toBe('included');
  });

  it('says nothing about an asset that was never probed', () => {
    expect(verdict({ contentType: null })).toBe('included');
  });
});

describe('dimension and size thresholds', () => {
  it('excludes anything under the minimum width or height', () => {
    expect(verdict({ width: 100 }, { minWidth: 500 })).toBe('min-width');
    expect(verdict({ height: 100 }, { minHeight: 500 })).toBe('min-height');
  });

  it('treats the threshold as inclusive', () => {
    expect(verdict({ width: 500, height: 500 }, { minWidth: 500, minHeight: 500 })).toBe('included');
  });

  it('excludes files under the minimum size', () => {
    expect(verdict({ bytes: 900 }, { minBytes: 1_000 })).toBe('min-bytes');
  });

  it('keeps unmeasurable assets by default rather than silently dropping them', () => {
    expect(verdict({ width: null, height: null }, { minWidth: 500 })).toBe('included');
    expect(verdict({ bytes: null }, { minBytes: 1_000 })).toBe('included');
  });

  it('drops unmeasurable assets when the user asks for strictness', () => {
    expect(verdict({ width: null, height: null }, { minWidth: 500, keepUnmeasured: false })).toBe(
      'unknown-dimensions',
    );
    expect(verdict({ bytes: null }, { minBytes: 1_000, keepUnmeasured: false })).toBe('unknown-size');
  });

  it('does not consult dimensions at all when no threshold is set', () => {
    expect(verdict({ width: null, height: null }, { keepUnmeasured: false })).toBe('included');
  });
});

describe('URL patterns', () => {
  it('requires a match when an include pattern is set', () => {
    expect(verdict({ url: 'https://cdn.test/thumbs/a.jpg' }, { urlInclude: '/full/' })).toBe(
      'url-include',
    );
    expect(verdict({ url: 'https://cdn.test/full/a.jpg' }, { urlInclude: '/full/' })).toBe('included');
  });

  it('rejects a match when an exclude pattern is set', () => {
    expect(verdict({ url: 'https://cdn.test/thumb_a.jpg' }, { urlExclude: 'thumb' })).toBe(
      'url-exclude',
    );
  });

  it('lets exclude override include', () => {
    const result = verdict(
      { url: 'https://cdn.test/full/thumb_a.jpg' },
      { urlInclude: '/full/', urlExclude: 'thumb' },
    );
    expect(result).toBe('url-exclude');
  });
});

describe('filterInputOf', () => {
  const asset = (overrides: Partial<Asset>): Asset => ({
    id: 'as_1' as AssetId,
    jobId: 'job_1' as JobId,
    url: 'https://cdn.test/a.jpg',
    normalizedUrl: 'https://cdn.test/a.jpg',
    kind: 'image' as MediaKind,
    acquisition: { strategy: 'direct', url: 'https://cdn.test/a.jpg' },
    hints: { ...emptyHints(), width: 300, height: 200 },
    sources: [{ pageUrl: 'https://test/', extractor: 'img-src', alt: null, discoveredAt: 0 }],
    probe: { status: 'unprobed' },
    filter: { verdict: 'unevaluated' },
    selected: false,
    download: { status: 'pending' },
    firstSeenAt: 0,
    updatedAt: 0,
    ...overrides,
  });

  it('falls back to DOM hints when nothing has been probed', () => {
    expect(filterInputOf(asset({}))).toMatchObject({ width: 300, height: 200, bytes: null });
  });

  it('prefers probed dimensions, since width attributes describe layout not pixels', () => {
    const probed = asset({
      probe: {
        status: 'probed',
        contentType: 'image/jpeg',
        contentLength: 90_000,
        width: 3000,
        height: 2000,
        acceptsRanges: true,
        etag: null,
        lastModified: null,
        probedAt: 0,
      },
    });
    expect(filterInputOf(probed)).toMatchObject({ width: 3000, height: 2000, bytes: 90_000 });
  });

  it('carries the probed content type through, and null when unprobed', () => {
    expect(filterInputOf(asset({})).contentType).toBeNull();

    const probed = asset({
      probe: {
        status: 'probed',
        contentType: 'text/html',
        contentLength: 4_000,
        width: null,
        height: null,
        acceptsRanges: false,
        etag: null,
        lastModified: null,
        probedAt: 0,
      },
    });
    expect(filterInputOf(probed).contentType).toBe('text/html');
  });

  it('reports a failed probe as unknown rather than guessing', () => {
    const failed = asset({ probe: { status: 'probe-failed', reason: 'HTTP 403', probedAt: 0 } });
    expect(filterInputOf(failed).contentType).toBeNull();
  });

  it('prefers the real byte count once a file is on disk', () => {
    const downloaded = asset({
      download: {
        status: 'complete',
        localPath: '/out/a.jpg',
        bytes: 12_345,
        sha256: 'a'.repeat(64),
        completedAt: 0,
      },
    });
    expect(filterInputOf(downloaded).bytes).toBe(12_345);
  });
});

describe('applyFilters', () => {
  it('tallies verdicts and groups exclusions by reason', () => {
    const base = {
      id: 'as_1' as AssetId,
      jobId: 'job_1' as JobId,
      normalizedUrl: 'https://cdn.test/a.jpg',
      acquisition: { strategy: 'direct' as const, url: 'https://cdn.test/a.jpg' },
      sources: [{ pageUrl: 'https://test/', extractor: 'img-src' as const, alt: null, discoveredAt: 0 }],
      probe: { status: 'unprobed' as const },
      filter: { verdict: 'unevaluated' as const },
      selected: false,
      download: { status: 'pending' as const },
      firstSeenAt: 0,
      updatedAt: 0,
    };

    const assets: Asset[] = [
      { ...base, id: 'as_1' as AssetId, url: 'https://cdn.test/big.jpg', kind: 'image', hints: { ...emptyHints(), width: 2000, height: 1500 } },
      { ...base, id: 'as_2' as AssetId, url: 'https://cdn.test/tiny.jpg', kind: 'image', hints: { ...emptyHints(), width: 40, height: 40 } },
      { ...base, id: 'as_3' as AssetId, url: 'https://cdn.test/icon.jpg', kind: 'image', hints: { ...emptyHints(), width: 30, height: 30 } },
      { ...base, id: 'as_4' as AssetId, url: 'https://cdn.test/clip.mp4', kind: 'video', hints: emptyHints() },
    ];

    const { tally, verdicts } = applyFilters(assets, options({ kinds: ['image'], minWidth: 500 }));

    expect(tally.eligible).toBe(1);
    expect(tally.filteredOut).toBe(3);
    expect(tally.byReason).toEqual({ 'min-width': 2, 'media-kind': 1 });
    expect(verdicts.get('as_1' as AssetId)).toEqual({ verdict: 'included' });
  });

  it('handles an empty set', () => {
    const { tally } = applyFilters([], options());
    expect(tally).toEqual({ eligible: 0, filteredOut: 0, byReason: {} });
  });
});
