import { describe, expect, it } from 'vitest';
import type { AssetId } from '../ids';
import { isDurable, type JobEvent } from './events';
import { canAccept, reduce, reduceAll, rehydrate } from './reducer';
import {
  type CrawlSummary,
  idleState,
  type JobState,
  type JobSummary,
} from './state';

const T0 = 1_700_000_000_000;

const crawlSummary = (overrides: Partial<CrawlSummary> = {}): CrawlSummary => ({
  pagesVisited: 12,
  pagesFailed: 1,
  pagesSkipped: 0,
  uniqueAssets: 40,
  bytesProjected: 5_000_000,
  durationMs: 8_000,
  truncatedBy: null,
  finishedAt: T0 + 8_000,
  ...overrides,
});

const jobSummary = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  outcome: 'finished',
  downloaded: 30,
  skippedDuplicate: 3,
  filteredOut: 7,
  failed: 0,
  bytesWritten: 4_000_000,
  durationMs: 20_000,
  manifestPath: '/out/manifest.json',
  finishedAt: T0 + 20_000,
  ...overrides,
});

/** Fails loudly instead of silently threading an error state into later steps. */
const run = (state: JobState, events: readonly JobEvent[]): JobState => {
  const result = reduceAll(state, events);
  if (!result.ok) throw new Error(`unexpected transition failure: ${JSON.stringify(result.error)}`);
  return result.value;
};

const toDownloading = (selected = 5): JobState =>
  run(idleState, [
    { type: 'crawl/started', at: T0 },
    { type: 'crawl/finished', at: T0 + 8_000, summary: crawlSummary() },
    { type: 'selection/submitted', at: T0 + 9_000, selected, bytesExpected: 4_000_000 },
  ]);

describe('happy path', () => {
  it('walks idle -> crawling -> awaiting-selection -> downloading -> complete', () => {
    const state = run(idleState, [
      { type: 'crawl/started', at: T0 },
      { type: 'crawl/page-visited', at: T0 + 100, url: 'https://a.test/', depth: 0, queueDepth: 4 },
      {
        type: 'crawl/assets-discovered',
        at: T0 + 150,
        found: 9,
        unique: 7,
        bytesProjectedDelta: 1_000,
      },
      { type: 'crawl/finished', at: T0 + 8_000, summary: crawlSummary() },
      { type: 'selection/submitted', at: T0 + 9_000, selected: 2, bytesExpected: 2_000 },
      { type: 'download/asset-started', at: T0 + 9_100, assetId: 'as_a' as AssetId },
      {
        type: 'download/asset-progress',
        at: T0 + 9_200,
        assetId: 'as_a' as AssetId,
        deltaBytes: 500,
        bytesDownloaded: 500,
        totalBytes: 1_000,
      },
      {
        type: 'download/asset-settled',
        at: T0 + 9_300,
        assetId: 'as_a' as AssetId,
        outcome: 'complete',
      },
      { type: 'download/finished', at: T0 + 20_000, summary: jobSummary() },
    ]);

    expect(state.status).toBe('complete');
    if (state.status !== 'complete') return;
    expect(state.summary.downloaded).toBe(30);
    expect(state.startedAt).toBe(T0);
  });

  it('accumulates crawl counters', () => {
    const state = run(idleState, [
      { type: 'crawl/started', at: T0 },
      { type: 'crawl/page-visited', at: T0 + 1, url: 'https://a.test/', depth: 0, queueDepth: 3 },
      { type: 'crawl/page-visited', at: T0 + 2, url: 'https://a.test/b', depth: 1, queueDepth: 5 },
      { type: 'crawl/page-failed', at: T0 + 3, url: 'https://a.test/c', reason: '500', queueDepth: 4 },
      { type: 'crawl/assets-discovered', at: T0 + 4, found: 10, unique: 8, bytesProjectedDelta: 900 },
      { type: 'crawl/assets-discovered', at: T0 + 5, found: 4, unique: 1, bytesProjectedDelta: 100 },
    ]);

    expect(state.status).toBe('crawling');
    if (state.status !== 'crawling') return;
    expect(state.crawl).toMatchObject({
      pagesVisited: 2,
      pagesFailed: 1,
      pagesQueued: 4,
      assetsDiscovered: 14,
      uniqueAssets: 9,
      bytesProjected: 1_000,
      currentUrl: 'https://a.test/b',
    });
  });

  it('tracks download tallies as assets settle', () => {
    const state = run(toDownloading(3), [
      { type: 'download/asset-started', at: T0, assetId: 'as_1' as AssetId },
      { type: 'download/asset-started', at: T0, assetId: 'as_2' as AssetId },
      { type: 'download/asset-settled', at: T0, assetId: 'as_1' as AssetId, outcome: 'complete' },
      {
        type: 'download/asset-settled',
        at: T0,
        assetId: 'as_2' as AssetId,
        outcome: 'skipped-duplicate',
      },
    ]);

    expect(state.status).toBe('downloading');
    if (state.status !== 'downloading') return;
    expect(state.download).toMatchObject({
      queued: 1,
      inFlight: 0,
      completed: 1,
      skippedDuplicate: 1,
      failed: 0,
    });
  });
});

