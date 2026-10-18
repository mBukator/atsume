import { z } from 'zod';
import { assetIdSchema } from '../ids';
import { epochMsSchema } from '../media';
import { budgetBreachSchema } from './budget';
import { crawlSummarySchema, jobErrorSchema, jobSummarySchema } from './state';

/**
 * Events are the only way the state changes. They are also the SSE payload, so
 * a client that reconnects can replay from a sequence number and rebuild the
 * same state the server holds.
 */
export const jobEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('crawl/started'), at: epochMsSchema }),
  z.strictObject({
    type: z.literal('crawl/page-visited'),
    at: epochMsSchema,
    url: z.string(),
    depth: z.number().int().nonnegative(),
    queueDepth: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal('crawl/page-failed'),
    at: epochMsSchema,
    url: z.string(),
    reason: z.string(),
    queueDepth: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal('crawl/notice'),
    at: epochMsSchema,
    message: z.string(),
  }),
  z.strictObject({
    type: z.literal('crawl/page-skipped'),
    at: epochMsSchema,
    url: z.string(),
    /** robots, scope, redirect, content type — why it was passed over. */
    reason: z.string(),
    queueDepth: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal('crawl/assets-discovered'),
    at: epochMsSchema,
    /** Raw candidate count before dedupe, and the net new unique assets. */
    found: z.number().int().nonnegative(),
    unique: z.number().int().nonnegative(),
    bytesProjectedDelta: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal('crawl/finished'),
    at: epochMsSchema,
    summary: crawlSummarySchema,
  }),
  z.strictObject({
    /**
     * Measurement runs after the phase flips to review, so the grid opens
     * before any asset has a size. This is what tells it to come back.
     */
    type: z.literal('probe/progress'),
    at: epochMsSchema,
    probed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal('filters/applied'),
    at: epochMsSchema,
    eligible: z.number().int().nonnegative(),
    filteredOut: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal('selection/changed'),
    at: epochMsSchema,
    selected: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal('selection/submitted'),
    at: epochMsSchema,
    selected: z.number().int().positive(),
    bytesExpected: z.number().int().nonnegative().nullable(),
  }),
  z.strictObject({
    type: z.literal('download/asset-started'),
    at: epochMsSchema,
    assetId: assetIdSchema,
  }),
  z.strictObject({
    type: z.literal('download/asset-progress'),
    at: epochMsSchema,
    assetId: assetIdSchema,
    /** Bytes newly written since the previous event for this asset. */
    deltaBytes: z.number().int().nonnegative(),
    bytesDownloaded: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative().nullable(),
  }),
  z.strictObject({
    type: z.literal('download/asset-settled'),
    at: epochMsSchema,
    assetId: assetIdSchema,
    outcome: z.enum(['complete', 'failed', 'skipped-duplicate']),
  }),
  z.strictObject({
    type: z.literal('download/finished'),
    at: epochMsSchema,
    summary: jobSummarySchema,
  }),
  z.strictObject({
    type: z.literal('download/retry-requested'),
    at: epochMsSchema,
    assetIds: z.array(assetIdSchema).min(1),
    bytesExpected: z.number().int().nonnegative().nullable(),
  }),
  z.strictObject({
    type: z.literal('budget/breached'),
    at: epochMsSchema,
    breach: budgetBreachSchema,
  }),
  z.strictObject({ type: z.literal('job/paused'), at: epochMsSchema }),
  z.strictObject({ type: z.literal('job/resumed'), at: epochMsSchema }),
  z.strictObject({
    type: z.literal('job/cancelled'),
    at: epochMsSchema,
    summary: jobSummarySchema,
  }),
  z.strictObject({ type: z.literal('job/failed'), at: epochMsSchema, error: jobErrorSchema }),
]);
export type JobEvent = z.infer<typeof jobEventSchema>;
export type JobEventType = JobEvent['type'];

/**
 * High-frequency events are broadcast but not written to SQLite. A large job
 * emits tens of thousands of progress ticks; persisting them would dominate
 * the event log and slow replay for no benefit, because per-asset byte counts
 * are already durable on the asset row.
 */
const EPHEMERAL: ReadonlySet<JobEventType> = new Set<JobEventType>([
  'crawl/page-visited',
  'crawl/page-failed',
  'crawl/page-skipped',
  'crawl/notice',
  'download/asset-started',
  'download/asset-progress',
  'probe/progress',
  'selection/changed',
]);

export const isDurable = (event: JobEvent): boolean => !EPHEMERAL.has(event.type);
