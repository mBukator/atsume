import { createHash } from 'node:crypto';
import type { Clock } from '../clock';
import type { JobConfig } from '../config';
import type { JobRepository } from '../db/repository';
import type { AssetId, JobId } from '../ids';
import {
  type BudgetBreach,
  type BudgetLedger,
  checkBudget,
  creditFile,
  wouldBreach,
} from '../job/budget';
import type { JobEvent } from '../job/events';
import type { JobError, JobSummary } from '../job/state';
import { type Asset, type DownloadError, type DownloadState } from '../media';
import {
  acceptsRanges,
  type HttpClient,
  type HttpError,
  type RequestOptions,
} from '../net/http';
import { downloadWithYtDlp } from '../media-tool/ytdlp';
import type { SubprocessRunner } from '../media-tool/subprocess';
import { remainingBudget } from '../job/budget';
import { err, ok, type Result } from '../result';
import { hostOf } from '../url';
import { nextDelay, decideRetry } from './backoff';
import { type FileStore, partialPathFor, type WriteHandle } from './file-store';
import { resolveOutputPath } from './paths';
import { ConcurrencyPool } from './pool';

export interface DownloadDeps {
  readonly http: HttpClient;
  readonly clock: Clock;
  readonly files: FileStore;
  readonly repo: JobRepository;
  readonly emit: (event: JobEvent) => void;
  readonly random?: () => number;
  /** Omit to leave HLS and embed assets unfetched rather than half-fetched. */
  readonly subprocess?: SubprocessRunner | null;
}

export interface DownloadRequest {
  readonly jobId: JobId;
  readonly config: JobConfig;
  readonly ledger: BudgetLedger;
  readonly signal: AbortSignal;
  /** Restrict to specific assets; omit to take everything currently selected. */
  readonly assetIds?: readonly AssetId[];
}

export interface DownloadOutcome {
  readonly stopped: 'finished' | 'cancelled' | 'budget';
  readonly summary: JobSummary;
  readonly breach: BudgetBreach | null;
  readonly ledger: BudgetLedger;
}

/** Progress events are throttled: a fast file would otherwise emit thousands. */
const PROGRESS_INTERVAL_BYTES = 256 * 1024;

