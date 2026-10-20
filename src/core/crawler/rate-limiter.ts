import type { Clock } from '../clock';

/**
 * Serialises requests per host. Slots are reserved at acquire time rather than
 * on completion, so N concurrent workers hitting one host queue up behind each
 * other instead of all reading the same "last request" timestamp and firing
 * together.
 */
export class HostRateLimiter {
  private readonly nextAvailable = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly defaultDelayMs: number,
  ) {}

  /** robots.txt `Crawl-delay` raises the floor; it never lowers it. */
  delayFor(crawlDelayMs: number | null): number {
    return Math.max(this.defaultDelayMs, crawlDelayMs ?? 0);
  }

  async acquire(host: string, crawlDelayMs: number | null, signal?: AbortSignal): Promise<number> {
    const delay = this.delayFor(crawlDelayMs);
    const now = this.clock.now();
    const earliest = this.nextAvailable.get(host) ?? 0;
    const startAt = Math.max(now, earliest);

    this.nextAvailable.set(host, startAt + delay);

    const wait = startAt - now;
    if (wait > 0) await this.clock.sleep(wait, signal);
    return wait;
  }

  /** After a 429 or 503 with `Retry-After`, push the whole host out. */
  penalise(host: string, untilMs: number): void {
    const current = this.nextAvailable.get(host) ?? 0;
    this.nextAvailable.set(host, Math.max(current, untilMs));
  }
}
