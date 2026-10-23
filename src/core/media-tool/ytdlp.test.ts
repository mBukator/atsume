import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { type JobConfig, jobConfigSchema } from '../config';
import { openDatabase } from '../db/open';
import { JobRepository } from '../db/repository';
import type { AssetId } from '../ids';
import type { JobEvent } from '../job/events';
import { emptyHints, type MediaCandidate } from '../media';
import {
  FakeSubprocessRunner,
  type FakeProcessSpec,
  ManualClock,
  MemoryFileStore,
} from '../testing';
import { downloadWithYtDlp, resetAvailabilityCache } from './ytdlp';
import { FILEPATH_PREFIX, PROGRESS_PREFIX } from './ytdlp-args';

const T0 = 1_700_000_000_000;
const OUT = '/downloads';
const MANIFEST = 'https://cdn.test/live/index.m3u8';
const PRODUCED = `${OUT}/cdn.test/video/stream.mp4`;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const config: JobConfig = jobConfigSchema.parse({
  seedUrl: 'https://test/',
  output: { directory: OUT },
});

const isVersionProbe = (args: readonly string[]): boolean => args[0] === '--version';

interface Harness {
  readonly run: (
    overrides?: Partial<{ acquisition: never; config: JobConfig; aborted: boolean }>,
  ) => ReturnType<typeof downloadWithYtDlp>;
  readonly files: MemoryFileStore;
  readonly runner: FakeSubprocessRunner;
  readonly events: JobEvent[];
  readonly repo: JobRepository;
  readonly assetId: AssetId;
}

const harness = (
  route: (command: string, args: readonly string[]) => FakeProcessSpec,
  extraCandidates: readonly MediaCandidate[] = [],
): Harness => {
  const db = openDatabase(':memory:');
  const repo = new JobRepository(db);
  const job = repo.createJob(config, T0);

  const candidate: MediaCandidate = {
    url: MANIFEST,
    kind: 'video',
    acquisition: { strategy: 'hls', manifestUrl: MANIFEST },
    hints: emptyHints(),
    foundBy: 'hls-manifest',
    foundOn: 'https://test/watch',
  };

  const upserted = repo.upsertCandidates(job.id, [candidate, ...extraCandidates], T0);
  if (!upserted.ok) throw new Error('seeding failed');
  const assetId = upserted.value[0]?.assetId;
  if (assetId === undefined) throw new Error('seeding failed');

  const files = new MemoryFileStore();
  const runner = new FakeSubprocessRunner(route, files);
  const events: JobEvent[] = [];
  const clock = new ManualClock(T0);

  return {
    files,
    runner,
    events,
    repo,
    assetId,
    run: (overrides = {}) => {
      const controller = new AbortController();
      if (overrides.aborted === true) controller.abort();

      return downloadWithYtDlp(
        { subprocess: runner, files, repo, clock, emit: (event) => events.push(event) },
        {
          jobId: job.id,
          assetId,
          acquisition: { strategy: 'hls', manifestUrl: MANIFEST },
          outputBase: `${OUT}/cdn.test/video/stream`,
          config: overrides.config ?? config,
          signal: controller.signal,
          remainingBytes: 10_000_000,
        },
      );
    },
  };
};

beforeEach(() => {
  // Availability is cached per process, which would leak between tests.
  resetAvailabilityCache();
});

describe('a successful fetch', () => {
  const body = 'remuxed video bytes '.repeat(10);

  const route = (_command: string, args: readonly string[]): FakeProcessSpec =>
    isVersionProbe(args)
      ? { exitCode: 0, stdout: ['2026.01.01'] }
      : {
          exitCode: 0,
          stdout: [
            `${PROGRESS_PREFIX}|downloading|100|${body.length}|${body.length}`,
            `${PROGRESS_PREFIX}|downloading|${body.length}|${body.length}|${body.length}`,
            `${PROGRESS_PREFIX}|finished|${body.length}|${body.length}|${body.length}`,
            `${FILEPATH_PREFIX}|${PRODUCED}`,
          ],
          writes: [{ path: PRODUCED, body }],
        };

  it('records the file yt-dlp reported, with its real hash and size', async () => {
    const h = harness(route);
    const state = await h.run();

    expect(state).toMatchObject({
      status: 'complete',
      localPath: PRODUCED,
      bytes: body.length,
      sha256: sha(body),
    });
  });

  it('checks the binary once before invoking it', async () => {
    const h = harness(route);
    await h.run();
    await h.run();

    const probes = h.runner.invocations.filter((call) => isVersionProbe(call.args));
    expect(probes).toHaveLength(1);
  });

  it('reports progress as deltas rather than running totals', async () => {
    const h = harness(route);
    await h.run();

    const deltas = h.events
      .filter((event) => event.type === 'download/asset-progress')
      .map((event) => (event.type === 'download/asset-progress' ? event.deltaBytes : 0));

    expect(body.length).toBeGreaterThan(100);
    expect(deltas).toEqual([100, body.length - 100]);
    expect(deltas.reduce((sum, value) => sum + value, 0)).toBe(body.length);
  });

  it('finds the file by extension when yt-dlp printed no path', async () => {
    const h = harness((_command, args) =>
      isVersionProbe(args)
        ? { exitCode: 0, stdout: ['2026.01.01'] }
        : { exitCode: 0, stdout: [], writes: [{ path: PRODUCED, body }] },
    );

    const state = await h.run();
    expect(state).toMatchObject({ status: 'complete', localPath: PRODUCED });
  });
});

