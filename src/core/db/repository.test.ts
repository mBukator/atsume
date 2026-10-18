import { beforeEach, describe, expect, it } from 'vitest';
import { jobConfigSchema } from '../config';
import type { JobId } from '../ids';
import { emptyHints, type MediaCandidate } from '../media';
import { reduceAll } from '../job/reducer';
import { idleState, type CrawlSummary } from '../job/state';
import { type Db, openDatabase } from './open';
import { JobRepository, mergeHints } from './repository';

const T0 = 1_700_000_000_000;

const config = jobConfigSchema.parse({
  seedUrl: 'https://example.test/gallery',
  output: { directory: '/tmp/atsume-test' },
});

const candidate = (overrides: Partial<MediaCandidate> = {}): MediaCandidate => ({
  url: 'https://cdn.example.test/a.jpg',
  kind: 'image',
  acquisition: { strategy: 'direct', url: 'https://cdn.example.test/a.jpg' },
  hints: emptyHints(),
  foundBy: 'img-src',
  foundOn: 'https://example.test/gallery',
  ...overrides,
});

const crawlSummary: CrawlSummary = {
  pagesVisited: 3,
  pagesFailed: 0,
  pagesSkipped: 0,
  uniqueAssets: 2,
  bytesProjected: 100,
  durationMs: 500,
  truncatedBy: null,
  finishedAt: T0 + 500,
};

let db: Db;
let repo: JobRepository;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = new JobRepository(db);
});

describe('migration', () => {
  it('is idempotent', () => {
    const before = db.pragma('user_version') as Array<{ user_version: number }>;
    openDatabase(':memory:');
    const after = db.pragma('user_version') as Array<{ user_version: number }>;
    expect(after).toEqual(before);
    expect(before[0]?.user_version).toBeGreaterThan(0);
  });

  it('enables foreign keys so deleting a job cascades', () => {
    const job = repo.createJob(config, T0);
    repo.upsertCandidates(job.id, [candidate()], T0);
    db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);

    const remaining = db.prepare('SELECT COUNT(*) AS n FROM assets').get() as { n: number };
    const sources = db.prepare('SELECT COUNT(*) AS n FROM asset_sources').get() as { n: number };
    expect(remaining.n).toBe(0);
    expect(sources.n).toBe(0);
  });
});

describe('job lifecycle', () => {
  it('round-trips config and state', () => {
    const created = repo.createJob(config, T0);
    const loaded = repo.getJob(created.id);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.config).toEqual(config);
    expect(loaded.value.state).toEqual(idleState);
    expect(loaded.value.seedUrl).toBe('https://example.test/gallery');
  });

  it('reports a missing job as a value, not a throw', () => {
    const result = repo.getJob('job_nope' as JobId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
  });

  it('survives a simulated restart mid-crawl by parking the job in paused', () => {
    const job = repo.createJob(config, T0);
    const crawling = reduceAll(idleState, [
      { type: 'crawl/started', at: T0 },
      { type: 'crawl/page-visited', at: T0 + 1, url: 'https://example.test/', depth: 0, queueDepth: 4 },
    ]);
    if (!crawling.ok) throw new Error('setup failed');
    repo.saveState(job.id, crawling.value, T0 + 2);

    // A fresh process reading the same database.
    const restarted = new JobRepository(db);
    const touched = restarted.rehydrateInterrupted(T0 + 60_000);
    expect(touched).toEqual([job.id]);

    const loaded = restarted.getJob(job.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.state.status).toBe('paused');
    if (loaded.value.state.status !== 'paused') return;
    expect(loaded.value.state.reason.kind).toBe('interrupted');
  });

  it('surfaces a corrupt state column instead of returning a broken object', () => {
    const job = repo.createJob(config, T0);
    db.prepare('UPDATE jobs SET state_json = ? WHERE id = ?').run('{"status":"teleporting"}', job.id);

    const loaded = repo.getJob(job.id);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.kind).toBe('corrupt-row');
  });

  it('accumulates the budget ledger', () => {
    const job = repo.createJob(config, T0);
    repo.creditLedger(job.id, { pages: 1 }, T0 + 1);
    repo.creditLedger(job.id, { files: 2, bytes: 4_096 }, T0 + 2);

    const ledger = repo.creditLedger(job.id, { pages: 1 }, T0 + 3);
    expect(ledger.ok).toBe(true);
    if (!ledger.ok) return;
    expect(ledger.value).toMatchObject({ pagesCrawled: 2, filesWritten: 2, bytesWritten: 4_096 });
  });
});

