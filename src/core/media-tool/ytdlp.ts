import type { Clock } from '../clock';
import type { JobConfig } from '../config';
import type { JobRepository } from '../db/repository';
import type { AssetId, JobId } from '../ids';
import type { JobEvent } from '../job/events';
import type { AcquisitionPlan, DownloadState } from '../media';
import { hashFile } from '../download/hash';
import type { FileStore } from '../download/file-store';
import {
  buildYtDlpArgs,
  classifyFailure,
  parseFilepathLine,
  parseProgressLine,
} from './ytdlp-args';
import type { SubprocessRunner } from './subprocess';

export interface MediaToolDeps {
  readonly subprocess: SubprocessRunner;
  readonly files: FileStore;
  readonly repo: JobRepository;
  readonly clock: Clock;
  readonly emit: (event: JobEvent) => void;
}

export interface MediaToolRequest {
  readonly jobId: JobId;
  readonly assetId: AssetId;
  readonly acquisition: Exclude<AcquisitionPlan, { strategy: 'direct' }>;
  readonly outputBase: string;
  readonly config: JobConfig;
  readonly signal: AbortSignal;
  readonly remainingBytes: number | null;
}

/**
 * Availability is checked once per process and cached. `yt-dlp --version` is
 * cheap, but a job with two hundred embeds should not pay for it two hundred
 * times, and a missing binary should be reported as a clear precondition
 * failure rather than two hundred identical download errors.
 */
const availability = new Map<string, Promise<boolean>>();

export const isYtDlpAvailable = (
  subprocess: SubprocessRunner,
  binary: string,
  timeoutMs = 10_000,
): Promise<boolean> => {
  const cached = availability.get(binary);
  if (cached !== undefined) return cached;

  const probe = subprocess
    .run(binary, ['--version'], { timeoutMs })
    .then((result) => result.ok && result.value.exitCode === 0);

  availability.set(binary, probe);
  return probe;
};

/** Test seam: availability is process-global, so it has to be resettable. */
export const resetAvailabilityCache = (): void => availability.clear();

const failed = (
  message: string,
  exitCode: number | null,
  attempts: number,
  at: number,
): DownloadState => ({
  status: 'failed',
  error: { kind: 'subprocess', tool: 'yt-dlp', exitCode, stderr: message },
  attempts,
  failedAt: at,
});

export const downloadWithYtDlp = async (
  deps: MediaToolDeps,
  request: MediaToolRequest,
): Promise<DownloadState> => {
  const { config, signal } = request;
  const binary = config.tools.ytDlpPath;

  if (!config.tools.enabled) {
    return failed('external tools are disabled for this job', null, 1, deps.clock.now());
  }

  if (!(await isYtDlpAvailable(deps.subprocess, binary, config.tools.timeoutMs))) {
    return failed(
      `${binary} is not installed or not on PATH; install yt-dlp to fetch streams and embeds`,
      null,
      1,
      deps.clock.now(),
    );
  }

  const url =
    request.acquisition.strategy === 'hls'
      ? request.acquisition.manifestUrl
      : request.acquisition.embedUrl;

  const args = buildYtDlpArgs({
    url,
    outputBase: request.outputBase,
    strategy: request.acquisition.strategy,
    userAgent: config.crawl.userAgent,
    tools: config.tools,
    // Hand the remaining byte budget to yt-dlp so it declines oversized media
    // itself instead of us discovering the overshoot after the fact.
    maxFilesizeBytes: request.remainingBytes,
  });

  let producedPath: string | null = null;
  let lastReported = 0;

  const result = await deps.subprocess.run(binary, args, {
    timeoutMs: config.tools.timeoutMs,
    signal,
    onStdoutLine: (line) => {
      const path = parseFilepathLine(line);
      if (path !== null) {
        producedPath = path;
        return;
      }

      const progress = parseProgressLine(line);
      if (progress === null || progress.downloadedBytes === null) return;

      const delta = Math.max(0, progress.downloadedBytes - lastReported);
      lastReported = progress.downloadedBytes;
      if (delta === 0) return;

      deps.emit({
        type: 'download/asset-progress',
        at: deps.clock.now(),
        assetId: request.assetId,
        deltaBytes: delta,
        bytesDownloaded: progress.downloadedBytes,
        totalBytes: progress.totalBytes,
      });
    },
  });

  const now = deps.clock.now();

  if (!result.ok) {
    switch (result.error.kind) {
      case 'not-found':
        return failed(`${binary} is not installed or not on PATH`, null, 1, now);
      case 'timeout':
        return failed(`yt-dlp exceeded ${result.error.afterMs}ms`, null, 1, now);
      case 'cancelled':
        return { status: 'failed', error: { kind: 'cancelled' }, attempts: 1, failedAt: now };
      case 'spawn-failed':
        return failed(result.error.message, null, 1, now);
    }
  }

  if (result.value.exitCode !== 0) {
    const failure = classifyFailure(result.value.stderr);
    return failed(`${failure.reason}: ${failure.detail}`, result.value.exitCode, 1, now);
  }

  // yt-dlp exits 0 having printed nothing when the media was already present
  // and `--no-overwrites` suppressed the write; fall back to the base path.
  const path: string | null = producedPath ?? (await findProduced(deps.files, request.outputBase));
  if (path === null) {
    return failed('yt-dlp reported success but produced no file', 0, 1, now);
  }

  const digest = await hashFile(deps.files, path);
  if (digest === null) {
    return failed(`could not read the file yt-dlp wrote at ${path}`, 0, 1, now);
  }

  const duplicate = deps.repo.findByHash(request.jobId, digest.sha256);
  if (duplicate !== null && duplicate.id !== request.assetId) {
    await deps.files.remove(path);
    return {
      status: 'skipped-duplicate',
      sha256: digest.sha256,
      duplicateOf: duplicate.id,
      localPath: duplicate.localPath,
    };
  }

  return {
    status: 'complete',
    localPath: path,
    bytes: digest.bytes,
    sha256: digest.sha256,
    completedAt: now,
  };
};

const LIKELY_EXTENSIONS = ['mp4', 'mkv', 'webm', 'm4a', 'ts', 'mov'] as const;

const findProduced = async (files: FileStore, base: string): Promise<string | null> => {
  for (const extension of LIKELY_EXTENSIONS) {
    const candidate = `${base}.${extension}`;
    if ((await files.sizeOf(candidate)) !== null) return candidate;
  }
  return null;
};
