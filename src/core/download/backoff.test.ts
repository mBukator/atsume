import { describe, expect, it } from 'vitest';
import { downloadOptionsSchema } from '../config';
import { backoffDelay, decideRetry, nextDelay, parseRetryAfter } from './backoff';
import { ConcurrencyPool } from './pool';

const options = downloadOptionsSchema.parse({ maxAttempts: 4 });
const NOW = 1_700_000_000_000;

describe('decideRetry', () => {
  it('retries the statuses that mean "try again"', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(decideRetry({ status }, 1, options).retry).toBe(true);
    }
  });

  it('does not retry a permanent client error', () => {
    for (const status of [400, 401, 403, 404, 410]) {
      expect(decideRetry({ status }, 1, options)).toEqual({ retry: false, reason: 'permanent' });
    }
  });

  it('retries transport failures but not cancellation', () => {
    expect(decideRetry({ error: { kind: 'network', message: 'reset' } }, 1, options).retry).toBe(true);
    expect(decideRetry({ error: { kind: 'timeout', afterMs: 1_000 } }, 1, options).retry).toBe(true);
    expect(decideRetry({ error: { kind: 'aborted' } }, 1, options).retry).toBe(false);
  });

  it('stops once the attempt budget is spent, whatever the status', () => {
    expect(decideRetry({ status: 503 }, 4, options)).toEqual({
      retry: false,
      reason: 'attempts-exhausted',
    });
  });
});

describe('backoffDelay', () => {
  const noJitter = downloadOptionsSchema.parse({ backoff: { baseMs: 100, jitterRatio: 0 } });

  it('doubles with each attempt', () => {
    expect([1, 2, 3, 4].map((attempt) => backoffDelay(attempt, noJitter))).toEqual([100, 200, 400, 800]);
  });

  it('caps at the configured ceiling', () => {
    const capped = downloadOptionsSchema.parse({
      backoff: { baseMs: 1_000, maxMs: 5_000, jitterRatio: 0 },
    });
    expect(backoffDelay(10, capped)).toBe(5_000);
  });

  it('spreads retries either side of the exponential value', () => {
    const jittered = downloadOptionsSchema.parse({ backoff: { baseMs: 1_000, jitterRatio: 0.5 } });
    expect(backoffDelay(1, jittered, () => 0)).toBe(500);
    expect(backoffDelay(1, jittered, () => 1)).toBe(1_500);
    expect(backoffDelay(1, jittered, () => 0.5)).toBe(1_000);
  });

  it('never returns a negative delay', () => {
    const wild = downloadOptionsSchema.parse({ backoff: { baseMs: 100, jitterRatio: 1 } });
    expect(backoffDelay(1, wild, () => 0)).toBeGreaterThanOrEqual(0);
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120_000);
  });

  it('reads an HTTP date', () => {
    const future = new Date(NOW + 30_000).toUTCString();
    expect(parseRetryAfter(future, NOW)).toBeGreaterThan(0);
  });

  it('clamps a date already in the past to zero', () => {
    expect(parseRetryAfter(new Date(NOW - 60_000).toUTCString(), NOW)).toBe(0);
  });

  it('returns null for junk or absence', () => {
    expect(parseRetryAfter(undefined, NOW)).toBeNull();
    expect(parseRetryAfter('soon please', NOW)).toBeNull();
  });
});

describe('nextDelay', () => {
  const noJitter = downloadOptionsSchema.parse({
    backoff: { baseMs: 100, maxMs: 10_000, jitterRatio: 0 },
  });

  it('lets the server override our schedule upward', () => {
    expect(nextDelay(1, noJitter, '5', NOW)).toBe(5_000);
  });

  it('keeps our own schedule when the server asks for less', () => {
    expect(nextDelay(4, noJitter, '0', NOW)).toBe(800);
  });

  it('caps a hostile Retry-After so one header cannot park the job for a day', () => {
    expect(nextDelay(1, noJitter, '86400', NOW)).toBe(10_000);
  });

  it('falls back to backoff when there is no header', () => {
    expect(nextDelay(2, noJitter, undefined, NOW)).toBe(200);
  });
});

describe('ConcurrencyPool', () => {
  /** Lets every queued microtask and the pool's wake-up chain drain. */
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  const deferred = () => {
    let release = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };

  it('caps total in-flight work at the global limit', async () => {
    const pool = new ConcurrencyPool(2, 2);
    const gates = [deferred(), deferred(), deferred()];
    let started = 0;

    const runs = gates.map((gate, index) =>
      pool.run(`host${index}.test`, async () => {
        started += 1;
        await gate.promise;
      }),
    );

    await flush();
    expect(started).toBe(2);

    gates[0]?.release();
    await flush();
    expect(started).toBe(3);

    for (const gate of gates) gate.release();
    await Promise.all(runs);
  });

  it('caps one host below the global limit', async () => {
    const pool = new ConcurrencyPool(6, 2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let started = 0;

    const runs = gates.map((gate) =>
      pool.run('cdn.test', async () => {
        started += 1;
        await gate.promise;
      }),
    );

    await flush();
    expect(started).toBe(2);
    expect(pool.inFlightFor('cdn.test')).toBe(2);

    for (const gate of gates) gate.release();
    await Promise.all(runs);
  });

  it('does not let a saturated host block work queued behind it for another host', async () => {
    const pool = new ConcurrencyPool(4, 1);
    const busy = [deferred(), deferred()];
    let otherStarted = false;

    const first = pool.run('busy.test', async () => {
      await busy[0]?.promise;
    });
    const second = pool.run('busy.test', async () => {
      await busy[1]?.promise;
    });
    const other = pool.run('free.test', async () => {
      otherStarted = true;
    });

    await flush();
    expect(otherStarted).toBe(true);

    for (const gate of busy) gate.release();
    await Promise.all([first, second, other]);
  });

  it('releases its slot even when the task throws', async () => {
    const pool = new ConcurrencyPool(1, 1);
    await expect(
      pool.run('a.test', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(pool.inFlight).toBe(0);
    await expect(pool.run('a.test', async () => 'fine')).resolves.toBe('fine');
  });

  it('returns each task its own result', async () => {
    const pool = new ConcurrencyPool(2, 2);
    const results = await Promise.all(
      [1, 2, 3, 4].map((value) => pool.run('a.test', async () => value * 10)),
    );
    expect(results).toEqual([10, 20, 30, 40]);
    expect(pool.inFlight).toBe(0);
  });
});
