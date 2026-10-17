import { describe, expect, it } from 'vitest';
import { budgetCapsSchema } from '../config';
import {
  checkBudget,
  creditFile,
  creditPage,
  emptyLedger,
  remainingBudget,
  wouldBreach,
} from './budget';

const T0 = 1_700_000_000_000;

const caps = budgetCapsSchema.parse({
  maxTotalBytes: 1_000,
  maxFileCount: 3,
  maxPagesCrawled: 2,
  maxDurationMs: 10_000,
});

describe('checkBudget', () => {
  it('passes an empty ledger', () => {
    expect(checkBudget(emptyLedger(T0), caps, T0).ok).toBe(true);
  });

  it('allows a ledger sitting exactly on every limit', () => {
    const ledger = { pagesCrawled: 2, filesWritten: 3, bytesWritten: 1_000, startedAt: T0 };
    expect(checkBudget(ledger, caps, T0 + 10_000).ok).toBe(true);
  });

  it.each([
    ['total-bytes', { bytesWritten: 1_001 }, T0],
    ['file-count', { filesWritten: 4 }, T0],
    ['pages-crawled', { pagesCrawled: 3 }, T0],
    ['duration', {}, T0 + 10_001],
  ] as const)('trips on %s', (cap, overrides, now) => {
    const result = checkBudget({ ...emptyLedger(T0), ...overrides }, caps, now);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.cap).toBe(cap);
  });

  it('reports the observed value alongside the limit', () => {
    const result = checkBudget({ ...emptyLedger(T0), bytesWritten: 2_500 }, caps, T0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ cap: 'total-bytes', limit: 1_000, observed: 2_500 });
  });

  it('does not report negative elapsed time from a clock that went backwards', () => {
    expect(checkBudget(emptyLedger(T0), caps, T0 - 5_000).ok).toBe(true);
  });
});

describe('wouldBreach', () => {
  it('declines work that would push past a cap', () => {
    const ledger = creditFile(emptyLedger(T0), 900);
    const result = wouldBreach(ledger, caps, { bytes: 200, files: 1, pages: 0 });
    expect(result.ok).toBe(false);
  });

  it('admits work that fits', () => {
    const ledger = creditFile(emptyLedger(T0), 500);
    expect(wouldBreach(ledger, caps, { bytes: 400, files: 1, pages: 0 }).ok).toBe(true);
  });
});

describe('ledger arithmetic', () => {
  it('credits pages and files without mutating the input', () => {
    const start = emptyLedger(T0);
    const afterPage = creditPage(start);
    const afterFile = creditFile(afterPage, 250);

    expect(start).toEqual(emptyLedger(T0));
    expect(afterFile).toEqual({
      pagesCrawled: 1,
      filesWritten: 1,
      bytesWritten: 250,
      startedAt: T0,
    });
  });

  it('reports remaining headroom and never goes negative', () => {
    const ledger = { pagesCrawled: 9, filesWritten: 9, bytesWritten: 9_999, startedAt: T0 };
    expect(remainingBudget(ledger, caps, T0 + 999_999)).toEqual({
      bytes: 0,
      files: 0,
      pages: 0,
      durationMs: 0,
    });
  });
});

describe('phase scoping', () => {
  const spent = { pagesCrawled: 99, filesWritten: 0, bytesWritten: 0, startedAt: T0 };

  it('does not let a spent page cap block the download phase', () => {
    expect(checkBudget(spent, caps, T0, 'crawl').ok).toBe(false);
    // A page limit constrains discovery; it says nothing about writing files.
    expect(checkBudget(spent, caps, T0, 'download').ok).toBe(true);
  });

  it('does not let a spent byte cap block the crawl phase', () => {
    const heavy = { pagesCrawled: 0, filesWritten: 99, bytesWritten: 99_999, startedAt: T0 };
    expect(checkBudget(heavy, caps, T0, 'download').ok).toBe(false);
    expect(checkBudget(heavy, caps, T0, 'crawl').ok).toBe(true);
  });

  it('applies the duration cap to both phases, since the job spends it as a whole', () => {
    const late = T0 + 10_001;
    expect(checkBudget(emptyLedger(T0), caps, late, 'crawl').ok).toBe(false);
    expect(checkBudget(emptyLedger(T0), caps, late, 'download').ok).toBe(false);
  });

  it('checks everything when no phase is named', () => {
    expect(checkBudget(spent, caps, T0).ok).toBe(false);
  });

  it('scopes the pre-flight projection the same way', () => {
    const ledger = { pagesCrawled: 99, filesWritten: 0, bytesWritten: 0, startedAt: T0 };
    expect(wouldBreach(ledger, caps, { bytes: 10, files: 1, pages: 0 }, 'download').ok).toBe(true);
    expect(wouldBreach(ledger, caps, { bytes: 10, files: 1, pages: 1 }, 'crawl').ok).toBe(false);
  });
});