export const runDownloads = async (
  deps: DownloadDeps,
  request: DownloadRequest,
): Promise<Result<DownloadOutcome, JobError>> => {
  const startedAt = deps.clock.now();
  const { config, jobId, signal } = request;

  const selected = deps.repo.listAssets(jobId, { selected: true, limit: 100_000 });
  if (!selected.ok) {
    return err({ kind: 'internal', message: `could not read selection: ${selected.error.kind}` });
  }

  const wanted =
    request.assetIds === undefined
      ? selected.value
      : selected.value.filter((asset) => request.assetIds?.includes(asset.id) === true);

  // A retry run re-attempts failures; a fresh run skips what is already on disk.
  const pending = wanted.filter(
    (asset) => asset.download.status !== 'complete' && asset.download.status !== 'skipped-duplicate',
  );

  const pool = new ConcurrencyPool(
    config.download.globalConcurrency,
    config.download.perHostConcurrency,
  );

  let ledger = request.ledger;
  const stop: { reason: DownloadOutcome['stopped']; breach: BudgetBreach | null } = {
    reason: 'finished',
    breach: null,
  };
  const tally = { downloaded: 0, skippedDuplicate: 0, failed: 0 };

  const halt = (reason: DownloadOutcome['stopped'], cause: BudgetBreach | null): void => {
    if (stop.reason === 'finished') stop.reason = reason;
    if (cause !== null) stop.breach ??= cause;
  };

  const requestOptions: RequestOptions = {
    userAgent: config.crawl.userAgent,
    timeoutMs: config.download.requestTimeoutMs,
    signal,
  };

  await Promise.all(
    pending.map(async (asset, index) => {
      if (stop.reason !== 'finished' || signal.aborted) return;

      const host = hostOf(asset.url);
      await pool.run(host.ok ? host.value : 'unknown', async () => {
        if (stop.reason !== 'finished' || signal.aborted) return;

        // Refuse to start work that cannot finish inside the budget rather than
        // aborting a transfer halfway through.
        const expected = asset.probe.status === 'probed' ? (asset.probe.contentLength ?? 0) : 0;
        const preflight = wouldBreach(
          ledger,
          config.caps,
          { bytes: expected, files: 1, pages: 0 },
          'download',
        );
        if (!preflight.ok) {
          halt('budget', preflight.error);
          return;
        }

        deps.emit({ type: 'download/asset-started', at: deps.clock.now(), assetId: asset.id });

        const result = await downloadOne(deps, {
          asset,
          config,
          index,
          signal,
          requestOptions,
          ledger,
        });

        deps.repo.setDownloadState(asset.id, result, deps.clock.now());

        if (result.status === 'complete') {
          tally.downloaded += 1;
          ledger = creditFile(ledger, result.bytes);
          deps.repo.creditLedger(jobId, { files: 1, bytes: result.bytes }, deps.clock.now());
          deps.emit({
            type: 'download/asset-settled',
            at: deps.clock.now(),
            assetId: asset.id,
            outcome: 'complete',
          });
        } else if (result.status === 'skipped-duplicate') {
          tally.skippedDuplicate += 1;
          deps.emit({
            type: 'download/asset-settled',
            at: deps.clock.now(),
            assetId: asset.id,
            outcome: 'skipped-duplicate',
          });
        } else {
          tally.failed += 1;
          deps.emit({
            type: 'download/asset-settled',
            at: deps.clock.now(),
            assetId: asset.id,
            outcome: 'failed',
          });
          if (result.status === 'failed' && result.error.kind === 'cancelled') {
            halt('cancelled', null);
          }
        }

        const budget = checkBudget(ledger, config.caps, deps.clock.now(), 'download');
        if (!budget.ok) halt('budget', budget.error);
        if (signal.aborted) halt('cancelled', null);
      });
    }),
  );

  const counts = deps.repo.countAssets(jobId);
  const finishedAt = deps.clock.now();

  return ok({
    stopped: stop.reason,
    breach: stop.breach,
    ledger,
    summary: {
      outcome: stop.reason === 'cancelled' ? 'cancelled' : 'finished',
      downloaded: tally.downloaded,
      skippedDuplicate: tally.skippedDuplicate,
      filteredOut: counts.total - counts.included,
      failed: tally.failed,
      bytesWritten: ledger.bytesWritten - request.ledger.bytesWritten,
      durationMs: Math.max(0, finishedAt - startedAt),
      manifestPath: null,
      finishedAt,
    },
  });
};

interface SingleRequest {
  readonly asset: Asset;
  readonly config: JobConfig;
  readonly index: number;
  readonly signal: AbortSignal;
  readonly requestOptions: RequestOptions;
  readonly ledger: BudgetLedger;
}

const httpToDownloadError = (error: HttpError): DownloadError => {
  switch (error.kind) {
    case 'network':
      return { kind: 'network', message: error.message };
    case 'timeout':
      return { kind: 'timeout', afterMs: error.afterMs };
    case 'aborted':
      return { kind: 'cancelled' };
    case 'too-large':
      return { kind: 'too-large', limitBytes: error.limitBytes, observedBytes: 0 };
  }
};

