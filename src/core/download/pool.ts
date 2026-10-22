type Release = () => void;

/**
 * Two ceilings at once: a global cap on total in-flight requests, and a lower
 * cap per host so a job whose assets all live on one CDN does not hammer it
 * six ways while a job spread over six hosts runs at full width.
 */
export class ConcurrencyPool {
  private globalInFlight = 0;
  private readonly hostInFlight = new Map<string, number>();
  private readonly waiting: { host: string; resume: Release }[] = [];

  constructor(
    private readonly globalLimit: number,
    private readonly perHostLimit: number,
  ) {}

  get inFlight(): number {
    return this.globalInFlight;
  }

  inFlightFor(host: string): number {
    return this.hostInFlight.get(host) ?? 0;
  }

  async run<T>(host: string, task: () => Promise<T>): Promise<T> {
    await this.acquire(host);
    try {
      return await task();
    } finally {
      this.release(host);
    }
  }

  private hasCapacity(host: string): boolean {
    return this.globalInFlight < this.globalLimit && this.inFlightFor(host) < this.perHostLimit;
  }

  private async acquire(host: string): Promise<void> {
    if (this.hasCapacity(host)) {
      this.take(host);
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiting.push({ host, resume: resolve });
    });
    this.take(host);
  }

  private take(host: string): void {
    this.globalInFlight += 1;
    this.hostInFlight.set(host, this.inFlightFor(host) + 1);
  }

  private release(host: string): void {
    this.globalInFlight -= 1;
    const remaining = this.inFlightFor(host) - 1;
    if (remaining <= 0) this.hostInFlight.delete(host);
    else this.hostInFlight.set(host, remaining);

    // Scan for the first waiter that can actually proceed rather than waking
    // the head of the queue: a queue full of one saturated host would
    // otherwise block work for every other host behind it.
    for (let index = 0; index < this.waiting.length; index += 1) {
      const waiter = this.waiting[index];
      if (waiter === undefined) continue;
      if (!this.hasCapacity(waiter.host)) continue;
      this.waiting.splice(index, 1);
      waiter.resume();
      return;
    }
  }
}