describe('event log', () => {
  it('persists durable events and drops the high-frequency ones', () => {
    const job = repo.createJob(config, T0);
    repo.appendEvent(job.id, { type: 'crawl/started', at: T0 });
    repo.appendEvent(job.id, {
      type: 'crawl/page-visited',
      at: T0 + 1,
      url: 'https://example.test/',
      depth: 0,
      queueDepth: 1,
    });
    repo.appendEvent(job.id, { type: 'crawl/finished', at: T0 + 2, summary: crawlSummary });

    const events = repo.eventsSince(job.id, 0);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value.map((stored) => stored.event.type)).toEqual([
      'crawl/started',
      'crawl/finished',
    ]);
  });

  it('replays from a sequence number so a reconnecting client catches up', () => {
    const job = repo.createJob(config, T0);
    repo.appendEvent(job.id, { type: 'crawl/started', at: T0 });
    const second = repo.appendEvent(job.id, {
      type: 'crawl/finished',
      at: T0 + 1,
      summary: crawlSummary,
    });
    if (!second.ok || second.value === null) throw new Error('setup failed');

    const after = repo.eventsSince(job.id, second.value);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value).toEqual([]);
  });

  it('rebuilds job state by replaying the log', () => {
    const job = repo.createJob(config, T0);
    repo.appendEvent(job.id, { type: 'crawl/started', at: T0 });
    repo.appendEvent(job.id, { type: 'crawl/finished', at: T0 + 1, summary: crawlSummary });

    const stored = repo.eventsSince(job.id, 0);
    if (!stored.ok) throw new Error('setup failed');
    const rebuilt = reduceAll(
      idleState,
      stored.value.map((entry) => entry.event),
    );

    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.value.status).toBe('awaiting-selection');
  });
});

describe('candidate upsert', () => {
  it('assigns a stable id and stores provenance', () => {
    const job = repo.createJob(config, T0);
    const result = repo.upsertCandidates(job.id, [candidate()], T0);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [outcome] = result.value;
    expect(outcome?.isNew).toBe(true);

    const assets = repo.listAssets(job.id);
    if (!assets.ok) throw new Error('listAssets failed');
    expect(assets.value).toHaveLength(1);
    expect(assets.value[0]?.sources).toEqual([
      {
        pageUrl: 'https://example.test/gallery',
        extractor: 'img-src',
        alt: null,
        discoveredAt: T0,
      },
    ]);
  });

  it('dedupes URLs that normalize to the same resource', () => {
    const job = repo.createJob(config, T0);
    repo.upsertCandidates(job.id, [candidate({ url: 'https://cdn.example.test/a.jpg?b=2&a=1' })], T0);
    const second = repo.upsertCandidates(
      job.id,
      [candidate({ url: 'https://cdn.example.test/a.jpg?a=1&b=2#frag' })],
      T0 + 1,
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value[0]?.isNew).toBe(false);
    expect(repo.countAssets(job.id).total).toBe(1);
  });

  it('accumulates provenance when the same asset appears on another page', () => {
    const job = repo.createJob(config, T0);
    repo.upsertCandidates(job.id, [candidate()], T0);
    repo.upsertCandidates(
      job.id,
      [candidate({ foundOn: 'https://example.test/about', foundBy: 'open-graph' })],
      T0 + 1,
    );

    const assets = repo.listAssets(job.id);
    if (!assets.ok) throw new Error('listAssets failed');
    expect(assets.value).toHaveLength(1);
    expect(assets.value[0]?.sources).toHaveLength(2);
  });

  it('does not duplicate provenance for a repeat sighting by the same extractor', () => {
    const job = repo.createJob(config, T0);
    repo.upsertCandidates(job.id, [candidate()], T0);
    repo.upsertCandidates(job.id, [candidate()], T0 + 1);

    const assets = repo.listAssets(job.id);
    if (!assets.ok) throw new Error('listAssets failed');
    expect(assets.value[0]?.sources).toHaveLength(1);
  });

  it('improves hints when a later sighting knows more', () => {
    const job = repo.createJob(config, T0);
    repo.upsertCandidates(job.id, [candidate()], T0);
    repo.upsertCandidates(
      job.id,
      [
        candidate({
          foundBy: 'img-srcset',
          hints: { ...emptyHints(), alt: 'A cat', width: 1_600, height: 900 },
        }),
      ],
      T0 + 1,
    );

    const assets = repo.listAssets(job.id);
    if (!assets.ok) throw new Error('listAssets failed');
    expect(assets.value[0]?.hints).toMatchObject({ alt: 'A cat', width: 1_600, height: 900 });
  });

  it('keeps a job scoped to its own assets', () => {
    const first = repo.createJob(config, T0);
    const second = repo.createJob(config, T0);
    repo.upsertCandidates(first.id, [candidate()], T0);

    expect(repo.countAssets(first.id).total).toBe(1);
    expect(repo.countAssets(second.id).total).toBe(0);
  });
});