const downloadOne = async (
  deps: DownloadDeps,
  request: SingleRequest,
): Promise<DownloadState> => {
  const { asset, config, signal } = request;

  // HLS manifests and provider embeds are yt-dlp's job, not a byte stream's.
  if (asset.acquisition.strategy !== 'direct') {
    return runMediaTool(deps, request, asset.acquisition);
  }

  const contentType = asset.probe.status === 'probed' ? asset.probe.contentType : null;

  // The hash is not known before the bytes are read, so the path is resolved
  // against the URL hash and rewritten once the content hash is final.
  const provisional = resolveOutputPath({
    outputDirectory: config.output.directory,
    template: config.output.pathTemplate,
    assetUrl: asset.url,
    pageUrl: asset.sources[0]?.pageUrl ?? asset.url,
    kind: asset.kind,
    sha256: urlDigest(asset.normalizedUrl),
    contentType,
    index: request.index,
    now: new Date(deps.clock.now()),
  });

  if (!provisional.ok) {
    return {
      status: 'failed',
      error: { kind: 'filesystem', message: `unsafe output path: ${provisional.error.kind}` },
      attempts: 1,
      failedAt: deps.clock.now(),
    };
  }

  const finalPath = provisional.value;
  const partPath = partialPathFor(finalPath);

  let attempt = 0;
  let lastError: DownloadError = { kind: 'network', message: 'not attempted' };

  while (attempt < config.download.maxAttempts) {
    attempt += 1;
    if (signal.aborted) return failure({ kind: 'cancelled' }, attempt, deps.clock.now());

    const attemptResult = await attemptDownload(deps, request, { finalPath, partPath, attempt });

    if (attemptResult.kind === 'settled') return attemptResult.state;

    lastError = attemptResult.error;
    const decision = decideRetry(
      attemptResult.status === null
        ? { error: attemptResult.httpError ?? { kind: 'network', message: 'unknown' } }
        : { status: attemptResult.status },
      attempt,
      config.download,
    );

    if (!decision.retry) break;

    const delay = nextDelay(
      attempt,
      config.download,
      attemptResult.retryAfter,
      deps.clock.now(),
      deps.random ?? Math.random,
    );
    try {
      await deps.clock.sleep(delay, signal);
    } catch {
      return failure({ kind: 'cancelled' }, attempt, deps.clock.now());
    }
  }

  return failure(lastError, attempt, deps.clock.now());
};

/**
 * yt-dlp picks the container itself, so the templated extension is dropped and
 * the tool is given a base path to complete.
 */
const runMediaTool = async (
  deps: DownloadDeps,
  request: SingleRequest,
  acquisition: Exclude<Asset['acquisition'], { strategy: 'direct' }>,
): Promise<DownloadState> => {
  const { asset, config } = request;

  if (deps.subprocess === undefined || deps.subprocess === null) {
    return failure(
      {
        kind: 'subprocess',
        tool: 'yt-dlp',
        exitCode: null,
        stderr: 'no subprocess runner was provided, so streams and embeds were skipped',
      },
      1,
      deps.clock.now(),
    );
  }

  const templated = resolveOutputPath({
    outputDirectory: config.output.directory,
    template: config.output.pathTemplate,
    assetUrl: asset.url,
    pageUrl: asset.sources[0]?.pageUrl ?? asset.url,
    kind: asset.kind,
    sha256: urlDigest(asset.normalizedUrl),
    contentType: null,
    index: request.index,
    now: new Date(deps.clock.now()),
  });

  if (!templated.ok) {
    return failure(
      { kind: 'filesystem', message: `unsafe output path: ${templated.error.kind}` },
      1,
      deps.clock.now(),
    );
  }

  const outputBase = templated.value.replace(/\.[^./\\]+$/, '');
  const headroom = remainingBudget(request.ledger, config.caps, deps.clock.now());

  return downloadWithYtDlp(
    {
      subprocess: deps.subprocess,
      files: deps.files,
      repo: deps.repo,
      clock: deps.clock,
      emit: deps.emit,
    },
    {
      jobId: asset.jobId,
      assetId: asset.id,
      acquisition,
      outputBase,
      config,
      signal: request.signal,
      remainingBytes: headroom.bytes > 0 ? headroom.bytes : null,
    },
  );
};

const failure = (error: DownloadError, attempts: number, at: number): DownloadState => ({
  status: 'failed',
  error,
  attempts,
  failedAt: at,
});

type AttemptResult =
  | { readonly kind: 'settled'; readonly state: DownloadState }
  | {
      readonly kind: 'retryable';
      readonly error: DownloadError;
      readonly status: number | null;
      readonly httpError?: HttpError;
      readonly retryAfter?: string;
    };