describe('failures', () => {
  const versionOk = { exitCode: 0, stdout: ['2026.01.01'] };

  it('reports a missing binary as a precondition failure, not a download error', async () => {
    const h = harness((_command, args) =>
      isVersionProbe(args) ? { error: { kind: 'not-found', command: 'yt-dlp' } } : { exitCode: 0 },
    );

    const state = await h.run();
    expect(state.status).toBe('failed');
    if (state.status !== 'failed' || state.error.kind !== 'subprocess') throw new Error('shape');
    expect(state.error.stderr).toContain('not installed');
    // It should not have tried to download after failing the check.
    expect(h.runner.invocations).toHaveLength(1);
  });

  it('classifies a non-zero exit from stderr', async () => {
    const h = harness((_command, args) =>
      isVersionProbe(args)
        ? versionOk
        : { exitCode: 1, stderr: ['ERROR: Sign in to confirm your age'] },
    );

    const state = await h.run();
    if (state.status !== 'failed' || state.error.kind !== 'subprocess') throw new Error('shape');
    expect(state.error.stderr).toContain('requires-authentication');
    expect(state.error.exitCode).toBe(1);
  });

  it('does not claim success when the process exits 0 but writes nothing', async () => {
    const h = harness((_command, args) => (isVersionProbe(args) ? versionOk : { exitCode: 0 }));

    const state = await h.run();
    if (state.status !== 'failed' || state.error.kind !== 'subprocess') throw new Error('shape');
    expect(state.error.stderr).toContain('produced no file');
  });

  it('surfaces cancellation as cancelled, not as a tool error', async () => {
    const h = harness((_command, args) => (isVersionProbe(args) ? versionOk : { exitCode: 0 }));

    const state = await h.run({ aborted: true });
    if (state.status !== 'failed') throw new Error('expected a failure');
    expect(state.error.kind).toBe('cancelled');
  });

  it('refuses to run at all when tools are disabled', async () => {
    const h = harness((_command, args) => (isVersionProbe(args) ? versionOk : { exitCode: 0 }));

    const disabled = jobConfigSchema.parse({
      seedUrl: 'https://test/',
      output: { directory: OUT },
      tools: { enabled: false },
    });

    const state = await h.run({ config: disabled });
    expect(state.status).toBe('failed');
    expect(h.runner.invocations).toHaveLength(0);
  });

  it('reports a timeout with the limit that was exceeded', async () => {
    const h = harness((_command, args) =>
      isVersionProbe(args) ? versionOk : { error: { kind: 'timeout', afterMs: 900_000 } },
    );

    const state = await h.run();
    if (state.status !== 'failed' || state.error.kind !== 'subprocess') throw new Error('shape');
    expect(state.error.stderr).toContain('900000ms');
  });
});

describe('duplicates', () => {
  it('skips a stream whose bytes already landed under another asset', async () => {
    const body = 'identical remux output';
    const other = `${OUT}/other.mp4`;

    const h = harness(
      (_command, args) =>
        isVersionProbe(args)
          ? { exitCode: 0, stdout: ['2026.01.01'] }
          : {
              exitCode: 0,
              stdout: [`${FILEPATH_PREFIX}|${PRODUCED}`],
              writes: [{ path: PRODUCED, body }],
            },
      [
        {
          url: 'https://cdn.test/other.m3u8',
          kind: 'video',
          acquisition: { strategy: 'hls', manifestUrl: 'https://cdn.test/other.m3u8' },
          hints: emptyHints(),
          foundBy: 'hls-manifest',
          foundOn: 'https://test/watch',
        },
      ],
    );

    const jobId = h.repo.listJobs()[0]?.id;
    if (jobId === undefined) throw new Error('no job');
    const assets = h.repo.listAssets(jobId);
    if (!assets.ok) throw new Error('listAssets failed');
    const twin = assets.value.find((asset) => asset.id !== h.assetId);
    if (twin === undefined) throw new Error('no twin');

    h.repo.setDownloadState(
      twin.id,
      { status: 'complete', localPath: other, bytes: body.length, sha256: sha(body), completedAt: T0 },
      T0,
    );

    const state = await h.run();
    expect(state).toMatchObject({
      status: 'skipped-duplicate',
      sha256: sha(body),
      duplicateOf: twin.id,
      localPath: other,
    });
    // The redundant copy is cleaned up rather than left on disk.
    expect(await h.files.sizeOf(PRODUCED)).toBeNull();
  });
});
