import { err, ok, type Result } from '../result';
import type { JobEvent, JobEventType } from './events';
import {
  type CrawlSummary,
  crawlSummaryFrom,
  emptyCrawlProgress,
  emptyDownloadProgress,
  idleState,
  type JobState,
  type JobStatus,
} from './state';

export type TransitionError =
  | { readonly kind: 'invalid-transition'; readonly from: JobStatus; readonly event: JobEventType }
  | { readonly kind: 'invariant-violated'; readonly message: string };

const invalid = (state: JobState, event: JobEvent): Result<JobState, TransitionError> =>
  err({ kind: 'invalid-transition', from: state.status, event: event.type });

const invariant = (message: string): Result<JobState, TransitionError> =>
  err({ kind: 'invariant-violated', message });

const isTerminalStatus = (status: JobStatus): boolean =>
  status === 'complete' || status === 'failed';

/** The best available crawl summary for a state, synthesised if mid-crawl. */
const crawlSummaryOf = (state: JobState, at: number): CrawlSummary | null => {
  switch (state.status) {
    case 'crawling':
      return crawlSummaryFrom(state.crawl, state.startedAt, at, null);
    case 'awaiting-selection':
    case 'downloading':
    case 'complete':
      return state.crawl;
    case 'paused':
      return state.suspended.from === 'crawling'
        ? crawlSummaryFrom(state.suspended.crawl, state.startedAt, at, null)
        : state.suspended.crawl;
    case 'idle':
    case 'failed':
      return null;
  }
};

const startedAtOf = (state: JobState): number | null => {
  switch (state.status) {
    case 'idle':
      return null;
    case 'failed':
      return state.startedAt;
    default:
      return state.startedAt;
  }
};

const phaseOf = (status: JobStatus): 'starting' | 'crawling' | 'downloading' => {
  if (status === 'crawling') return 'crawling';
  if (status === 'downloading') return 'downloading';
  return 'starting';
};

/**
 * The single transition function. Invalid transitions are values, not throws:
 * an out-of-order SSE replay or a stale UI action should be reported, not
 * crash the stream.
 */