const attemptDownload = async (
  deps: DownloadDeps,
  request: SingleRequest,
  paths: { finalPath: string; partPath: string; attempt: number },
): Promise<AttemptResult> => {
  const { asset, config, signal, requestOptions } = request;

  const existing = config.download.resumePartials
    ? ((await deps.files.sizeOf(paths.partPath)) ?? 0)
    : 0;

  const hash = createHash('sha256');
  let written = 0;

  // Resuming means the bytes already on disk were never hashed by this process,
  // so they are replayed through the digest before the transfer continues.
  if (existing > 0) {
    try {
      for await (const chunk of deps.files.read(paths.partPath)) {
        hash.update(chunk);
        written += chunk.byteLength;
      }
    } catch {
      await deps.files.remove(paths.partPath);
      written = 0;
    }
  }

  const resumeFrom = written;
  const response = await deps.http.stream(asset.url, {
    ...requestOptions,
    ...(resumeFrom > 0 ? { range: { from: resumeFrom } } : {}),
  });

  if (!response.ok) {
    return {
      kind: 'retryable',
      error: httpToDownloadError(response.error),
      status: null,
      httpError: response.error,
    };
  }

  const { status, headers } = response.value;

  if (status === 416) {
    // The range is past the end: the partial is stale, not resumable.
    await deps.files.remove(paths.partPath);
    return {
      kind: 'retryable',
      error: { kind: 'http', status, message: 'stale partial discarded' },
      status: 500,
    };
  }

  if (status >= 400) {
    return {
      kind: status === 429 || status >= 500 ? 'retryable' : 'settled',
      ...(status === 429 || status >= 500
        ? {
            error: { kind: 'http', status, message: `HTTP ${status}` } as DownloadError,
            status,
            ...(headers.get('retry-after') === undefined
              ? {}
              : { retryAfter: headers.get('retry-after') as string }),
          }
        : {
            state: failure(
              { kind: 'http', status, message: `HTTP ${status}` },
              paths.attempt,
              deps.clock.now(),
            ),
          }),
    } as AttemptResult;
  }

  // A server that ignores Range answers 200 with the whole file; honouring the
  // resume offset then would corrupt the output.
  const resumed = status === 206 && resumeFrom > 0;
  if (resumeFrom > 0 && !resumed) {
    hash.destroy?.();
    await deps.files.remove(paths.partPath);
    return attemptDownloadFresh(deps, request, paths);
  }

  return streamToDisk(deps, request, paths, response.value.body, {
    hash,
    written: resumed ? written : 0,
    append: resumed,
    contentType: headers.get('content-type') ?? null,
    signal,
  });
};

const attemptDownloadFresh = async (
  deps: DownloadDeps,
  request: SingleRequest,
  paths: { finalPath: string; partPath: string; attempt: number },
): Promise<AttemptResult> => {
  const response = await deps.http.stream(request.asset.url, request.requestOptions);
  if (!response.ok) {
    return {
      kind: 'retryable',
      error: httpToDownloadError(response.error),
      status: null,
      httpError: response.error,
    };
  }
  if (response.value.status >= 400) {
    return {
      kind: 'retryable',
      error: { kind: 'http', status: response.value.status, message: 'retry after reset' },
      status: response.value.status,
    };
  }

  return streamToDisk(deps, request, paths, response.value.body, {
    hash: createHash('sha256'),
    written: 0,
    append: false,
    contentType: response.value.headers.get('content-type') ?? null,
    signal: request.signal,
  });
};

interface StreamState {
  readonly hash: ReturnType<typeof createHash>;
  readonly written: number;
  readonly append: boolean;
  readonly contentType: string | null;
  readonly signal: AbortSignal;
}

