import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/open';
import type { JobId } from '../ids';
import { resetAvailabilityCache } from '../media-tool/ytdlp';
import {
  FakeHttpClient,
  type FakeResponseSpec,
  ManualClock,
  MemoryFileStore,
} from '../testing';
import { JobService } from './job-service';
import type { EventEnvelope } from './sse';

const OUT = '/downloads';
const SEED = 'https://a.test/';

const page = (body: string): FakeResponseSpec => ({
  status: 200,
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><html><body>${body}</body></html>`,
});

const image = (body: string): FakeResponseSpec => ({
  status: 200,
  contentType: 'image/jpeg',
  body,
});

const baseRoutes: Record<string, FakeResponseSpec> = {
  'https://a.test/robots.txt': { status: 404 },
  'https://a.test/sitemap.xml': { status: 404 },
};

interface Fixture {
  readonly service: JobService;
  readonly clock: ManualClock;
  readonly files: MemoryFileStore;
  readonly http: FakeHttpClient;
}

const fixture = (routes: Record<string, FakeResponseSpec>): Fixture => {
  const clock = new ManualClock();
  const http = new FakeHttpClient({ ...baseRoutes, ...routes }, clock);
  const files = new MemoryFileStore();
  const service = new JobService({
    db: openDatabase(':memory:'),
    http,
    clock,
    files,
    renderer: null,
    subprocess: null,
  });
  return { service, clock, files, http };
};

const newJob = (service: JobService, overrides: Record<string, unknown> = {}): JobId => {
  const created = service.createJob({
    seedUrl: SEED,
    output: { directory: OUT },
    crawl: { maxDepth: 1, maxConcurrentPages: 1 },
    ...overrides,
  });
  if (!created.ok) throw new Error(`could not create job: ${JSON.stringify(created.error)}`);
  return created.value.id;
};

beforeEach(() => {
  resetAvailabilityCache();
});

describe('job creation', () => {
  it('rejects a config that does not validate', () => {
    const { service } = fixture({});
    const created = service.createJob({ seedUrl: 'not-a-url', output: { directory: OUT } });

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.kind).toBe('invalid-input');
  });

  it('starts a new job idle', () => {
    const { service } = fixture({});
    const jobId = newJob(service);
    const job = service.getJob(jobId);
    expect(job.ok && job.value.state.status).toBe('idle');
  });

  it('reports an unknown job as not-found', () => {
    const { service } = fixture({});
    expect(service.getJob('job_missing' as JobId).ok).toBe(false);
  });
});

describe('discovery through to review', () => {
  const routes = {
    [SEED]: page('<a href="/two">next</a><img src="/img/a.jpg" alt="A" width="900" height="600">'),
    'https://a.test/two': page('<img src="/img/b.png" alt="B" width="80" height="80">'),
    'https://a.test/img/a.jpg': image('a'.repeat(4_000)),
    'https://a.test/img/b.png': image('b'.repeat(50)),
  };

  it('crawls, extracts, probes and lands in awaiting-selection', async () => {
    const { service } = fixture(routes);
    const jobId = newJob(service);

    expect(service.startCrawl(jobId).ok).toBe(true);
    await service.settle(jobId);

    const job = service.getJob(jobId);
    if (!job.ok) throw new Error('job vanished');
    expect(job.value.state.status).toBe('awaiting-selection');

    const counts = service.repo.countAssets(jobId);
    expect(counts.total).toBe(2);
    expect(counts.included).toBe(2);
  });

  it('drops a linked "image" the probe finds is a page', async () => {
    // The false positive the lightbox-marker rule can produce: markup declares
    // an image, the URL cannot say otherwise, and only the response settles it.
    const { service } = fixture({
      [SEED]: page(
        '<a href="/get_image/9f2c" data-fancybox-type="image"><img src="/img/a.jpg" alt="A"></a>',
      ),
      'https://a.test/img/a.jpg': image('a'.repeat(4_000)),
      'https://a.test/get_image/9f2c': page('<p>a detail page, not a file</p>'),
    });
    const jobId = newJob(service);

    service.startCrawl(jobId);
    await service.settle(jobId);

    // Both were discovered; only the thumbnail survives the probe.
    const counts = service.repo.countAssets(jobId);
    expect(counts.total).toBe(2);
    expect(counts.included).toBe(1);

    const assets = service.repo.listAssets(jobId, { limit: 10 });
    if (!assets.ok) throw new Error('assets vanished');
    const linked = assets.value.find((entry) => entry.url.includes('get_image'));
    expect(linked?.filter).toEqual({ verdict: 'excluded', reason: 'not-media' });
  });

  it('announces measurement progress, because it lands after the phase flips', async () => {
    // `crawl/finished` is dispatched before probing runs, so a client reaches
    // review while every asset is still unmeasured. Without these events the
    // grid keeps that snapshot and shows no size or dimensions for the run.
    const { service } = fixture(routes);
    const jobId = newJob(service);

    const subscribed = service.subscribe(jobId, 0);
    if (!subscribed.ok) throw new Error('subscribe failed');

    const seen: EventEnvelope[] = [];
    const collecting = (async () => {
      for await (const envelope of subscribed.value.live.stream) seen.push(envelope);
    })();

    service.startCrawl(jobId);
    await service.settle(jobId);
    subscribed.value.live.close();
    await collecting;

    const progress = seen
      .map((envelope) => envelope.event)
      .filter((event) => event.type === 'probe/progress');
    expect(progress.length).toBeGreaterThan(0);

    const last = progress[progress.length - 1];
    if (last?.type !== 'probe/progress') throw new Error('expected a progress event');
    expect(last.probed).toBe(last.total);

    // And the measurements really did land on the rows the grid refetches.
    const assets = service.repo.listAssets(jobId, { limit: 10 });
    if (!assets.ok) throw new Error('assets vanished');
    expect(assets.value.every((asset) => asset.probe.status === 'probed')).toBe(true);
  });

  it('refuses to start a crawl twice', async () => {
    const { service } = fixture(routes);
    const jobId = newJob(service);

    service.startCrawl(jobId);
    const second = service.startCrawl(jobId);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.kind).toBe('invalid-state');

    await service.settle(jobId);
  });

  it('re-filters without touching the network again', async () => {
    const { service, http } = fixture(routes);
    const jobId = newJob(service);

    service.startCrawl(jobId);
    await service.settle(jobId);
    const requestsAfterCrawl = http.requests.length;

    const updated = service.updateFilters(jobId, { minWidth: 500 });
    expect(updated.ok).toBe(true);

    expect(http.requests.length).toBe(requestsAfterCrawl);
    expect(service.repo.countAssets(jobId).included).toBe(1);

    const job = service.getJob(jobId);
    if (!job.ok || job.value.state.status !== 'awaiting-selection') throw new Error('wrong state');
    expect(job.value.state).toMatchObject({ eligible: 1, filteredOut: 1 });
  });

  it('rejects filters that do not validate', async () => {
    const { service } = fixture(routes);
    const jobId = newJob(service);
    service.startCrawl(jobId);
    await service.settle(jobId);

    const updated = service.updateFilters(jobId, { urlInclude: '([unclosed' });
    expect(updated.ok).toBe(false);
  });

  it('fails the job when robots.txt forbids the seed', async () => {
    const { service } = fixture({
      'https://a.test/robots.txt': {
        status: 200,
        contentType: 'text/plain',
        body: 'User-agent: *\nDisallow: /',
      },
      [SEED]: page(''),
    });
    const jobId = newJob(service);

    service.startCrawl(jobId);
    await service.settle(jobId);

    const job = service.getJob(jobId);
    if (!job.ok || job.value.state.status !== 'failed') throw new Error('expected a failure');
    expect(job.value.state.error.kind).toBe('robots-denied');
  });
});

describe('selection and download', () => {
  const routes = {
    [SEED]: page('<img src="/img/a.jpg" alt="A"><img src="/img/b.jpg" alt="B">'),
    'https://a.test/img/a.jpg': image('first image bytes'),
    'https://a.test/img/b.jpg': image('second image bytes'),
  };

  const crawlThen = async (service: JobService, jobId: JobId): Promise<void> => {
    service.startCrawl(jobId);
    await service.settle(jobId);
  };

  it('will not start a download with nothing selected', async () => {
    const { service } = fixture(routes);
    const jobId = newJob(service);
    await crawlThen(service, jobId);

    const started = service.startDownload(jobId);
    expect(started.ok).toBe(false);
    if (started.ok || started.error.kind !== 'invalid-state') throw new Error('wrong error');
    expect(started.error.detail).toContain('nothing is selected');
  });

  it('runs the full pipeline to complete and writes a manifest', async () => {
    const { service, files } = fixture(routes);
    const jobId = newJob(service);
    await crawlThen(service, jobId);

    expect(service.setSelection(jobId, { mode: 'all' }).ok).toBe(true);
    expect(service.startDownload(jobId).ok).toBe(true);
    await service.settle(jobId);

    const job = service.getJob(jobId);
    if (!job.ok || job.value.state.status !== 'complete') throw new Error('expected completion');
    expect(job.value.state.summary.downloaded).toBe(2);
    expect(job.value.state.summary.manifestPath).toBe(`${OUT}/manifest.json`);

    const manifest = files.textAt(`${OUT}/manifest.json`);
    expect(manifest).not.toBeNull();
    const parsed = JSON.parse(manifest ?? '{}') as { counts: { downloaded: number } };
    expect(parsed.counts.downloaded).toBe(2);
  });

  it('selects and deselects individual assets', async () => {
    const { service } = fixture(routes);
    const jobId = newJob(service);
    await crawlThen(service, jobId);

    const assets = service.repo.listAssets(jobId);
    if (!assets.ok) throw new Error('listAssets failed');
    const first = assets.value[0];
    if (first === undefined) throw new Error('no assets');

    service.setSelection(jobId, { mode: 'none' });
    const selected = service.setSelection(jobId, {
      mode: 'ids',
      assetIds: [first.id],
      selected: true,
    });

    expect(selected.ok && selected.value).toBe(1);
  });

  it('retries only what failed', async () => {
    const { service } = fixture({
      ...routes,
      'https://a.test/img/b.jpg': { status: 500, body: '', contentType: 'image/jpeg' },
    });
    const jobId = newJob(service, { download: { maxAttempts: 1 } });
    await crawlThen(service, jobId);

    service.setSelection(jobId, { mode: 'all' });
    service.startDownload(jobId);
    await service.settle(jobId);

    const job = service.getJob(jobId);
    if (!job.ok || job.value.state.status !== 'complete') throw new Error('expected completion');
    expect(job.value.state.summary.failed).toBe(1);

    const retry = service.retryFailed(jobId);
    expect(retry.ok && retry.value).toBe(1);
    await service.settle(jobId);
  });

  it('says so when there is nothing to retry', async () => {
    const { service } = fixture(routes);
    const jobId = newJob(service);
    await crawlThen(service, jobId);
    service.setSelection(jobId, { mode: 'all' });
    service.startDownload(jobId);
    await service.settle(jobId);

    const retry = service.retryFailed(jobId);
    expect(retry.ok).toBe(false);
  });
});

describe('event stream', () => {
  const routes = {
    [SEED]: page('<img src="/img/a.jpg" alt="A">'),
    'https://a.test/img/a.jpg': image('bytes'),
  };

  const drain = async (
    stream: AsyncIterable<EventEnvelope>,
    signal: { done: boolean },
  ): Promise<EventEnvelope[]> => {
    const seen: EventEnvelope[] = [];
    for await (const envelope of stream) {
      seen.push(envelope);
      if (signal.done) break;
    }
    return seen;
  };

  it('delivers live events to a subscriber', async () => {
    const { service } = fixture(routes);
    const jobId = newJob(service);

    const subscribed = service.subscribe(jobId, 0);
    if (!subscribed.ok) throw new Error('subscribe failed');

    const signal = { done: false };
    const collecting = drain(subscribed.value.live.stream, signal);

    service.startCrawl(jobId);
    await service.settle(jobId);
    signal.done = true;
    subscribed.value.live.close();

    const seen = await collecting;
    const types = seen.map((envelope) => envelope.event.type);
    expect(types).toContain('crawl/started');
    expect(types).toContain('crawl/finished');
  });

  it('replays durable events from a sequence number after a reconnect', async () => {
    const { service } = fixture(routes);
    const jobId = newJob(service);

    service.startCrawl(jobId);
    await service.settle(jobId);

    const fresh = service.subscribe(jobId, 0);
    if (!fresh.ok) throw new Error('subscribe failed');
    fresh.value.live.close();
    expect(fresh.value.backlog.length).toBeGreaterThan(0);

    const lastSeq = fresh.value.backlog.at(-1)?.seq ?? 0;
    const resumed = service.subscribe(jobId, lastSeq);
    if (!resumed.ok) throw new Error('subscribe failed');
    resumed.value.live.close();

    expect(resumed.value.backlog).toEqual([]);
  });

  it('does not replay high-frequency progress events', async () => {
    const { service } = fixture(routes);
    const jobId = newJob(service);

    service.startCrawl(jobId);
    await service.settle(jobId);

    const subscribed = service.subscribe(jobId, 0);
    if (!subscribed.ok) throw new Error('subscribe failed');
    subscribed.value.live.close();

    const types = subscribed.value.backlog.map((envelope) => envelope.event.type);
    expect(types).not.toContain('crawl/page-visited');
    expect(types).toContain('crawl/finished');
  });

  it('refuses to subscribe to a job that does not exist', () => {
    const { service } = fixture(routes);
    expect(service.subscribe('job_nope' as JobId, 0).ok).toBe(false);
  });
});

describe('lifecycle control', () => {
  const many = Object.fromEntries(
    Array.from({ length: 12 }, (_value, index) => [
      `https://a.test/page-${index}`,
      page(`<a href="/page-${index + 1}">on</a><img src="/img/${index}.jpg">`),
    ]),
  );

  const routes: Record<string, FakeResponseSpec> = {
    ...many,
    [SEED]: page('<a href="/page-0">start</a>'),
  };

  it('parks a running job as paused', async () => {
    const { service } = fixture(routes);
    const jobId = newJob(service, { crawl: { maxDepth: 5, maxConcurrentPages: 1 } });

    service.startCrawl(jobId);
    service.pause(jobId);
    await service.settle(jobId);

    const job = service.getJob(jobId);
    if (!job.ok) throw new Error('job vanished');
    expect(job.value.state.status).toBe('paused');
  });

  it('resumes a paused crawl and finishes it', async () => {
    const { service } = fixture(routes);
    const jobId = newJob(service, { crawl: { maxDepth: 5, maxConcurrentPages: 1 } });

    service.startCrawl(jobId);
    service.pause(jobId);
    await service.settle(jobId);

    expect(service.resume(jobId).ok).toBe(true);
    await service.settle(jobId);

    const job = service.getJob(jobId);
    if (!job.ok) throw new Error('job vanished');
    expect(['awaiting-selection', 'paused']).toContain(job.value.state.status);
  });

  it('will not resume a job that is not paused', () => {
    const { service } = fixture(routes);
    const jobId = newJob(service);
    expect(service.resume(jobId).ok).toBe(false);
  });

  it('cancels a running job into a cancelled summary', async () => {
    const { service } = fixture(routes);
    const jobId = newJob(service, { crawl: { maxDepth: 5, maxConcurrentPages: 1 } });

    service.startCrawl(jobId);
    service.cancel(jobId);
    await service.settle(jobId);

    const job = service.getJob(jobId);
    if (!job.ok || job.value.state.status !== 'complete') throw new Error('expected completion');
    expect(job.value.state.summary.outcome).toBe('cancelled');
  });

  it('will not pause a job that is not running', () => {
    const { service } = fixture(routes);
    const jobId = newJob(service);
    expect(service.pause(jobId).ok).toBe(false);
  });
});

