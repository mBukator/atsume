import type { Db } from '../db/open';
import { type JobId, type PageId } from '../ids';
import { derivePageId } from '../ids-server';
import { normalizeUrl } from '../url';

export type PageFetchState =
  | 'queued'
  | 'fetching'
  | 'fetched'
  | 'failed'
  | 'skipped-robots'
  | 'skipped-scope'
  | 'skipped-type';

export interface FrontierEntry {
  readonly id: PageId;
  readonly url: string;
  readonly normalizedUrl: string;
  readonly depth: number;
  readonly discoveredFrom: PageId | null;
}

export type EnqueueOutcome = 'queued' | 'duplicate' | 'invalid';

export interface FrontierCounts {
  readonly queued: number;
  readonly fetching: number;
  readonly visited: number;
  readonly failed: number;
  readonly skipped: number;
}

interface PageRow {
  id: string;
  url: string;
  normalized_url: string;
  depth: number;
  discovered_from: string | null;
}

/**
 * The frontier lives in SQLite rather than memory so a job survives a restart
 * with its queue intact. `claim` is a single statement, which is what makes it
 * safe to hand the same frontier to several concurrent workers.
 */
export class Frontier {
  constructor(
    private readonly db: Db,
    private readonly jobId: JobId,
  ) {}

  enqueue(
    url: string,
    depth: number,
    discoveredFrom: PageId | null,
    now: number,
  ): EnqueueOutcome {
    const normalized = normalizeUrl(url);
    if (!normalized.ok) return 'invalid';

    const id = derivePageId(this.jobId, normalized.value);
    const info = this.db
      .prepare(
        `INSERT INTO pages (id, job_id, url, normalized_url, depth, discovered_from, fetch_state, queued_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
         ON CONFLICT (job_id, normalized_url) DO NOTHING`,
      )
      .run(id, this.jobId, url, normalized.value, depth, discoveredFrom, now);

    return info.changes > 0 ? 'queued' : 'duplicate';
  }

  enqueueMany(
    urls: readonly string[],
    depth: number,
    discoveredFrom: PageId | null,
    now: number,
  ): number {
    return this.db.transaction(() => {
      let added = 0;
      for (const url of urls) {
        if (this.enqueue(url, depth, discoveredFrom, now) === 'queued') added += 1;
      }
      return added;
    })();
  }

  /** Shallowest first, then oldest, so breadth-first ordering survives restarts. */
  claim(): FrontierEntry | null {
    const row = this.db
      .prepare(
        `UPDATE pages SET fetch_state = 'fetching'
          WHERE id = (
            SELECT id FROM pages
             WHERE job_id = ? AND fetch_state = 'queued'
             ORDER BY depth, queued_at, id LIMIT 1
          )
          RETURNING id, url, normalized_url, depth, discovered_from`,
      )
      .get(this.jobId) as PageRow | undefined;

    if (row === undefined) return null;
    return {
      id: row.id as PageId,
      url: row.url,
      normalizedUrl: row.normalized_url,
      depth: row.depth,
      discoveredFrom: row.discovered_from === null ? null : (row.discovered_from as PageId),
    };
  }

  markFetched(
    id: PageId,
    details: {
      readonly httpStatus: number;
      readonly contentType: string | null;
      readonly renderMode: string;
    },
    now: number,
  ): void {
    this.db
      .prepare(
        `UPDATE pages SET fetch_state = 'fetched', http_status = ?, content_type = ?,
                          render_mode = ?, visited_at = ? WHERE id = ?`,
      )
      .run(details.httpStatus, details.contentType, details.renderMode, now, id);
  }

  markFailed(id: PageId, reason: string, httpStatus: number | null, now: number): void {
    this.db
      .prepare(
        `UPDATE pages SET fetch_state = 'failed', error_json = ?, http_status = ?, visited_at = ?
          WHERE id = ?`,
      )
      .run(JSON.stringify({ reason }), httpStatus, now, id);
  }

  markSkipped(id: PageId, state: PageFetchState, reason: string, now: number): void {
    this.db
      .prepare('UPDATE pages SET fetch_state = ?, error_json = ?, visited_at = ? WHERE id = ?')
      .run(state, JSON.stringify({ reason }), now, id);
  }

  queueDepth(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM pages WHERE job_id = ? AND fetch_state = 'queued'")
      .get(this.jobId) as { n: number };
    return row.n;
  }

  counts(): FrontierCounts {
    const rows = this.db
      .prepare('SELECT fetch_state, COUNT(*) AS n FROM pages WHERE job_id = ? GROUP BY fetch_state')
      .all(this.jobId) as Array<{ fetch_state: string; n: number }>;

    const by = new Map(rows.map((row) => [row.fetch_state, row.n]));
    const skipped =
      (by.get('skipped-robots') ?? 0) + (by.get('skipped-scope') ?? 0) + (by.get('skipped-type') ?? 0);

    return {
      queued: by.get('queued') ?? 0,
      fetching: by.get('fetching') ?? 0,
      visited: by.get('fetched') ?? 0,
      failed: by.get('failed') ?? 0,
      skipped,
    };
  }

  /**
   * Pages left in `fetching` belong to a process that died. Returning them to
   * the queue is safe because fetching is idempotent.
   */
  requeueStale(): number {
    return this.db
      .prepare("UPDATE pages SET fetch_state = 'queued' WHERE job_id = ? AND fetch_state = 'fetching'")
      .run(this.jobId).changes;
  }
}
