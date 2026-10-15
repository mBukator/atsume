/**
 * Time is a dependency, not an ambient fact. Rate limiting and duration caps
 * both read the clock, and tests need to drive them without real waiting.
 */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (ms <= 0) {
        // Not `resolve()`. Resolving here queues a microtask, and microtasks
        // drain completely before the event loop reaches the poll phase — so a
        // caller polling on sleep(0) starves every pending socket read and
        // timer in the process. `setImmediate` fires after poll, letting I/O
        // through.
        setImmediate(resolve);
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      };
      if (signal?.aborted === true) {
        clearTimeout(timer);
        reject(new Error('aborted'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};