describe('dispatch', () => {
  it('rejects an event the current state cannot accept', () => {
    const { service, clock } = fixture({});
    const jobId = newJob(service);

    const dispatched = service.dispatch(jobId, {
      type: 'download/finished',
      at: clock.now(),
      summary: {
        outcome: 'finished',
        downloaded: 0,
        skippedDuplicate: 0,
        filteredOut: 0,
        failed: 0,
        bytesWritten: 0,
        durationMs: 0,
        manifestPath: null,
        finishedAt: clock.now(),
      },
    });

    expect(dispatched.ok).toBe(false);
    if (dispatched.ok) return;
    expect(dispatched.error.kind).toBe('invalid-state');
  });

  it('persists state before publishing, so a subscriber never sees an uncommitted state', () => {
    const { service, clock } = fixture({});
    const jobId = newJob(service);

    service.dispatch(jobId, { type: 'crawl/started', at: clock.now() });

    const job = service.getJob(jobId);
    expect(job.ok && job.value.state.status).toBe('crawling');
  });
});

describe('budget dead ends', () => {
  const many = Object.fromEntries(
    Array.from({ length: 8 }, (_value, index) => [
      `https://a.test/page-${index}`,
      page(`<a href="/page-${index + 1}">on</a><img src="/img/${index}.jpg" alt="x">`),
    ]),
  );

  // Stub the images the pages reference. Unstubbed they are 404s serving an
  // HTML error body, which the content-type veto rightly refuses to download.
  const stubbedImages = Object.fromEntries(
    Array.from({ length: 8 }, (_value, index) => [
      `https://a.test/img/${index}.jpg`,
      image(`jpeg-${index}`),
    ]),
  );

  const routes: Record<string, FakeResponseSpec> = {
    ...many,
    ...stubbedImages,
    'https://a.test/img/seed.jpg': image('jpeg-seed'),
    [SEED]: page('<a href="/page-0">start</a><img src="/img/seed.jpg" alt="s">'),
  };

  const crawlToCap = async (service: JobService, jobId: JobId): Promise<void> => {
    service.startCrawl(jobId);
    await service.settle(jobId);
  };

  const capped = { crawl: { maxDepth: 8, maxConcurrentPages: 1 }, caps: { maxPagesCrawled: 3 } };

  it('stops at the pages cap and says which cap it was', async () => {
    const { service } = fixture(routes);
    const jobId = newJob(service, capped);
    await crawlToCap(service, jobId);

    const job = service.getJob(jobId);
    if (!job.ok || job.value.state.status !== 'paused') throw new Error('expected a pause');
    expect(job.value.state.reason).toMatchObject({ kind: 'budget', breach: { cap: 'pages-crawled' } });
  });

  it('refuses to resume into a spent pages cap instead of bouncing back', async () => {
    const { service } = fixture(routes);
    const jobId = newJob(service, capped);
    await crawlToCap(service, jobId);

    const resumed = service.resume(jobId);
    expect(resumed.ok).toBe(false);
    if (resumed.ok || resumed.error.kind !== 'invalid-state') throw new Error('wrong error');
    expect(resumed.error.detail).toContain('pages-crawled');
  });

  it('resumes once the cap is raised', async () => {
    const { service } = fixture(routes);
    const jobId = newJob(service, capped);
    await crawlToCap(service, jobId);

    const raised = service.updateCaps(jobId, { maxPagesCrawled: 500 });
    expect(raised.ok && raised.value.maxPagesCrawled).toBe(500);

    expect(service.resume(jobId).ok).toBe(true);
    await service.settle(jobId);

    const job = service.getJob(jobId);
    if (!job.ok) throw new Error('job vanished');
    expect(job.value.state.status).not.toBe('paused');
  });

  it('leaves untouched caps alone when patching one', () => {
    const { service } = fixture(routes);
    const jobId = newJob(service, { caps: { maxFileCount: 42 } });

    const raised = service.updateCaps(jobId, { maxPagesCrawled: 999 });
    expect(raised.ok && raised.value).toMatchObject({ maxPagesCrawled: 999, maxFileCount: 42 });
  });

  it('rejects a caps patch that does not validate', () => {
    const { service } = fixture(routes);
    const jobId = newJob(service);
    expect(service.updateCaps(jobId, { maxPagesCrawled: -1 }).ok).toBe(false);
    expect(service.updateCaps(jobId, { nonsense: 1 }).ok).toBe(false);
  });

  it('ends a truncated crawl at review rather than losing what it found', async () => {
    const { service } = fixture(routes);
    const jobId = newJob(service, capped);
    await crawlToCap(service, jobId);

    const found = service.repo.countAssets(jobId).total;
    expect(found).toBeGreaterThan(0);

    expect(service.finishDiscovery(jobId).ok).toBe(true);
    await service.settle(jobId);

    const job = service.getJob(jobId);
    if (!job.ok || job.value.state.status !== 'awaiting-selection') {
      throw new Error(`expected review, got ${job.ok ? job.value.state.status : 'error'}`);
    }
    // The summary records that this was cut short, not that it ran to the end.
    expect(job.value.state.crawl.truncatedBy).toBe('pages-crawled');
    expect(service.repo.countAssets(jobId).total).toBe(found);
  });

  it('can select and download after finishing a truncated crawl', async () => {
    const { service } = fixture(routes);
    const jobId = newJob(service, capped);
    await crawlToCap(service, jobId);

    service.finishDiscovery(jobId);
    await service.settle(jobId);

    service.setSelection(jobId, { mode: 'all' });
    expect(service.startDownload(jobId).ok).toBe(true);
    await service.settle(jobId);

    const job = service.getJob(jobId);
    expect(job.ok && job.value.state.status).toBe('complete');
  });

  it('refuses to finish discovery on a job that is not paused mid-crawl', async () => {
    const { service } = fixture(routes);
    const jobId = newJob(service);
    expect(service.finishDiscovery(jobId).ok).toBe(false);

    service.startCrawl(jobId);
    await service.settle(jobId);
    expect(service.finishDiscovery(jobId).ok).toBe(false);
  });

  it('does not count paused time against the duration cap', async () => {
    const { service, clock } = fixture(routes);
    const jobId = newJob(service, {
      crawl: { maxDepth: 8, maxConcurrentPages: 1 },
      caps: { maxDurationMs: 60_000 },
    });

    service.startCrawl(jobId);
    service.pause(jobId);
    await service.settle(jobId);

    // A long lunch should not exhaust a wall-clock cap on working time.
    clock.advance(10 * 60_000);
    expect(service.resume(jobId).ok).toBe(true);
    await service.settle(jobId);
  });
});