const streamToDisk = async (
  deps: DownloadDeps,
  request: SingleRequest,
  paths: { finalPath: string; partPath: string; attempt: number },
  body: AsyncIterable<Uint8Array>,
  state: StreamState,
): Promise<AttemptResult> => {
  const opened = await deps.files.openWrite(paths.partPath, state.append ? 'append' : 'create');
  if (!opened.ok) {
    return {
      kind: 'settled',
      state: failure(
        { kind: 'filesystem', message: `${opened.error.kind} at ${opened.error.path}` },
        paths.attempt,
        deps.clock.now(),
      ),
    };
  }

  const handle: WriteHandle = opened.value;
  let written = state.written;
  let sinceEmit = 0;

  try {
    for await (const chunk of body) {
      if (state.signal.aborted) {
        return { kind: 'settled', state: failure({ kind: 'cancelled' }, paths.attempt, deps.clock.now()) };
      }

      const result = await handle.write(chunk);
      if (!result.ok) {
        return {
          kind: 'settled',
          state: failure(
            { kind: 'filesystem', message: result.error.kind },
            paths.attempt,
            deps.clock.now(),
          ),
        };
      }

      state.hash.update(chunk);
      written += chunk.byteLength;
      sinceEmit += chunk.byteLength;

      if (sinceEmit >= PROGRESS_INTERVAL_BYTES) {
        deps.emit({
          type: 'download/asset-progress',
          at: deps.clock.now(),
          assetId: request.asset.id,
          deltaBytes: sinceEmit,
          bytesDownloaded: written,
          totalBytes:
            request.asset.probe.status === 'probed' ? request.asset.probe.contentLength : null,
        });
        sinceEmit = 0;
      }
    }
  } catch (cause) {
    return {
      kind: 'retryable',
      error: { kind: 'network', message: cause instanceof Error ? cause.message : 'stream failed' },
      status: null,
      httpError: { kind: 'network', message: 'stream failed' },
    };
  } finally {
    await handle.close();
  }

  if (sinceEmit > 0) {
    deps.emit({
      type: 'download/asset-progress',
      at: deps.clock.now(),
      assetId: request.asset.id,
      deltaBytes: sinceEmit,
      bytesDownloaded: written,
      totalBytes: request.asset.probe.status === 'probed' ? request.asset.probe.contentLength : null,
    });
  }

  const sha256 = state.hash.digest('hex');

  // Identical bytes under a different URL: recorded as a duplicate rather than
  // written twice. Common on sites that serve the same asset from several paths.
  const duplicate = deps.repo.findByHash(request.asset.jobId, sha256);
  if (duplicate !== null && duplicate.id !== request.asset.id) {
    await deps.files.remove(paths.partPath);
    return {
      kind: 'settled',
      state: {
        status: 'skipped-duplicate',
        sha256,
        duplicateOf: duplicate.id,
        localPath: duplicate.localPath,
      },
    };
  }

  const finalPath = rewriteHashToken(
    deps,
    request,
    paths.finalPath,
    sha256,
    state.contentType,
  );

  const moved = await deps.files.move(paths.partPath, finalPath);
  if (!moved.ok) {
    return {
      kind: 'settled',
      state: failure(
        { kind: 'filesystem', message: `${moved.error.kind} at ${moved.error.path}` },
        paths.attempt,
        deps.clock.now(),
      ),
    };
  }

  return {
    kind: 'settled',
    state: {
      status: 'complete',
      localPath: finalPath,
      bytes: written,
      sha256,
      completedAt: deps.clock.now(),
    },
  };
};

/** Recomputes the path now that the real content hash is known. */
const rewriteHashToken = (
  deps: DownloadDeps,
  request: SingleRequest,
  provisional: string,
  sha256: string,
  contentType: string | null,
): string => {
  if (!request.config.output.pathTemplate.includes('{hash8}')) return provisional;

  const resolved = resolveOutputPath({
    outputDirectory: request.config.output.directory,
    template: request.config.output.pathTemplate,
    assetUrl: request.asset.url,
    pageUrl: request.asset.sources[0]?.pageUrl ?? request.asset.url,
    kind: request.asset.kind,
    sha256,
    contentType:
      contentType ?? (request.asset.probe.status === 'probed' ? request.asset.probe.contentType : null),
    index: request.index,
    now: new Date(deps.clock.now()),
  });

  return resolved.ok ? resolved.value : provisional;
};

const urlDigest = (url: string): string => createHash('sha256').update(url).digest('hex');

export { acceptsRanges };
