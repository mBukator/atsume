import { z } from 'zod';
import { epochMsSchema } from '../media';
import { budgetBreachSchema, capKindSchema } from './budget';

/**
 * State carries runtime facts only. Configuration lives on the job record, not
 * in the state, so that a state snapshot stays small enough to write on every
 * transition and there is exactly one place where filter settings live.
 */

export const crawlProgressSchema = z.strictObject({
  pagesVisited: z.number().int().nonnegative(),
  pagesQueued: z.number().int().nonnegative(),
  pagesFailed: z.number().int().nonnegative(),
  // Defaulted so state written before this field existed still parses.
  pagesSkipped: z.number().int().nonnegative().default(0),
  assetsDiscovered: z.number().int().nonnegative(),
  uniqueAssets: z.number().int().nonnegative(),
  /** Sum of known `Content-Length` values so far; not a promise. */
  bytesProjected: z.number().int().nonnegative(),
  currentUrl: z.string().nullable(),
});
export type CrawlProgress = z.infer<typeof crawlProgressSchema>;

export const emptyCrawlProgress = (): CrawlProgress => ({
  pagesVisited: 0,
  pagesQueued: 0,
  pagesFailed: 0,
  pagesSkipped: 0,
  assetsDiscovered: 0,
  uniqueAssets: 0,
  bytesProjected: 0,
  currentUrl: null,
});

export const crawlSummarySchema = z.strictObject({
  pagesVisited: z.number().int().nonnegative(),
  pagesFailed: z.number().int().nonnegative(),
  pagesSkipped: z.number().int().nonnegative().default(0),
  uniqueAssets: z.number().int().nonnegative(),
  bytesProjected: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  /** Non-null when discovery stopped early because a cap was reached. */
  truncatedBy: capKindSchema.nullable(),
  finishedAt: epochMsSchema,
});
export type CrawlSummary = z.infer<typeof crawlSummarySchema>;

export const downloadProgressSchema = z.strictObject({
  queued: z.number().int().nonnegative(),
  inFlight: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skippedDuplicate: z.number().int().nonnegative(),
  bytesWritten: z.number().int().nonnegative(),
  bytesExpected: z.number().int().nonnegative().nullable(),
});
export type DownloadProgress = z.infer<typeof downloadProgressSchema>;

export const emptyDownloadProgress = (
  queued: number,
  bytesExpected: number | null,
): DownloadProgress => ({
  queued,
  inFlight: 0,
  completed: 0,
  failed: 0,
  skippedDuplicate: 0,
  bytesWritten: 0,
  bytesExpected,
});

export const jobSummarySchema = z.strictObject({
  outcome: z.enum(['finished', 'cancelled']),
  downloaded: z.number().int().nonnegative(),
  skippedDuplicate: z.number().int().nonnegative(),
  filteredOut: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  bytesWritten: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  manifestPath: z.string().nullable(),
  finishedAt: epochMsSchema,
});
export type JobSummary = z.infer<typeof jobSummarySchema>;

export const pauseReasonSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({ kind: z.literal('budget'), breach: budgetBreachSchema }),
  /** The process died mid-run; rehydration parks the job here. */
  z.strictObject({ kind: z.literal('interrupted'), note: z.string() }),
]);
export type PauseReason = z.infer<typeof pauseReasonSchema>;

export const jobErrorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('seed-unreachable'), url: z.string(), message: z.string() }),
  z.strictObject({
    kind: z.literal('robots-denied'),
    url: z.string(),
    // "the rules forbid this" and "the rules could not be read" are different
    // situations for the user, and only one of them is worth retrying.
    reason: z.enum(['disallowed', 'robots-unavailable']),
  }),
  z.strictObject({ kind: z.literal('renderer-unavailable'), message: z.string() }),
  z.strictObject({ kind: z.literal('output-unwritable'), path: z.string(), message: z.string() }),
  z.strictObject({ kind: z.literal('internal'), message: z.string() }),
]);
export type JobError = z.infer<typeof jobErrorSchema>;

/**
 * A paused job has to remember enough to restart the phase it was in. Nesting
 * the discriminator means `from: 'crawling'` cannot carry download progress and
 * `from: 'downloading'` cannot omit it.
 */
export const suspendedPhaseSchema = z.discriminatedUnion('from', [
  z.strictObject({ from: z.literal('crawling'), crawl: crawlProgressSchema }),
  z.strictObject({
    from: z.literal('downloading'),
    crawl: crawlSummarySchema,
    download: downloadProgressSchema,
  }),
]);
export type SuspendedPhase = z.infer<typeof suspendedPhaseSchema>;

export const jobStateSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('idle') }),
  z.strictObject({
    status: z.literal('crawling'),
    crawl: crawlProgressSchema,
    startedAt: epochMsSchema,
  }),
  z.strictObject({
    status: z.literal('awaiting-selection'),
    crawl: crawlSummarySchema,
    /** Counts after the current filter settings; recomputed without re-crawling. */
    eligible: z.number().int().nonnegative(),
    filteredOut: z.number().int().nonnegative(),
    selected: z.number().int().nonnegative(),
    startedAt: epochMsSchema,
  }),
  z.strictObject({
    status: z.literal('downloading'),
    crawl: crawlSummarySchema,
    download: downloadProgressSchema,
    startedAt: epochMsSchema,
  }),
  z.strictObject({
    status: z.literal('paused'),
    reason: pauseReasonSchema,
    suspended: suspendedPhaseSchema,
    startedAt: epochMsSchema,
    pausedAt: epochMsSchema,
  }),
  z.strictObject({
    status: z.literal('complete'),
    crawl: crawlSummarySchema,
    summary: jobSummarySchema,
    startedAt: epochMsSchema,
  }),
  z.strictObject({
    status: z.literal('failed'),
    error: jobErrorSchema,
    phase: z.enum(['starting', 'crawling', 'downloading']),
    startedAt: epochMsSchema.nullable(),
    failedAt: epochMsSchema,
  }),
]);
export type JobState = z.infer<typeof jobStateSchema>;
export type JobStatus = JobState['status'];

export const idleState: JobState = { status: 'idle' };

export const crawlSummaryFrom = (
  progress: CrawlProgress,
  startedAt: number,
  finishedAt: number,
  truncatedBy: CrawlSummary['truncatedBy'],
): CrawlSummary => ({
  pagesVisited: progress.pagesVisited,
  pagesFailed: progress.pagesFailed,
  pagesSkipped: progress.pagesSkipped,
  uniqueAssets: progress.uniqueAssets,
  bytesProjected: progress.bytesProjected,
  durationMs: Math.max(0, finishedAt - startedAt),
  truncatedBy,
  finishedAt,
});
