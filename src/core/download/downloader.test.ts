import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type JobConfig, jobConfigSchema } from '../config';
import { openDatabase } from '../db/open';
import { JobRepository } from '../db/repository';
import type { AssetId } from '../ids';
import { emptyLedger } from '../job/budget';
import type { JobEvent } from '../job/events';
import { emptyHints, type MediaCandidate } from '../media';
import {
  FakeHttpClient,
  type FakeProcessSpec,
  type FakeResponseSpec,
  FakeSubprocessRunner,
  ManualClock,
  MemoryFileStore,
} from '../testing';
import { FILEPATH_PREFIX } from '../media-tool/ytdlp-args';
import { resetAvailabilityCache } from '../media-tool/ytdlp';
import { runDownloads } from './downloader';

const T0 = 1_700_000_000_000;
const PAGE = 'https://example.test/gallery/';
const OUT = '/downloads';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const candidate = (url: string, overrides: Partial<MediaCandidate> = {}): MediaCandidate => ({
  url,
  kind: 'image',
  acquisition: { strategy: 'direct', url },
  hints: emptyHints(),
  foundBy: 'img-src',
  foundOn: PAGE,
  ...overrides,
});

interface Harness {
  readonly run: (
    overrides?: Record<string, unknown>,
    subprocess?: FakeSubprocessRunner | null,
  ) => ReturnType<typeof runDownloads>;
  readonly files: MemoryFileStore;
  readonly http: FakeHttpClient;
  readonly clock: ManualClock;
  readonly repo: JobRepository;
  readonly events: JobEvent[];
  readonly ids: AssetId[];
  readonly abort: () => void;
}

const harness = (
  candidates: readonly MediaCandidate[],
  routes: Readonly<Record<string, FakeResponseSpec>>,
  configOverrides: Record<string, unknown> = {},
): Harness => {
  const db = openDatabase(':memory:');
  const repo = new JobRepository(db);
  const config: JobConfig = jobConfigSchema.parse({
    seedUrl: PAGE,
    output: { directory: OUT },
    ...configOverrides,
  });
  const job = repo.createJob(config, T0);

  const upserted = repo.upsertCandidates(job.id, candidates, T0);
  if (!upserted.ok) throw new Error('seeding failed');
  const ids = upserted.value.map((outcome) => outcome.assetId);
  repo.setSelection(job.id, ids, true, T0);

  const clock = new ManualClock(T0);
  const http = new FakeHttpClient(routes, clock);
  const files = new MemoryFileStore();
  const events: JobEvent[] = [];
  const controller = new AbortController();

  return {
    repo,
    files,
    http,
    clock,
    events,
    ids,
    abort: () => controller.abort(),
    run: (overrides = {}, subprocess = null) =>
      runDownloads(
        {
          http,
          clock,
          files,
          repo,
          emit: (event) => events.push(event),
          // Deterministic jitter keeps the backoff assertions exact.
          random: () => 0.5,
          subprocess,
        },
        {
          jobId: job.id,
          config: jobConfigSchema.parse({
            seedUrl: PAGE,
            output: { directory: OUT },
            ...configOverrides,
            ...overrides,
          }),
          ledger: emptyLedger(T0),
          signal: controller.signal,
        },
      ),
  };
};

