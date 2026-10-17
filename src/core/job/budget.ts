import { z } from 'zod';
import type { BudgetCaps } from '../config';
import { epochMsSchema } from '../media';
import { err, type Result, unit } from '../result';

export const capKindSchema = z.enum(['total-bytes', 'file-count', 'pages-crawled', 'duration']);
export type CapKind = z.infer<typeof capKindSchema>;

export const budgetBreachSchema = z.strictObject({
  cap: capKindSchema,
  limit: z.number().nonnegative(),
  observed: z.number().nonnegative(),
});
export type BudgetBreach = z.infer<typeof budgetBreachSchema>;

export const budgetLedgerSchema = z.strictObject({
  pagesCrawled: z.number().int().nonnegative(),
  filesWritten: z.number().int().nonnegative(),
  bytesWritten: z.number().int().nonnegative(),
  startedAt: epochMsSchema,
});
export type BudgetLedger = z.infer<typeof budgetLedgerSchema>;

export const emptyLedger = (startedAt: number): BudgetLedger => ({
  pagesCrawled: 0,
  filesWritten: 0,
  bytesWritten: 0,
  startedAt,
});

export const creditPage = (ledger: BudgetLedger): BudgetLedger => ({
  ...ledger,
  pagesCrawled: ledger.pagesCrawled + 1,
});

export const creditFile = (ledger: BudgetLedger, bytes: number): BudgetLedger => ({
  ...ledger,
  filesWritten: ledger.filesWritten + 1,
  bytesWritten: ledger.bytesWritten + bytes,
});

export const creditBytes = (ledger: BudgetLedger, bytes: number): BudgetLedger => ({
  ...ledger,
  bytesWritten: ledger.bytesWritten + bytes,
});

/**
 * Caps belong to the phase that spends them. A page limit constrains discovery
 * and says nothing about writing files; a byte limit is the reverse. Checking
 * all four in both phases means a crawl that stopped at its page cap would
 * also refuse to download anything it found.
 */
export type BudgetPhase = 'crawl' | 'download' | 'any';

const APPLIES: Readonly<Record<CapKind, ReadonlySet<BudgetPhase>>> = {
  'pages-crawled': new Set<BudgetPhase>(['crawl', 'any']),
  'total-bytes': new Set<BudgetPhase>(['download', 'any']),
  'file-count': new Set<BudgetPhase>(['download', 'any']),
  // Wall-clock time is spent by the job as a whole.
  duration: new Set<BudgetPhase>(['crawl', 'download', 'any']),
};

const inScope = (cap: CapKind, phase: BudgetPhase): boolean =>
  phase === 'any' || APPLIES[cap].has(phase);

/**
 * Called on every page fetch and every download chunk, not once at startup.
 * Cheap enough to run in the hot path: four comparisons.
 */
export const checkBudget = (
  ledger: BudgetLedger,
  caps: BudgetCaps,
  now: number,
  phase: BudgetPhase = 'any',
): Result<null, BudgetBreach> => {
  if (inScope('total-bytes', phase) && ledger.bytesWritten > caps.maxTotalBytes) {
    return err({ cap: 'total-bytes', limit: caps.maxTotalBytes, observed: ledger.bytesWritten });
  }
  if (inScope('file-count', phase) && ledger.filesWritten > caps.maxFileCount) {
    return err({ cap: 'file-count', limit: caps.maxFileCount, observed: ledger.filesWritten });
  }
  if (inScope('pages-crawled', phase) && ledger.pagesCrawled > caps.maxPagesCrawled) {
    return err({ cap: 'pages-crawled', limit: caps.maxPagesCrawled, observed: ledger.pagesCrawled });
  }
  const elapsed = Math.max(0, now - ledger.startedAt);
  if (inScope('duration', phase) && elapsed > caps.maxDurationMs) {
    return err({ cap: 'duration', limit: caps.maxDurationMs, observed: elapsed });
  }
  return unit;
};

/**
 * Pre-flight check: would admitting this much more work breach a cap? Used to
 * decline starting a download rather than aborting one halfway through.
 */
export const wouldBreach = (
  ledger: BudgetLedger,
  caps: BudgetCaps,
  additional: { readonly bytes: number; readonly files: number; readonly pages: number },
  phase: BudgetPhase = 'any',
): Result<null, BudgetBreach> => {
  const projected: BudgetLedger = {
    ...ledger,
    bytesWritten: ledger.bytesWritten + additional.bytes,
    filesWritten: ledger.filesWritten + additional.files,
    pagesCrawled: ledger.pagesCrawled + additional.pages,
  };
  return checkBudget(projected, caps, ledger.startedAt, phase);
};

export const remainingBudget = (
  ledger: BudgetLedger,
  caps: BudgetCaps,
  now: number,
): {
  readonly bytes: number;
  readonly files: number;
  readonly pages: number;
  readonly durationMs: number;
} => ({
  bytes: Math.max(0, caps.maxTotalBytes - ledger.bytesWritten),
  files: Math.max(0, caps.maxFileCount - ledger.filesWritten),
  pages: Math.max(0, caps.maxPagesCrawled - ledger.pagesCrawled),
  durationMs: Math.max(0, caps.maxDurationMs - Math.max(0, now - ledger.startedAt)),
});

export const describeBreach = (breach: BudgetBreach): string => {
  switch (breach.cap) {
    case 'total-bytes':
      return `total download size reached ${breach.observed} bytes (cap ${breach.limit})`;
    case 'file-count':
      return `file count reached ${breach.observed} (cap ${breach.limit})`;
    case 'pages-crawled':
      return `pages crawled reached ${breach.observed} (cap ${breach.limit})`;
    case 'duration':
      return `run time reached ${Math.round(breach.observed / 1000)}s (cap ${Math.round(breach.limit / 1000)}s)`;
  }
};
