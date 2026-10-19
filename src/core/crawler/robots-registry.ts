import type { Db } from '../db/open';
import { ok, type Result } from '../result';
import { decodeText, type HttpClient, type RequestOptions } from '../net/http';
import {
  isPathAllowed,
  parseRobots,
  pathAndQuery,
  type RobotsDecision,
  type RobotsGroup,
  selectGroup,
} from './robots';

/**
 * `absent` means the host published no robots.txt (4xx), which permits
 * everything. `unavailable` means we could not find out (5xx, network failure),
 * which per RFC 9309 forbids everything: a crawler that treats "I could not
 * check" as "go ahead" is not respecting robots.txt, it is guessing.
 */
export interface HostRobots {
  readonly host: string;
  readonly availability: 'ok' | 'absent' | 'unavailable';
  readonly group: RobotsGroup | null;
  readonly sitemaps: readonly string[];
  readonly crawlDelayMs: number | null;
  readonly fetchedAt: number;
  /** Kept so the SQLite cache round-trips to the same rules it was built from. */
  readonly raw: string | null;
}

export type UrlRobotsDecision =
  | RobotsDecision
  | { readonly kind: 'unavailable'; readonly host: string };

export const decideUrl = (robots: HostRobots, url: string): UrlRobotsDecision => {
  if (robots.availability === 'unavailable') return { kind: 'unavailable', host: robots.host };
  if (robots.availability === 'absent') return { kind: 'allowed' };
  return isPathAllowed(robots.group, pathAndQuery(url));
};

interface RobotsRow {
  host: string;
  body: string | null;
  status: number | null;
  crawl_delay_ms: number | null;
  fetched_at: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * One robots.txt fetch per host per run, shared across crawl workers. The
 * in-flight map matters: without it, N workers starting at once on the same
 * host would each fire their own request before any of them cached a result.
 */
export class RobotsRegistry {
  private readonly memory = new Map<string, HostRobots>();
  private readonly inFlight = new Map<string, Promise<HostRobots>>();

  constructor(
    private readonly http: HttpClient,
    private readonly db: Db | null,
    private readonly userAgent: string,
  ) {}

  async forUrl(
    url: string,
    options: Omit<RequestOptions, 'userAgent' | 'accept'>,
    now: number,
  ): Promise<Result<HostRobots, never>> {
    const origin = new URL(url).origin;
    const host = new URL(url).host.toLowerCase();

    const cached = this.memory.get(host) ?? this.fromDb(host, now);
    if (cached !== null && cached !== undefined) {
      this.memory.set(host, cached);
      return ok(cached);
    }

    const existing = this.inFlight.get(host);
    if (existing !== undefined) return ok(await existing);

    const pending = this.fetch(origin, host, options, now);
    this.inFlight.set(host, pending);
    try {
      const resolved = await pending;
      this.memory.set(host, resolved);
      this.persist(resolved);
      return ok(resolved);
    } finally {
      this.inFlight.delete(host);
    }
  }

  private async fetch(
    origin: string,
    host: string,
    options: Omit<RequestOptions, 'userAgent' | 'accept'>,
    now: number,
  ): Promise<HostRobots> {
    const response = await this.http.get(`${origin}/robots.txt`, {
      ...options,
      userAgent: this.userAgent,
      accept: 'text/plain,*/*;q=0.5',
      maxBytes: 512 * 1024,
    });

    if (!response.ok) {
      return {
        host,
        availability: 'unavailable',
        group: null,
        sitemaps: [],
        crawlDelayMs: null,
        fetchedAt: now,
        raw: null,
      };
    }

    const { status } = response.value;
    if (status >= 400 && status < 500) {
      return {
        host,
        availability: 'absent',
        group: null,
        sitemaps: [],
        crawlDelayMs: null,
        fetchedAt: now,
        raw: null,
      };
    }
    if (status >= 500) {
      return {
        host,
        availability: 'unavailable',
        group: null,
        sitemaps: [],
        crawlDelayMs: null,
        fetchedAt: now,
        raw: null,
      };
    }

    const text = decodeText(response.value);
    const parsed = parseRobots(text);
    const group = selectGroup(parsed, this.userAgent);
    return {
      host,
      availability: 'ok',
      group,
      sitemaps: parsed.sitemaps,
      crawlDelayMs: group?.crawlDelayMs ?? null,
      fetchedAt: now,
      raw: text,
    };
  }

  private fromDb(host: string, now: number): HostRobots | null {
    if (this.db === null) return null;
    const row = this.db.prepare('SELECT * FROM robots_cache WHERE host = ?').get(host) as
      | RobotsRow
      | undefined;
    if (row === undefined || now - row.fetched_at > CACHE_TTL_MS) return null;

    if (row.status === null) {
      return {
        host,
        availability: 'unavailable',
        group: null,
        sitemaps: [],
        crawlDelayMs: null,
        fetchedAt: row.fetched_at,
        raw: null,
      };
    }
    if (row.status >= 400) {
      const availability = row.status < 500 ? 'absent' : 'unavailable';
      return {
        host,
        availability,
        group: null,
        sitemaps: [],
        crawlDelayMs: null,
        fetchedAt: row.fetched_at,
        raw: null,
      };
    }

    const parsed = parseRobots(row.body ?? '');
    const group = selectGroup(parsed, this.userAgent);
    return {
      host,
      availability: 'ok',
      group,
      sitemaps: parsed.sitemaps,
      crawlDelayMs: group?.crawlDelayMs ?? null,
      fetchedAt: row.fetched_at,
      raw: row.body,
    };
  }

  private persist(robots: HostRobots): void {
    if (this.db === null) return;
    const status =
      robots.availability === 'ok' ? 200 : robots.availability === 'absent' ? 404 : null;
    this.db
      .prepare(
        `INSERT INTO robots_cache (host, body, status, crawl_delay_ms, fetched_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (host) DO UPDATE SET
           body = excluded.body, status = excluded.status,
           crawl_delay_ms = excluded.crawl_delay_ms, fetched_at = excluded.fetched_at`,
      )
      .run(robots.host, robots.raw, status, robots.crawlDelayMs, robots.fetchedAt);
  }
}
