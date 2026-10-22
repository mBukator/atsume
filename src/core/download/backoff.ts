import type { DownloadOptions } from '../config';
import type { HttpError } from '../net/http';

export type RetryDecision =
  | { readonly retry: true; readonly reason: 'status' | 'transport' }
  | { readonly retry: false; readonly reason: 'permanent' | 'attempts-exhausted' };

// 408 request timeout, 425 too early, 429 rate limited, plus anything 5xx.
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 507, 509]);

export const isRetryableStatus = (status: number): boolean =>
  RETRYABLE_STATUSES.has(status) || status >= 500;

export const isRetryableError = (error: HttpError): boolean =>
  error.kind === 'network' || error.kind === 'timeout';

export const decideRetry = (
  outcome: { readonly status: number } | { readonly error: HttpError },
  attempt: number,
  options: DownloadOptions,
): RetryDecision => {
  if (attempt >= options.maxAttempts) return { retry: false, reason: 'attempts-exhausted' };

  if ('error' in outcome) {
    return isRetryableError(outcome.error)
      ? { retry: true, reason: 'transport' }
      : { retry: false, reason: 'permanent' };
  }

  return isRetryableStatus(outcome.status)
    ? { retry: true, reason: 'status' }
    : { retry: false, reason: 'permanent' };
};

/**
 * Exponential with full-width jitter. Without jitter, a batch of downloads that
 * all hit a 429 at once retries in lockstep and hits it again together.
 */
export const backoffDelay = (
  attempt: number,
  options: DownloadOptions,
  random: () => number = Math.random,
): number => {
  const exponential = options.backoff.baseMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, options.backoff.maxMs);
  const jitter = capped * options.backoff.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
};

/** `Retry-After` is either delta-seconds or an HTTP date. Both appear in the wild. */
export const parseRetryAfter = (raw: string | undefined, now: number): number | null => {
  if (raw === undefined) return null;

  const seconds = Number.parseInt(raw.trim(), 10);
  if (Number.isFinite(seconds) && String(seconds) === raw.trim()) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - now);

  return null;
};

/**
 * The server's instruction wins over our own schedule, but is capped so a
 * hostile or misconfigured `Retry-After: 86400` cannot park a job for a day.
 */
export const nextDelay = (
  attempt: number,
  options: DownloadOptions,
  retryAfter: string | undefined,
  now: number,
  random: () => number = Math.random,
): number => {
  const server = parseRetryAfter(retryAfter, now);
  const own = backoffDelay(attempt, options, random);
  if (server === null) return own;
  return Math.min(Math.max(server, own), options.backoff.maxMs);
};
