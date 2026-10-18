import { describeBreach } from './budget';
import type { JobState } from './state';

export type JobPhase = 'setup' | 'discovery' | 'review' | 'download' | 'done';

export const phaseOfState = (state: JobState): JobPhase => {
  switch (state.status) {
    case 'idle':
      return 'setup';
    case 'crawling':
      return 'discovery';
    case 'awaiting-selection':
      return 'review';
    case 'downloading':
      return 'download';
    case 'paused':
      return state.suspended.from === 'crawling' ? 'discovery' : 'download';
    case 'complete':
    case 'failed':
      return 'done';
  }
};

export const isTerminal = (state: JobState): boolean =>
  state.status === 'complete' || state.status === 'failed';

export const isRunning = (state: JobState): boolean =>
  state.status === 'crawling' || state.status === 'downloading';

export const isResumable = (state: JobState): boolean => state.status === 'paused';

/** 0–1, or null when the total is not yet known. */
export const downloadFraction = (state: JobState): number | null => {
  const progress =
    state.status === 'downloading'
      ? state.download
      : state.status === 'paused' && state.suspended.from === 'downloading'
        ? state.suspended.download
        : null;
  if (progress === null) return null;
  const settled = progress.completed + progress.failed + progress.skippedDuplicate;
  const total = settled + progress.inFlight + progress.queued;
  return total === 0 ? null : settled / total;
};

/**
 * A single sentence describing the state. The crawl and download views feed
 * this to an aria-live region so progress is announced without relying on the
 * visual counters.
 */
export const describeState = (state: JobState): string => {
  switch (state.status) {
    case 'idle':
      return 'Ready. Enter a URL to start discovery.';
    case 'crawling':
      return `Crawling: ${state.crawl.pagesVisited} pages visited, ${state.crawl.pagesQueued} queued, ${state.crawl.uniqueAssets} assets found.`;
    case 'awaiting-selection':
      return `Discovery finished: ${state.eligible} assets match the current filters, ${state.filteredOut} filtered out, ${state.selected} selected.`;
    case 'downloading':
      return `Downloading: ${state.download.completed} of ${state.download.completed + state.download.failed + state.download.skippedDuplicate + state.download.inFlight + state.download.queued} finished, ${state.download.failed} failed.`;
    case 'paused': {
      const why =
        state.reason.kind === 'budget'
          ? `budget cap reached — ${describeBreach(state.reason.breach)}`
          : state.reason.kind === 'interrupted'
            ? state.reason.note
            : 'paused by you';
      return `Paused during ${state.suspended.from}: ${why}.`;
    }
    case 'complete':
      return `${state.summary.outcome === 'cancelled' ? 'Cancelled' : 'Complete'}: ${state.summary.downloaded} downloaded, ${state.summary.skippedDuplicate} duplicates skipped, ${state.summary.filteredOut} filtered out, ${state.summary.failed} failed.`;
    case 'failed':
      return `Failed during ${state.phase}: ${state.error.kind}.`;
  }
};