describe('filtering and selection', () => {
  it('filters by verdict and selects only what is included', () => {
    const job = repo.createJob(config, T0);
    const result = repo.upsertCandidates(
      job.id,
      [candidate(), candidate({ url: 'https://cdn.example.test/b.png' })],
      T0,
    );
    if (!result.ok) throw new Error('setup failed');
    const [first, second] = result.value;
    if (first === undefined || second === undefined) throw new Error('setup failed');

    repo.setFilterVerdict(first.assetId, { verdict: 'included' }, T0);
    repo.setFilterVerdict(second.assetId, { verdict: 'excluded', reason: 'min-width' }, T0);
    repo.setSelectionForIncluded(job.id, true, T0);

    const counts = repo.countAssets(job.id);
    expect(counts).toEqual({ total: 2, included: 1, selected: 1 });

    const selected = repo.listAssets(job.id, { selected: true });
    if (!selected.ok) throw new Error('listAssets failed');
    expect(selected.value.map((asset) => asset.id)).toEqual([first.assetId]);
  });
});

describe('download state', () => {
  it('records a completed download and finds it again by content hash', () => {
    const job = repo.createJob(config, T0);
    const result = repo.upsertCandidates(job.id, [candidate()], T0);
    if (!result.ok) throw new Error('setup failed');
    const assetId = result.value[0]?.assetId;
    if (assetId === undefined) throw new Error('setup failed');

    const sha = 'a'.repeat(64);
    repo.setDownloadState(
      assetId,
      { status: 'complete', localPath: '/tmp/out/a.jpg', bytes: 2_048, sha256: sha, completedAt: T0 },
      T0,
    );

    expect(repo.findByHash(job.id, sha)).toEqual({ id: assetId, localPath: '/tmp/out/a.jpg' });
    expect(repo.findByHash(job.id, 'b'.repeat(64))).toBeNull();

    const asset = repo.getAsset(assetId);
    if (!asset.ok) throw new Error('getAsset failed');
    expect(asset.value.download.status).toBe('complete');
  });

  it('keeps the probed size when a later state has none', () => {
    const job = repo.createJob(config, T0);
    const result = repo.upsertCandidates(job.id, [candidate()], T0);
    if (!result.ok) throw new Error('setup failed');
    const assetId = result.value[0]?.assetId;
    if (assetId === undefined) throw new Error('setup failed');

    repo.setProbe(
      assetId,
      {
        status: 'probed',
        contentType: 'image/jpeg',
        contentLength: 4_096,
        width: 800,
        height: 600,
        acceptsRanges: true,
        etag: null,
        lastModified: null,
        probedAt: T0,
      },
      T0,
    );
    repo.setDownloadState(
      assetId,
      { status: 'failed', error: { kind: 'network', message: 'reset' }, attempts: 3, failedAt: T0 },
      T0 + 1,
    );

    const row = db.prepare('SELECT bytes FROM assets WHERE id = ?').get(assetId) as { bytes: number };
    expect(row.bytes).toBe(4_096);
  });
});

describe('mergeHints', () => {
  it('never erases what was already known', () => {
    const known = { ...emptyHints(), alt: 'first', width: 900 };
    const merged = mergeHints(known, { ...emptyHints(), alt: 'second', width: 400, height: 300 });
    expect(merged).toMatchObject({ alt: 'first', width: 900, height: 300 });
  });
});
