import { describe, expect, it } from 'vitest';
import { jobConfigSchema } from '../config';
import type { AssetId, JobId } from '../ids';
import type { Asset } from '../media';
import { emptyHints } from '../media';
import { AsyncQueue, EventBus } from './bus';
import { buildManifest } from './manifest';
import {
  encodeComment,
  encodeDataLines,
  encodeFrame,
  encodeRetry,
  encodeSnapshot,
  parseLastEventId,
} from './sse';

const collect = async <T>(stream: AsyncIterable<T>, count: number): Promise<T[]> => {
  const seen: T[] = [];
  for await (const item of stream) {
    seen.push(item);
    if (seen.length >= count) break;
  }
  return seen;
};

describe('AsyncQueue', () => {
  it('delivers items pushed before anyone was listening', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();

    expect(await collect(queue, 2)).toEqual([1, 2]);
  });

  it('wakes a waiting consumer', async () => {
    const queue = new AsyncQueue<string>();
    const pending = collect(queue, 1);
    queue.push('later');
    expect(await pending).toEqual(['later']);
  });

  it('ends iteration when closed', async () => {
    const queue = new AsyncQueue<number>();
    const drained: number[] = [];
    const consumer = (async () => {
      for await (const item of queue) drained.push(item);
    })();

    queue.push(1);
    await Promise.resolve();
    queue.close();
    await consumer;

    expect(drained).toEqual([1]);
  });

  it('drops the oldest entries rather than growing without bound', async () => {
    const queue = new AsyncQueue<number>(3);
    for (let index = 0; index < 10; index += 1) queue.push(index);
    queue.close();

    expect(await collect(queue, 3)).toEqual([7, 8, 9]);
    expect(queue.dropped).toBe(7);
  });

  it('ignores pushes after close', async () => {
    const queue = new AsyncQueue<number>();
    queue.close();
    queue.push(1);
    expect(await collect(queue, 1)).toEqual([]);
  });
});

describe('EventBus', () => {
  it('fans one publish out to every subscriber of that topic', async () => {
    const bus = new EventBus<string>();
    const first = bus.subscribe('job_a');
    const second = bus.subscribe('job_a');

    bus.publish('job_a', 'hello');
    first.close();
    second.close();

    expect(await collect(first.stream, 1)).toEqual(['hello']);
    expect(await collect(second.stream, 1)).toEqual(['hello']);
  });

  it('keeps topics apart', async () => {
    const bus = new EventBus<string>();
    const a = bus.subscribe('job_a');
    const b = bus.subscribe('job_b');

    bus.publish('job_a', 'for a');
    a.close();
    b.close();

    expect(await collect(a.stream, 1)).toEqual(['for a']);
    expect(await collect(b.stream, 1)).toEqual([]);
  });

  it('forgets a subscriber once it closes', () => {
    const bus = new EventBus<string>();
    const subscription = bus.subscribe('job_a');
    expect(bus.subscriberCount('job_a')).toBe(1);

    subscription.close();
    expect(bus.subscriberCount('job_a')).toBe(0);
  });

  it('publishing to a topic nobody watches is harmless', () => {
    const bus = new EventBus<string>();
    expect(() => bus.publish('nobody', 'x')).not.toThrow();
  });
});