describe('a successful download', () => {
  const body = 'the actual image bytes';
  const url = 'https://cdn.example.test/img/sunset.jpg';

  it('writes to the templated path and records size and hash', async () => {
    const h = harness([candidate(url)], {
      [url]: { status: 200, body, contentType: 'image/jpeg' },
    });

    const result = await h.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.stopped).toBe('finished');
    expect(result.value.summary.downloaded).toBe(1);

    const expectedPath = `${OUT}/cdn.example.test/gallery/image/sunset-${sha(body).slice(0, 8)}.jpg`;
    expect(h.files.paths()).toEqual([expectedPath]);
    expect(h.files.textAt(expectedPath)).toBe(body);

    const asset = h.repo.getAsset(h.ids[0] as AssetId);
    if (!asset.ok) throw new Error('asset missing');
    expect(asset.value.download).toMatchObject({
      status: 'complete',
      bytes: body.length,
      sha256: sha(body),
      localPath: expectedPath,
    });
  });

  it('leaves no .part file behind', async () => {
    const h = harness([candidate(url)], { [url]: { body, contentType: 'image/jpeg' } });
    await h.run();
    expect(h.files.paths().some((path) => path.endsWith('.part'))).toBe(false);
  });

  it('emits started, progress and settled for the asset', async () => {
    const big = 'x'.repeat(700 * 1024);
    const h = harness([candidate(url)], {
      [url]: { body: big, contentType: 'image/jpeg', chunkSize: 128 * 1024 },
    });
    await h.run();

    const types = h.events.map((event) => event.type);
    expect(types).toContain('download/asset-started');
    expect(types).toContain('download/asset-progress');
    expect(types.at(-1)).toBe('download/asset-settled');

    const progressed = h.events.filter((event) => event.type === 'download/asset-progress');
    const total = progressed.reduce(
      (sum, event) => sum + (event.type === 'download/asset-progress' ? event.deltaBytes : 0),
      0,
    );
    expect(total).toBe(big.length);
  });

  it('credits the job ledger with the bytes written', async () => {
    const h = harness([candidate(url)], { [url]: { body, contentType: 'image/jpeg' } });
    const result = await h.run();
    expect(result.ok && result.value.ledger.bytesWritten).toBe(body.length);
    expect(result.ok && result.value.ledger.filesWritten).toBe(1);
  });
});