export const reduce = (state: JobState, event: JobEvent): Result<JobState, TransitionError> => {
  switch (event.type) {
    case 'crawl/started': {
      if (state.status !== 'idle') return invalid(state, event);
      return ok({ status: 'crawling', crawl: emptyCrawlProgress(), startedAt: event.at });
    }

    case 'crawl/page-visited': {
      if (state.status !== 'crawling') return invalid(state, event);
      return ok({
        ...state,
        crawl: {
          ...state.crawl,
          pagesVisited: state.crawl.pagesVisited + 1,
          pagesQueued: event.queueDepth,
          currentUrl: event.url,
        },
      });
    }

    case 'crawl/page-failed': {
      if (state.status !== 'crawling') return invalid(state, event);
      return ok({
        ...state,
        crawl: {
          ...state.crawl,
          pagesFailed: state.crawl.pagesFailed + 1,
          pagesQueued: event.queueDepth,
        },
      });
    }

    case 'crawl/notice': {
      // Carries information for the log without changing anything.
      if (state.status !== 'crawling') return invalid(state, event);
      return ok(state);
    }

    case 'crawl/page-skipped': {
      if (state.status !== 'crawling') return invalid(state, event);
      return ok({
        ...state,
        crawl: {
          ...state.crawl,
          pagesSkipped: state.crawl.pagesSkipped + 1,
          pagesQueued: event.queueDepth,
        },
      });
    }

    case 'crawl/assets-discovered': {
      if (state.status !== 'crawling') return invalid(state, event);
      return ok({
        ...state,
        crawl: {
          ...state.crawl,
          assetsDiscovered: state.crawl.assetsDiscovered + event.found,
          uniqueAssets: state.crawl.uniqueAssets + event.unique,
          bytesProjected: state.crawl.bytesProjected + event.bytesProjectedDelta,
        },
      });
    }

    case 'crawl/finished': {
      if (state.status !== 'crawling') return invalid(state, event);
      return ok({
        status: 'awaiting-selection',
        crawl: event.summary,
        eligible: event.summary.uniqueAssets,
        filteredOut: 0,
        selected: 0,
        startedAt: state.startedAt,
      });
    }

    case 'probe/progress': {
      // Measurement changes asset rows, never job state. The event exists so
      // the review grid knows to refetch; the state it derives is unaffected.
      if (state.status !== 'awaiting-selection') return invalid(state, event);
      return ok(state);
    }

    case 'filters/applied': {
      if (state.status !== 'awaiting-selection') return invalid(state, event);
      return ok({
        ...state,
        eligible: event.eligible,
        filteredOut: event.filteredOut,
        // Filtering can remove already-selected items; the count cannot exceed
        // what is still eligible.
        selected: Math.min(state.selected, event.eligible),
      });
    }

    case 'selection/changed': {
      if (state.status !== 'awaiting-selection') return invalid(state, event);
      if (event.selected > state.eligible) {
        return invariant(`selected ${event.selected} exceeds eligible ${state.eligible}`);
      }
      return ok({ ...state, selected: event.selected });
    }

    case 'selection/submitted': {
      if (state.status !== 'awaiting-selection') return invalid(state, event);
      if (event.selected > state.eligible) {
        return invariant(`selected ${event.selected} exceeds eligible ${state.eligible}`);
      }
      return ok({
        status: 'downloading',
        crawl: state.crawl,
        download: emptyDownloadProgress(event.selected, event.bytesExpected),
        startedAt: state.startedAt,
      });
    }

    case 'download/asset-started': {
      if (state.status !== 'downloading') return invalid(state, event);
      if (state.download.queued === 0) return invariant('started a download with an empty queue');
      return ok({
        ...state,
        download: {
          ...state.download,
          queued: state.download.queued - 1,
          inFlight: state.download.inFlight + 1,
        },
      });
    }

    case 'download/asset-progress': {
      if (state.status !== 'downloading') return invalid(state, event);
      return ok({
        ...state,
        download: {
          ...state.download,
          bytesWritten: state.download.bytesWritten + event.deltaBytes,
        },
      });
    }

    case 'download/asset-settled': {
      if (state.status !== 'downloading') return invalid(state, event);
      const { download } = state;
      return ok({
        ...state,
        download: {
          ...download,
          inFlight: Math.max(0, download.inFlight - 1),
          completed: download.completed + (event.outcome === 'complete' ? 1 : 0),
          failed: download.failed + (event.outcome === 'failed' ? 1 : 0),
          skippedDuplicate:
            download.skippedDuplicate + (event.outcome === 'skipped-duplicate' ? 1 : 0),
        },
      });
    }

    case 'download/finished': {
      if (state.status !== 'downloading') return invalid(state, event);
      return ok({
        status: 'complete',
        crawl: state.crawl,
        summary: event.summary,
        startedAt: state.startedAt,
      });
    }

    case 'download/retry-requested': {
      if (state.status !== 'complete') return invalid(state, event);
      return ok({
        status: 'downloading',
        crawl: state.crawl,
        download: emptyDownloadProgress(event.assetIds.length, event.bytesExpected),
        startedAt: state.startedAt,
      });
    }

    case 'budget/breached':
    case 'job/paused': {
      const reason =
        event.type === 'budget/breached'
          ? ({ kind: 'budget', breach: event.breach } as const)
          : ({ kind: 'user' } as const);

      if (state.status === 'crawling') {
        return ok({
          status: 'paused',
          reason,
          suspended: { from: 'crawling', crawl: state.crawl },
          startedAt: state.startedAt,
          pausedAt: event.at,
        });
      }
      if (state.status === 'downloading') {
        return ok({
          status: 'paused',
          reason,
          suspended: { from: 'downloading', crawl: state.crawl, download: state.download },
          startedAt: state.startedAt,
          pausedAt: event.at,
        });
      }
      return invalid(state, event);
    }

    case 'job/resumed': {
      if (state.status !== 'paused') return invalid(state, event);
      if (state.suspended.from === 'crawling') {
        return ok({
          status: 'crawling',
          crawl: state.suspended.crawl,
          startedAt: state.startedAt,
        });
      }
      return ok({
        status: 'downloading',
        crawl: state.suspended.crawl,
        download: state.suspended.download,
        startedAt: state.startedAt,
      });
    }

    case 'job/cancelled': {
      if (isTerminalStatus(state.status) || state.status === 'idle') return invalid(state, event);
      const crawl = crawlSummaryOf(state, event.at);
      if (crawl === null) return invariant('cannot cancel a job with no crawl summary');
      const startedAt = startedAtOf(state);
      if (startedAt === null) return invariant('cannot cancel a job that never started');
      return ok({ status: 'complete', crawl, summary: event.summary, startedAt });
    }

    case 'job/failed': {
      if (isTerminalStatus(state.status)) return invalid(state, event);
      return ok({
        status: 'failed',
        error: event.error,
        phase: phaseOf(state.status),
        startedAt: startedAtOf(state),
        failedAt: event.at,
      });
    }
  }
};

/** Replay a log onto a base state. Used for SSE catch-up and rebuild-from-log. */
export const reduceAll = (
  state: JobState,
  events: readonly JobEvent[],
): Result<JobState, TransitionError> => {
  let current = state;
  for (const event of events) {
    const next = reduce(current, event);
    if (!next.ok) return next;
    current = next.value;
  }
  return ok(current);
};

/** Drops events the current state cannot accept. For lossy live streams only. */
export const reduceLenient = (
  state: JobState,
  events: readonly JobEvent[],
): { readonly state: JobState; readonly rejected: TransitionError[] } => {
  let current = state;
  const rejected: TransitionError[] = [];
  for (const event of events) {
    const next = reduce(current, event);
    if (next.ok) current = next.value;
    else rejected.push(next.error);
  }
  return { state: current, rejected };
};

/**
 * Applied on server start. A job persisted as `crawling` or `downloading` had
 * its process killed, so it is parked in `paused` and waits for an explicit
 * resume rather than silently restarting work the user may not want repeated.
 */
export const rehydrate = (state: JobState, at: number): JobState => {
  const note = 'server restarted while the job was running';
  if (state.status === 'crawling') {
    return {
      status: 'paused',
      reason: { kind: 'interrupted', note },
      suspended: { from: 'crawling', crawl: { ...state.crawl, currentUrl: null } },
      startedAt: state.startedAt,
      pausedAt: at,
    };
  }
  if (state.status === 'downloading') {
    return {
      status: 'paused',
      reason: { kind: 'interrupted', note },
      suspended: {
        from: 'downloading',
        crawl: state.crawl,
        // In-flight downloads did not survive; they return to the queue.
        download: {
          ...state.download,
          queued: state.download.queued + state.download.inFlight,
          inFlight: 0,
        },
      },
      startedAt: state.startedAt,
      pausedAt: at,
    };
  }
  return state;
};

export const canAccept = (state: JobState, event: JobEvent): boolean => reduce(state, event).ok;

export { idleState };
