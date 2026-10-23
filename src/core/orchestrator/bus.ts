/**
 * A bounded async queue. Producers never block; if a consumer falls behind past
 * the limit, the oldest entries are dropped rather than letting one stalled
 * browser tab grow memory without bound.
 */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((value: IteratorResult<T>) => void)[] = [];
  private closed = false;
  private droppedCount = 0;

  constructor(private readonly limit = 1_000) {}

  get dropped(): number {
    return this.droppedCount;
  }

  push(item: T): void {
    if (this.closed) return;

    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: item, done: false });
      return;
    }

    this.items.push(item);
    while (this.items.length > this.limit) {
      this.items.shift();
      this.droppedCount += 1;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const buffered = this.items.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.closed) return;

      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next.done === true) return;
      yield next.value;
    }
  }
}

export interface Subscription<T> {
  readonly stream: AsyncIterable<T>;
  close(): void;
}

/**
 * In-process pub/sub, one topic per job. Deliberately not durable: durable
 * events are already in SQLite, and a reconnecting client replays from there.
 * This only carries the live tail.
 */
export class EventBus<T> {
  private readonly topics = new Map<string, Set<AsyncQueue<T>>>();

  subscribe(topic: string, limit = 1_000): Subscription<T> {
    const queue = new AsyncQueue<T>(limit);
    const subscribers = this.topics.get(topic) ?? new Set<AsyncQueue<T>>();
    subscribers.add(queue);
    this.topics.set(topic, subscribers);

    return {
      stream: queue,
      close: () => {
        queue.close();
        const current = this.topics.get(topic);
        if (current === undefined) return;
        current.delete(queue);
        if (current.size === 0) this.topics.delete(topic);
      },
    };
  }

  publish(topic: string, item: T): void {
    const subscribers = this.topics.get(topic);
    if (subscribers === undefined) return;
    for (const queue of subscribers) queue.push(item);
  }

  subscriberCount(topic: string): number {
    return this.topics.get(topic)?.size ?? 0;
  }

  closeTopic(topic: string): void {
    const subscribers = this.topics.get(topic);
    if (subscribers === undefined) return;
    for (const queue of subscribers) queue.close();
    this.topics.delete(topic);
  }
}