describe('SSE encoding', () => {
  const state = { status: 'idle' } as const;

  it('writes id, event and data as a frame ending in a blank line', () => {
    const frame = encodeFrame({ seq: 12, event: { type: 'crawl/started', at: 5 }, state });

    expect(frame.startsWith('id: 12\nevent: crawl/started\ndata: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('omits the id for an event that was never persisted', () => {
    const frame = encodeFrame({ seq: null, event: { type: 'job/paused', at: 5 }, state });
    expect(frame).not.toContain('id:');
    expect(frame).toContain('event: job/paused');
  });

  it('splits a value containing newlines so the frame is not cut short', () => {
    expect(encodeDataLines('line one\nline two')).toBe('data: line one\ndata: line two');
    expect(encodeDataLines('crlf\r\nhandled')).toBe('data: crlf\ndata: handled');
  });

  it('keeps a newline inside a payload intact, because JSON escapes it', () => {
    const frame = encodeFrame({
      seq: 1,
      event: {
        type: 'crawl/page-failed',
        at: 1,
        url: 'https://a.test/',
        reason: 'line one\nline two',
        queueDepth: 0,
      },
      state,
    });

    const dataLines = frame.split('\n').filter((line) => line.startsWith('data: '));
    expect(dataLines).toHaveLength(1);

    const parsed = JSON.parse(dataLines[0]?.slice(6) ?? '{}') as {
      event: { reason: string };
    };
    expect(parsed.event.reason).toBe('line one\nline two');
  });

  it('round-trips through JSON', () => {
    const event = { type: 'crawl/started', at: 5 } as const;
    const frame = encodeFrame({ seq: 3, event, state });
    const payload = frame
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .join('');

    expect(JSON.parse(payload)).toEqual({ event, state, seq: 3 });
  });

  it('marks the opening snapshot as its own frame type, not a fabricated event', () => {
    const frame = encodeSnapshot(state, null);
    expect(frame).toContain('event: snapshot');
    // A client feeding frames through the reducer must not see a transition
    // that never happened.
    expect(frame).not.toContain('job/resumed');
    expect(frame.endsWith('\n\n')).toBe(true);

    const payload = frame
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .join('');
    expect(JSON.parse(payload)).toEqual({ state, seq: null });
  });

  it('encodes comments and retry hints', () => {
    expect(encodeComment('ping')).toBe(': ping\n\n');
    expect(encodeRetry(3_000)).toBe('retry: 3000\n\n');
  });
});

describe('parseLastEventId', () => {
  it('reads a positive integer', () => {
    expect(parseLastEventId('42')).toBe(42);
  });

  it('treats absence or nonsense as start-from-the-beginning', () => {
    expect(parseLastEventId(null)).toBe(0);
    expect(parseLastEventId('')).toBe(0);
    expect(parseLastEventId('abc')).toBe(0);
    expect(parseLastEventId('-5')).toBe(0);
  });
});

describe('buildManifest', () => {
  const config = jobConfigSchema.parse({
    seedUrl: 'https://example.test/',
    output: { directory: '/downloads' },
  });

  const base = {
    jobId: 'job_1' as JobId,
    normalizedUrl: 'https://cdn.test/a.jpg',
    kind: 'image' as const,
    acquisition: { strategy: 'direct' as const, url: 'https://cdn.test/a.jpg' },
    hints: emptyHints(),
    probe: { status: 'unprobed' as const },
    filter: { verdict: 'included' as const },
    selected: true,
    download: { status: 'pending' as const },
    firstSeenAt: 0,
    updatedAt: 0,
  };

  const asset = (overrides: Partial<Asset>): Asset => ({
    ...base,
    id: 'as_1' as AssetId,
    url: 'https://cdn.test/a.jpg',
    sources: [
      { pageUrl: 'https://example.test/', extractor: 'img-src', alt: 'A', discoveredAt: 0 },
    ],
    ...overrides,
  });

  it('reports every page an asset was found on, not just the first', () => {
    const manifest = buildManifest(
      'job_1' as JobId,
      config,
      [
        asset({
          sources: [
            { pageUrl: 'https://example.test/a', extractor: 'img-src', alt: null, discoveredAt: 0 },
            { pageUrl: 'https://example.test/b', extractor: 'open-graph', alt: null, discoveredAt: 1 },
            { pageUrl: 'https://example.test/a', extractor: 'img-src', alt: null, discoveredAt: 2 },
          ],
        }),
      ],
      new Date('2026-08-14T00:00:00Z'),
    );

    expect(manifest.entries[0]?.sourcePages).toEqual([
      'https://example.test/a',
      'https://example.test/b',
    ]);
    expect(manifest.entries[0]?.extractors).toEqual(['img-src', 'open-graph']);
  });

  it('classifies each asset and tallies the counts', () => {
    const manifest = buildManifest(
      'job_1' as JobId,
      config,
      [
        asset({
          id: 'as_1' as AssetId,
          download: {
            status: 'complete',
            localPath: '/downloads/a.jpg',
            bytes: 100,
            sha256: 'a'.repeat(64),
            completedAt: 0,
          },
        }),
        asset({
          id: 'as_2' as AssetId,
          download: {
            status: 'skipped-duplicate',
            sha256: 'a'.repeat(64),
            duplicateOf: 'as_1' as AssetId,
            localPath: '/downloads/a.jpg',
          },
        }),
        asset({ id: 'as_3' as AssetId, filter: { verdict: 'excluded', reason: 'min-width' } }),
        asset({
          id: 'as_4' as AssetId,
          download: {
            status: 'failed',
            error: { kind: 'http', status: 404, message: 'HTTP 404' },
            attempts: 1,
            failedAt: 0,
          },
        }),
        asset({ id: 'as_5' as AssetId }),
      ],
      new Date('2026-08-14T00:00:00Z'),
    );

    expect(manifest.counts).toEqual({
      total: 5,
      downloaded: 1,
      skippedDuplicate: 1,
      filteredOut: 1,
      failed: 1,
      pending: 1,
    });
    expect(manifest.entries.map((entry) => entry.status)).toEqual([
      'downloaded',
      'skipped-duplicate',
      'filtered-out',
      'failed',
      'pending',
    ]);
  });

  it('explains why each non-success happened', () => {
    const manifest = buildManifest(
      'job_1' as JobId,
      config,
      [
        asset({ filter: { verdict: 'excluded', reason: 'min-bytes' } }),
        asset({
          id: 'as_2' as AssetId,
          download: {
            status: 'failed',
            error: { kind: 'subprocess', tool: 'yt-dlp', exitCode: 1, stderr: 'geo-blocked' },
            attempts: 1,
            failedAt: 0,
          },
        }),
      ],
      new Date(),
    );

    expect(manifest.entries[0]?.detail).toBe('min-bytes');
    expect(manifest.entries[1]?.detail).toBe('yt-dlp: geo-blocked');
  });

  it('records the content hash and local path only once a file exists', () => {
    const manifest = buildManifest('job_1' as JobId, config, [asset({})], new Date());
    expect(manifest.entries[0]?.contentHash).toBeNull();
    expect(manifest.entries[0]?.localPath).toBeNull();
  });

  it('handles a job with no assets', () => {
    const manifest = buildManifest('job_1' as JobId, config, [], new Date());
    expect(manifest.counts.total).toBe(0);
    expect(manifest.entries).toEqual([]);
  });
});