describe('duplicate content', () => {
  it('records the second copy as a duplicate instead of writing it twice', async () => {
    const body = 'identical bytes under two URLs';
    const first = 'https://cdn.example.test/a/photo.jpg';
    const second = 'https://cdn.example.test/b/photo.jpg';

    const h = harness([candidate(first), candidate(second)], {
      [first]: { body, contentType: 'image/jpeg' },
      [second]: { body, contentType: 'image/jpeg' },
    }, { download: { globalConcurrency: 1, perHostConcurrency: 1 } });

    const result = await h.run({ download: { globalConcurrency: 1, perHostConcurrency: 1 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.summary.downloaded).toBe(1);
    expect(result.value.summary.skippedDuplicate).toBe(1);
    expect(h.files.paths()).toHaveLength(1);

    const assets = h.repo.listAssets(
      h.repo.listJobs()[0]?.id ?? ('' as never),
    );
    if (!assets.ok) throw new Error('listAssets failed');
    const duplicate = assets.value.find((asset) => asset.download.status === 'skipped-duplicate');
    expect(duplicate?.download).toMatchObject({ status: 'skipped-duplicate', sha256: sha(body) });
  });
});

describe('resume', () => {
  const url = 'https://cdn.example.test/big.jpg';
  const body = 'a'.repeat(400) + 'b'.repeat(400);

  it('continues a truncated transfer with a Range request and still hashes correctly', async () => {
    const h = harness([candidate(url)], {
      [url]: { body, contentType: 'image/jpeg', chunkSize: 100, truncateAfter: 300 },
    });

    const result = await h.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary.downloaded).toBe(1);

    const written = h.files.paths()[0];
    expect(written).toBeDefined();
    expect(h.files.textAt(written as string)).toBe(body);

    const asset = h.repo.getAsset(h.ids[0] as AssetId);
    expect(asset.ok && asset.value.download.status === 'complete' && asset.value.download.sha256).toBe(
      sha(body),
    );
  });

  it('starts over when the server ignores the Range header', async () => {
    const h = harness([candidate(url)], {
      [url]: { body, contentType: 'image/jpeg', chunkSize: 100, truncateAfter: 300, ignoreRange: true },
    });

    const result = await h.run();
    expect(result.ok && result.value.summary.downloaded).toBe(1);

    const written = h.files.paths()[0];
    // The danger here is appending a full body onto a partial one.
    expect(h.files.textAt(written as string)).toBe(body);
  });

  it('discards a stale partial when the server answers 416', async () => {
    const h = harness([candidate(url)], { [url]: { body: '', contentType: 'image/jpeg' } });
    await h.files.openWrite(`${OUT}/stale.part`, 'create');

    const result = await h.run();
    expect(result.ok).toBe(true);
  });
});

describe('retries', () => {
  const url = 'https://cdn.example.test/flaky.jpg';

  it('retries a 503 and succeeds on the next attempt', async () => {
    const h = harness([candidate(url)], {
      [url]: { body: 'recovered', contentType: 'image/jpeg', statusSequence: [503, 200] },
    });

    const result = await h.run();
    expect(result.ok && result.value.summary.downloaded).toBe(1);
    expect(h.clock.sleeps.length).toBeGreaterThan(0);
  });

  it('waits as long as Retry-After asks', async () => {
    const h = harness([candidate(url)], {
      [url]: {
        body: 'recovered',
        contentType: 'image/jpeg',
        statusSequence: [429, 200],
        headers: { 'retry-after': '7' },
      },
    });

    await h.run();
    expect(h.clock.sleeps).toContain(7_000);
  });

  it('gives up after the attempt budget and records the failure', async () => {
    const h = harness(
      [candidate(url)],
      { [url]: { status: 500, body: '', contentType: 'image/jpeg' } },
      { download: { maxAttempts: 2 } },
    );

    const result = await h.run({ download: { maxAttempts: 2 } });
    expect(result.ok && result.value.summary.failed).toBe(1);

    const asset = h.repo.getAsset(h.ids[0] as AssetId);
    if (!asset.ok) throw new Error('asset missing');
    expect(asset.value.download).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('does not retry a 404', async () => {
    const h = harness([candidate(url)], { [url]: { status: 404, body: '' } });

    const result = await h.run();
    expect(result.ok && result.value.summary.failed).toBe(1);
    expect(h.clock.sleeps).toEqual([]);
    expect(h.http.countFor(url)).toBe(1);
  });

  it('reports a filesystem failure without retrying forever', async () => {
    const h = harness([candidate(url)], { [url]: { body: 'data', contentType: 'image/jpeg' } });
    h.files.failAllWrites = true;

    const result = await h.run();
    expect(result.ok && result.value.summary.failed).toBe(1);

    const asset = h.repo.getAsset(h.ids[0] as AssetId);
    expect(asset.ok && asset.value.download.status).toBe('failed');
  });
});

describe('budget and cancellation', () => {
  const serial = { download: { globalConcurrency: 1, perHostConcurrency: 1 } };

  it('declines to start a download that a probe says will not fit', async () => {
    const urls = ['https://cdn.example.test/1.jpg', 'https://cdn.example.test/2.jpg'];
    const body = 'x'.repeat(600);

    const h = harness(
      urls.map((url) => candidate(url)),
      Object.fromEntries(urls.map((url) => [url, { body, contentType: 'image/jpeg' }])),
      { caps: { maxTotalBytes: 1_000 }, ...serial },
    );

    // The pre-flight check is only as good as the probe: without a known size
    // it cannot predict anything, so the sizes are recorded first.
    for (const id of h.ids) {
      h.repo.setProbe(
        id,
        {
          status: 'probed',
          contentType: 'image/jpeg',
          contentLength: 600,
          width: null,
          height: null,
          acceptsRanges: true,
          etag: null,
          lastModified: null,
          probedAt: T0,
        },
        T0,
      );
    }

    const result = await h.run({ caps: { maxTotalBytes: 1_000 }, ...serial });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopped).toBe('budget');
    expect(result.value.breach?.cap).toBe('total-bytes');
    expect(result.value.summary.downloaded).toBe(1);
    // Asset ids are content-derived, so the queue order is stable across runs
    // but is not insertion order; the point is that only one was ever fetched.
    const fetched = urls.reduce((total, url) => total + h.http.countFor(url), 0);
    expect(fetched).toBe(1);
  });

  it('still stops after the fact when nothing was probed', async () => {
    const urls = ['https://cdn.example.test/3.jpg', 'https://cdn.example.test/4.jpg'];

    const h = harness(
      urls.map((url) => candidate(url)),
      // Distinct bodies: identical ones would be deduped and never cost bytes.
      Object.fromEntries(
        urls.map((url, index) => [
          url,
          { body: String(index).repeat(600), contentType: 'image/jpeg' },
        ]),
      ),
      { caps: { maxTotalBytes: 1_000 }, ...serial },
    );

    const result = await h.run({ caps: { maxTotalBytes: 1_000 }, ...serial });
    expect(result.ok && result.value.stopped).toBe('budget');
    expect(result.ok && result.value.ledger.bytesWritten).toBeGreaterThan(1_000);
  });

  it('stops at the file-count cap', async () => {
    const urls = ['https://cdn.example.test/a.jpg', 'https://cdn.example.test/b.jpg'];
    const h = harness(
      urls.map((url) => candidate(url)),
      Object.fromEntries(urls.map((url) => [url, { body: 'small', contentType: 'image/jpeg' }])),
      { caps: { maxFileCount: 1 }, ...serial },
    );

    const result = await h.run({ caps: { maxFileCount: 1 }, ...serial });
    expect(result.ok && result.value.breach?.cap).toBe('file-count');
  });
});

describe('acquisition strategies', () => {
  const hls = 'https://cdn.example.test/live.m3u8';
  const hlsCandidate = candidate(hls, {
    kind: 'video',
    acquisition: { strategy: 'hls', manifestUrl: hls },
    foundBy: 'hls-manifest',
  });

  it('hands a stream to yt-dlp instead of fetching the manifest as a file', async () => {
    resetAvailabilityCache();
    const produced = `${OUT}/cdn.example.test/gallery/video/live.mp4`;
    const h = harness([hlsCandidate], { [hls]: { body: '#EXTM3U' } });

    const runner = new FakeSubprocessRunner(
      (_command, args): FakeProcessSpec =>
        args[0] === '--version'
          ? { exitCode: 0, stdout: ['2026.01.01'] }
          : {
              exitCode: 0,
              stdout: [`${FILEPATH_PREFIX}|${produced}`],
              writes: [{ path: produced, body: 'remuxed stream' }],
            },
      h.files,
    );

    const result = await h.run({}, runner);
    expect(result.ok && result.value.summary.downloaded).toBe(1);

    // The manifest itself is never fetched over HTTP by us.
    expect(h.http.countFor(hls)).toBe(0);

    const invoked = runner.invocations.find((call) => call.args[0] !== '--version');
    expect(invoked?.args.at(-1)).toBe(hls);

    const asset = h.repo.getAsset(h.ids[0] as AssetId);
    expect(asset.ok && asset.value.download.status).toBe('complete');
  });

  it('records a clear failure when no subprocess runner is available', async () => {
    resetAvailabilityCache();
    const h = harness([hlsCandidate], { [hls]: { body: '#EXTM3U' } });

    const result = await h.run();
    expect(result.ok && result.value.summary.failed).toBe(1);

    const asset = h.repo.getAsset(h.ids[0] as AssetId);
    if (!asset.ok || asset.value.download.status !== 'failed') throw new Error('expected a failure');
    expect(asset.value.download.error.kind).toBe('subprocess');
  });
});

describe('selection', () => {
  it('skips assets that were never selected', async () => {
    const wanted = 'https://cdn.example.test/wanted.jpg';
    const ignored = 'https://cdn.example.test/ignored.jpg';

    const h = harness([candidate(wanted), candidate(ignored)], {
      [wanted]: { body: 'yes', contentType: 'image/jpeg' },
      [ignored]: { body: 'no', contentType: 'image/jpeg' },
    });

    const jobId = h.repo.listJobs()[0]?.id;
    if (jobId === undefined) throw new Error('no job');
    h.repo.setSelection(jobId, [h.ids[1] as AssetId], false, T0);

    const result = await h.run();
    expect(result.ok && result.value.summary.downloaded).toBe(1);
    expect(h.http.countFor(ignored)).toBe(0);
  });

  it('does not re-download something already complete', async () => {
    const url = 'https://cdn.example.test/done.jpg';
    const h = harness([candidate(url)], { [url]: { body: 'data', contentType: 'image/jpeg' } });

    await h.run();
    const firstCount = h.http.countFor(url);

    const second = await h.run();
    expect(h.http.countFor(url)).toBe(firstCount);
    expect(second.ok && second.value.summary.downloaded).toBe(0);
  });
});