describe('invalid transitions', () => {
  it('rejects downloading before discovery finishes', () => {
    const crawling = run(idleState, [{ type: 'crawl/started', at: T0 }]);
    const result = reduce(crawling, {
      type: 'selection/submitted',
      at: T0 + 1,
      selected: 1,
      bytesExpected: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      kind: 'invalid-transition',
      from: 'crawling',
      event: 'selection/submitted',
    });
  });

  it('rejects a second crawl/started', () => {
    const crawling = run(idleState, [{ type: 'crawl/started', at: T0 }]);
    expect(canAccept(crawling, { type: 'crawl/started', at: T0 + 1 })).toBe(false);
  });

  it('treats complete and failed as terminal', () => {
    const complete = run(toDownloading(1), [
      { type: 'download/finished', at: T0 + 10, summary: jobSummary() },
    ]);
    expect(canAccept(complete, { type: 'job/paused', at: T0 + 11 })).toBe(false);
    expect(
      canAccept(complete, {
        type: 'job/failed',
        at: T0 + 11,
        error: { kind: 'internal', message: 'x' },
      }),
    ).toBe(false);
  });

  it('flags selecting more than is eligible as an invariant violation', () => {
    const awaiting = run(idleState, [
      { type: 'crawl/started', at: T0 },
      { type: 'crawl/finished', at: T0 + 1, summary: crawlSummary({ uniqueAssets: 3 }) },
    ]);
    const result = reduce(awaiting, { type: 'selection/changed', at: T0 + 2, selected: 99 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invariant-violated');
  });
});

describe('filters', () => {
  it('re-filters without leaving awaiting-selection and clamps the selection', () => {
    const state = run(idleState, [
      { type: 'crawl/started', at: T0 },
      { type: 'crawl/finished', at: T0 + 1, summary: crawlSummary({ uniqueAssets: 40 }) },
      { type: 'selection/changed', at: T0 + 2, selected: 40 },
      { type: 'filters/applied', at: T0 + 3, eligible: 12, filteredOut: 28 },
    ]);

    expect(state.status).toBe('awaiting-selection');
    if (state.status !== 'awaiting-selection') return;
    expect(state).toMatchObject({ eligible: 12, filteredOut: 28, selected: 12 });
  });
});

describe('measurement progress', () => {
  const reviewing = () =>
    run(idleState, [
      { type: 'crawl/started', at: T0 },
      { type: 'crawl/finished', at: T0 + 1, summary: crawlSummary({ uniqueAssets: 40 }) },
    ]);

  it('changes nothing — it exists to tell the client the rows moved', () => {
    const before = reviewing();
    const after = run(before, [
      { type: 'probe/progress', at: T0 + 2, probed: 10, total: 40 },
      { type: 'probe/progress', at: T0 + 3, probed: 40, total: 40 },
    ]);

    expect(after).toEqual(before);
  });

  it('is not valid before the review phase', () => {
    const crawling = run(idleState, [{ type: 'crawl/started', at: T0 }]);
    const result = reduce(crawling, { type: 'probe/progress', at: T0 + 1, probed: 1, total: 9 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-transition');
  });

  it('is never written to the event log', () => {
    // One row per measured asset would swamp replay to say something the
    // client can only act on in bulk.
    expect(isDurable({ type: 'probe/progress', at: T0, probed: 1, total: 9 })).toBe(false);
    expect(isDurable({ type: 'filters/applied', at: T0, eligible: 1, filteredOut: 0 })).toBe(true);
  });
});

describe('pause and resume', () => {
  it('round-trips a user pause during crawling', () => {
    const crawling = run(idleState, [
      { type: 'crawl/started', at: T0 },
      { type: 'crawl/page-visited', at: T0 + 1, url: 'https://a.test/', depth: 0, queueDepth: 2 },
    ]);
    const paused = run(crawling, [{ type: 'job/paused', at: T0 + 2 }]);

    expect(paused.status).toBe('paused');
    if (paused.status !== 'paused') return;
    expect(paused.reason).toEqual({ kind: 'user' });
    expect(paused.suspended.from).toBe('crawling');

    const resumed = run(paused, [{ type: 'job/resumed', at: T0 + 3 }]);
    expect(resumed).toEqual(crawling);
  });

  it('preserves download progress across a pause', () => {
    const downloading = run(toDownloading(4), [
      { type: 'download/asset-started', at: T0, assetId: 'as_1' as AssetId },
      { type: 'download/asset-settled', at: T0, assetId: 'as_1' as AssetId, outcome: 'complete' },
    ]);
    const resumed = run(downloading, [
      { type: 'job/paused', at: T0 + 1 },
      { type: 'job/resumed', at: T0 + 2 },
    ]);
    expect(resumed).toEqual(downloading);
  });

  it('pauses on a budget breach and records which cap tripped', () => {
    const paused = run(toDownloading(), [
      {
        type: 'budget/breached',
        at: T0 + 5,
        breach: { cap: 'total-bytes', limit: 100, observed: 120 },
      },
    ]);

    expect(paused.status).toBe('paused');
    if (paused.status !== 'paused') return;
    expect(paused.reason).toEqual({
      kind: 'budget',
      breach: { cap: 'total-bytes', limit: 100, observed: 120 },
    });
  });
});

describe('cancellation', () => {
  it('lands in complete with a cancelled outcome and a synthesised crawl summary', () => {
    const crawling = run(idleState, [
      { type: 'crawl/started', at: T0 },
      { type: 'crawl/page-visited', at: T0 + 1, url: 'https://a.test/', depth: 0, queueDepth: 9 },
    ]);
    const state = run(crawling, [
      { type: 'job/cancelled', at: T0 + 2, summary: jobSummary({ outcome: 'cancelled' }) },
    ]);

    expect(state.status).toBe('complete');
    if (state.status !== 'complete') return;
    expect(state.summary.outcome).toBe('cancelled');
    expect(state.crawl.pagesVisited).toBe(1);
  });
});

describe('retry after completion', () => {
  it('reopens a completed job with a fresh download queue', () => {
    const complete = run(toDownloading(1), [
      { type: 'download/finished', at: T0 + 10, summary: jobSummary({ failed: 2 }) },
    ]);
    const retrying = run(complete, [
      {
        type: 'download/retry-requested',
        at: T0 + 11,
        assetIds: ['as_x' as AssetId, 'as_y' as AssetId],
        bytesExpected: 900,
      },
    ]);

    expect(retrying.status).toBe('downloading');
    if (retrying.status !== 'downloading') return;
    expect(retrying.download).toMatchObject({ queued: 2, completed: 0, failed: 0, bytesWritten: 0 });
  });
});

describe('rehydrate', () => {
  it('parks an interrupted crawl in paused', () => {
    const crawling = run(idleState, [
      { type: 'crawl/started', at: T0 },
      { type: 'crawl/page-visited', at: T0 + 1, url: 'https://a.test/x', depth: 0, queueDepth: 3 },
    ]);
    const state = rehydrate(crawling, T0 + 60_000);

    expect(state.status).toBe('paused');
    if (state.status !== 'paused') return;
    expect(state.reason.kind).toBe('interrupted');
    expect(state.suspended.from === 'crawling' && state.suspended.crawl.currentUrl).toBeNull();
  });

  it('returns in-flight downloads to the queue', () => {
    const downloading = run(toDownloading(5), [
      { type: 'download/asset-started', at: T0, assetId: 'as_1' as AssetId },
      { type: 'download/asset-started', at: T0, assetId: 'as_2' as AssetId },
    ]);
    const state = rehydrate(downloading, T0 + 60_000);

    expect(state.status).toBe('paused');
    if (state.status !== 'paused' || state.suspended.from !== 'downloading') return;
    expect(state.suspended.download).toMatchObject({ queued: 5, inFlight: 0 });
  });

  it('leaves settled states untouched', () => {
    const awaiting = run(idleState, [
      { type: 'crawl/started', at: T0 },
      { type: 'crawl/finished', at: T0 + 1, summary: crawlSummary() },
    ]);
    expect(rehydrate(awaiting, T0 + 2)).toBe(awaiting);
    expect(rehydrate(idleState, T0 + 2)).toBe(idleState);
  });
});

describe('replay', () => {
  it('rebuilds the same state from the event log', () => {
    const events: JobEvent[] = [
      { type: 'crawl/started', at: T0 },
      { type: 'crawl/assets-discovered', at: T0 + 1, found: 5, unique: 5, bytesProjectedDelta: 10 },
      { type: 'crawl/finished', at: T0 + 2, summary: crawlSummary() },
      { type: 'filters/applied', at: T0 + 3, eligible: 20, filteredOut: 20 },
    ];
    expect(run(idleState, events)).toEqual(run(idleState, events));
  });

  it('stops at the first event the state cannot accept', () => {
    const result = reduceAll(idleState, [
      { type: 'crawl/started', at: T0 },
      { type: 'job/resumed', at: T0 + 1 },
      { type: 'crawl/finished', at: T0 + 2, summary: crawlSummary() },
    ]);
    expect(result.ok).toBe(false);
  });
});
