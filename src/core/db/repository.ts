import { type JobConfig, jobConfigSchema } from '../config';
import { type AssetId, type JobId, assetIdSchema, jobIdSchema } from '../ids';
import { deriveAssetId, newJobId } from '../ids-server';
import {
  type Asset,
  type AssetSource,
  acquisitionPlanSchema,
  type DownloadState,
  downloadStateSchema,
  type FilterVerdict,
  filterVerdictSchema,
  type MediaCandidate,
  type MediaHints,
  mediaHintsSchema,
  mediaKindSchema,
  type ProbeState,
  probeStateSchema,
} from '../media';
import { err, ok, type Result, unit } from '../result';
import { normalizeUrl } from '../url';
import { type BudgetLedger, budgetLedgerSchema } from '../job/budget';
import { isDurable, type JobEvent, jobEventSchema } from '../job/events';
import { rehydrate } from '../job/reducer';
import { idleState, type JobState, jobStateSchema } from '../job/state';
import type { Db } from './open';

export type RepositoryError =
  | { readonly kind: 'not-found'; readonly entity: string; readonly id: string }
  | {
      readonly kind: 'corrupt-row';
      readonly entity: string;
      readonly id: string;
      readonly detail: string;
    }
  | { readonly kind: 'invalid-input'; readonly detail: string };

export interface JobRecord {
  readonly id: JobId;
  readonly seedUrl: string;
  readonly config: JobConfig;
  readonly state: JobState;
  readonly ledger: BudgetLedger;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StoredEvent {
  readonly seq: number;
  readonly event: JobEvent;
}

export interface UpsertOutcome {
  readonly assetId: AssetId;
  readonly isNew: boolean;
}

export interface ListAssetsOptions {
  readonly verdict: FilterVerdict['verdict'] | 'any';
  readonly selected: boolean | null;
  readonly limit: number;
  readonly offset: number;
}

const DEFAULT_LIST_OPTIONS: ListAssetsOptions = {
  verdict: 'any',
  selected: null,
  limit: 500,
  offset: 0,
};

interface JobRow {
  id: string;
  seed_url: string;
  status: string;
  config_json: string;
  state_json: string;
  pages_crawled: number;
  files_written: number;
  bytes_written: number;
  started_at: number | null;
  created_at: number;
  updated_at: number;
}

interface AssetRow {
  id: string;
  job_id: string;
  url: string;
  normalized_url: string;
  kind: string;
  acquisition_json: string;
  hints_json: string;
  probe_json: string;
  filter_json: string;
  selected: number;
  download_json: string;
  first_seen_at: number;
  updated_at: number;
}

interface SourceRow {
  asset_id: string;
  page_url: string;
  extractor: string;
  alt: string | null;
  discovered_at: number;
}

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Rows are external input. Everything read back out of SQLite goes through the
 * same schemas that guarded it on the way in, so a hand-edited database or a
 * row written by an older build surfaces as a value, not a runtime surprise.
 */
export class JobRepository {
  constructor(private readonly db: Db) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  createJob(config: JobConfig, now: number = Date.now()): JobRecord {
    const id = newJobId();
    const state = idleState;
    this.db
      .prepare(
        `INSERT INTO jobs (id, seed_url, status, config_json, state_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, config.seedUrl, state.status, JSON.stringify(config), JSON.stringify(state), now, now);

    return {
      id,
      seedUrl: config.seedUrl,
      config,
      state,
      ledger: { pagesCrawled: 0, filesWritten: 0, bytesWritten: 0, startedAt: now },
      createdAt: now,
      updatedAt: now,
    };
  }

  getJob(id: JobId): Result<JobRecord, RepositoryError> {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    if (row === undefined) return err({ kind: 'not-found', entity: 'job', id });
    return this.mapJobRow(row);
  }

  listJobs(limit = 50): JobRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as JobRow[];
    const records: JobRecord[] = [];
    for (const row of rows) {
      const mapped = this.mapJobRow(row);
      if (mapped.ok) records.push(mapped.value);
    }
    return records;
  }

  saveState(id: JobId, state: JobState, now: number = Date.now()): Result<null, RepositoryError> {
    const info = this.db
      .prepare('UPDATE jobs SET state_json = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(state), state.status, now, id);
    if (info.changes === 0) return err({ kind: 'not-found', entity: 'job', id });
    return unit;
  }

  saveConfig(id: JobId, config: JobConfig, now: number = Date.now()): Result<null, RepositoryError> {
    const info = this.db
      .prepare('UPDATE jobs SET config_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(config), now, id);
    return info.changes === 0 ? err({ kind: 'not-found', entity: 'job', id }) : unit;
  }

  /**
   * Pushes the job's start time forward. Used when resuming: time spent paused
   * is not time spent working, and the duration cap should only measure the
   * latter.
   */
  shiftStart(id: JobId, byMs: number, now: number = Date.now()): Result<null, RepositoryError> {
    if (byMs <= 0) return unit;
    const info = this.db
      .prepare(
        'UPDATE jobs SET started_at = COALESCE(started_at, created_at) + ?, updated_at = ? WHERE id = ?',
      )
      .run(byMs, now, id);
    return info.changes === 0 ? err({ kind: 'not-found', entity: 'job', id }) : unit;
  }

  markStarted(id: JobId, startedAt: number): Result<null, RepositoryError> {
    const info = this.db
      .prepare('UPDATE jobs SET started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?')
      .run(startedAt, startedAt, id);
    if (info.changes === 0) return err({ kind: 'not-found', entity: 'job', id });
    return unit;
  }

  /** Ephemeral events are dropped here rather than at every call site. */
  appendEvent(
    id: JobId,
    event: JobEvent,
    now: number = Date.now(),
  ): Result<number | null, RepositoryError> {
    if (!isDurable(event)) return ok(null);
    const info = this.db
      .prepare('INSERT INTO job_events (job_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
      .run(id, event.type, JSON.stringify(event), now);
    return ok(Number(info.lastInsertRowid));
  }

  eventsSince(id: JobId, seq: number): Result<StoredEvent[], RepositoryError> {
    const rows = this.db
      .prepare('SELECT seq, payload_json FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq')
      .all(id, seq) as Array<{ seq: number; payload_json: string }>;

    const events: StoredEvent[] = [];
    for (const row of rows) {
      const parsed = jobEventSchema.safeParse(parseJson(row.payload_json));
      if (!parsed.success) {
        return err({
          kind: 'corrupt-row',
          entity: 'job_events',
          id: String(row.seq),
          detail: parsed.error.message,
        });
      }
      events.push({ seq: row.seq, event: parsed.data });
    }
    return ok(events);
  }

  creditLedger(
    id: JobId,
    delta: { readonly pages?: number; readonly files?: number; readonly bytes?: number },
    now: number = Date.now(),
  ): Result<BudgetLedger, RepositoryError> {
    this.db
      .prepare(
        `UPDATE jobs
            SET pages_crawled = pages_crawled + ?,
                files_written = files_written + ?,
                bytes_written = bytes_written + ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(delta.pages ?? 0, delta.files ?? 0, delta.bytes ?? 0, now, id);

    const record = this.getJob(id);
    return record.ok ? ok(record.value.ledger) : record;
  }

  /**
   * Discovery calls this once per page with everything the extractors found.
   * Re-finding the same URL adds provenance instead of a row, and improves the
   * stored hints when the new sighting knows more (a real `alt`, larger
   * dimensions from a `srcset` descriptor).
   */
  upsertCandidates(
    jobId: JobId,
    candidates: readonly MediaCandidate[],
    now: number = Date.now(),
  ): Result<UpsertOutcome[], RepositoryError> {
    const insertAsset = this.db.prepare(
      `INSERT INTO assets (
         id, job_id, url, normalized_url, kind, acquisition_json, hints_json,
         probe_json, filter_json, selected, download_json, first_seen_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT (job_id, normalized_url) DO NOTHING`,
    );
    const selectHints = this.db.prepare('SELECT hints_json FROM assets WHERE id = ?');
    const updateHints = this.db.prepare(
      'UPDATE assets SET hints_json = ?, updated_at = ? WHERE id = ?',
    );
    const insertSource = this.db.prepare(
      `INSERT INTO asset_sources (asset_id, page_url, extractor, alt, discovered_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (asset_id, page_url, extractor) DO NOTHING`,
    );

    const run = (): Result<UpsertOutcome[], RepositoryError> => {
      const outcomes: UpsertOutcome[] = [];

      for (const candidate of candidates) {
        const normalized = normalizeUrl(candidate.url);
        if (!normalized.ok) {
          return err({ kind: 'invalid-input', detail: `unnormalizable URL: ${candidate.url}` });
        }
        const assetId = deriveAssetId(jobId, normalized.value);

        const info = insertAsset.run(
          assetId,
          jobId,
          candidate.url,
          normalized.value,
          candidate.kind,
          JSON.stringify(candidate.acquisition),
          JSON.stringify(candidate.hints),
          JSON.stringify({ status: 'unprobed' } satisfies ProbeState),
          JSON.stringify({ verdict: 'unevaluated' } satisfies FilterVerdict),
          JSON.stringify({ status: 'pending' } satisfies DownloadState),
          now,
          now,
        );
        const isNew = info.changes > 0;

        if (!isNew) {
          const existing = selectHints.get(assetId) as { hints_json: string } | undefined;
          if (existing !== undefined) {
            const parsed = mediaHintsSchema.safeParse(parseJson(existing.hints_json));
            if (!parsed.success) {
              return err({
                kind: 'corrupt-row',
                entity: 'assets',
                id: assetId,
                detail: parsed.error.message,
              });
            }
            const merged = mergeHints(parsed.data, candidate.hints);
            updateHints.run(JSON.stringify(merged), now, assetId);
          }
        }

        insertSource.run(assetId, candidate.foundOn, candidate.foundBy, candidate.hints.alt, now);
        outcomes.push({ assetId, isNew });
      }

      return ok(outcomes);
    };

    return this.transaction(run);
  }

  getAsset(id: AssetId): Result<Asset, RepositoryError> {
    const row = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined;
    if (row === undefined) return err({ kind: 'not-found', entity: 'asset', id });
    const sources = this.sourcesFor([id]);
    return this.mapAssetRow(row, sources.get(id) ?? []);
  }

  listAssets(
    jobId: JobId,
    options: Partial<ListAssetsOptions> = {},
  ): Result<Asset[], RepositoryError> {
    const opts = { ...DEFAULT_LIST_OPTIONS, ...options };
    const clauses: string[] = ['job_id = ?'];
    const params: Array<string | number> = [jobId];

    if (opts.verdict !== 'any') {
      clauses.push("json_extract(filter_json, '$.verdict') = ?");
      params.push(opts.verdict);
    }
    if (opts.selected !== null) {
      clauses.push('selected = ?');
      params.push(opts.selected ? 1 : 0);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM assets WHERE ${clauses.join(' AND ')}
          ORDER BY first_seen_at, id LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit, opts.offset) as AssetRow[];

    const sources = this.sourcesFor(rows.map((row) => row.id as AssetId));
    const assets: Asset[] = [];
    for (const row of rows) {
      const mapped = this.mapAssetRow(row, sources.get(row.id as AssetId) ?? []);
      if (!mapped.ok) return mapped;
      assets.push(mapped.value);
    }
    return ok(assets);
  }

  countAssets(jobId: JobId): { readonly total: number; readonly included: number; readonly selected: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN json_extract(filter_json, '$.verdict') = 'included' THEN 1 ELSE 0 END) AS included,
                SUM(selected) AS selected
           FROM assets WHERE job_id = ?`,
      )
      .get(jobId) as { total: number; included: number | null; selected: number | null };
    return { total: row.total, included: row.included ?? 0, selected: row.selected ?? 0 };
  }

  setProbe(id: AssetId, probe: ProbeState, now: number = Date.now()): Result<null, RepositoryError> {
    const bytes = probe.status === 'probed' ? probe.contentLength : null;
    const info = this.db
      .prepare('UPDATE assets SET probe_json = ?, bytes = COALESCE(?, bytes), updated_at = ? WHERE id = ?')
      .run(JSON.stringify(probe), bytes, now, id);
    return info.changes === 0 ? err({ kind: 'not-found', entity: 'asset', id }) : unit;
  }

  setFilterVerdict(
    id: AssetId,
    verdict: FilterVerdict,
    now: number = Date.now(),
  ): Result<null, RepositoryError> {
    const info = this.db
      .prepare('UPDATE assets SET filter_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(verdict), now, id);
    return info.changes === 0 ? err({ kind: 'not-found', entity: 'asset', id }) : unit;
  }

  setSelection(
    jobId: JobId,
    ids: readonly AssetId[],
    selected: boolean,
    now: number = Date.now(),
  ): number {
    if (ids.length === 0) return 0;
    const update = this.db.prepare(
      'UPDATE assets SET selected = ?, updated_at = ? WHERE id = ? AND job_id = ?',
    );
    return this.transaction(() => {
      let changed = 0;
      for (const id of ids) {
        changed += update.run(selected ? 1 : 0, now, id, jobId).changes;
      }
      return changed;
    });
  }

  /** Select-all / select-none over exactly what the current filters admit. */
  setSelectionForIncluded(jobId: JobId, selected: boolean, now: number = Date.now()): number {
    return this.db
      .prepare(
        `UPDATE assets SET selected = ?, updated_at = ?
          WHERE job_id = ? AND json_extract(filter_json, '$.verdict') = 'included'`,
      )
      .run(selected ? 1 : 0, now, jobId).changes;
  }

  setDownloadState(
    id: AssetId,
    state: DownloadState,
    now: number = Date.now(),
  ): Result<null, RepositoryError> {
    const sha =
      state.status === 'complete' || state.status === 'skipped-duplicate' ? state.sha256 : null;
    const localPath =
      state.status === 'complete' || state.status === 'skipped-duplicate' ? state.localPath : null;
    const bytes = state.status === 'complete' ? state.bytes : null;

    const info = this.db
      .prepare(
        `UPDATE assets
            SET download_json = ?,
                content_sha256 = COALESCE(?, content_sha256),
                local_path = COALESCE(?, local_path),
                bytes = COALESCE(?, bytes),
                updated_at = ?
          WHERE id = ?`,
      )
      .run(JSON.stringify(state), sha, localPath, bytes, now, id);
    return info.changes === 0 ? err({ kind: 'not-found', entity: 'asset', id }) : unit;
  }

  /** Duplicate detection: has this content hash already landed in this job? */
  findByHash(jobId: JobId, sha256: string): { readonly id: AssetId; readonly localPath: string } | null {
    const row = this.db
      .prepare(
        `SELECT id, local_path FROM assets
          WHERE job_id = ? AND content_sha256 = ? AND local_path IS NOT NULL
          ORDER BY updated_at LIMIT 1`,
      )
      .get(jobId, sha256) as { id: string; local_path: string } | undefined;
    return row === undefined ? null : { id: row.id as AssetId, localPath: row.local_path };
  }

  /**
   * Called once at server start: any job the DB still thinks is running had its
   * process killed, so it is parked in `paused` awaiting an explicit resume.
   */
  rehydrateInterrupted(now: number = Date.now()): JobId[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE status IN ('crawling', 'downloading')")
      .all() as JobRow[];

    const touched: JobId[] = [];
    this.transaction(() => {
      for (const row of rows) {
        const record = this.mapJobRow(row);
        if (!record.ok) continue;
        const next = rehydrate(record.value.state, now);
        if (next === record.value.state) continue;
        this.saveState(record.value.id, next, now);
        touched.push(record.value.id);
      }
    });
    return touched;
  }

  private sourcesFor(ids: readonly AssetId[]): Map<AssetId, AssetSource[]> {
    const grouped = new Map<AssetId, AssetSource[]>();
    if (ids.length === 0) return grouped;

    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM asset_sources WHERE asset_id IN (${placeholders}) ORDER BY discovered_at`,
      )
      .all(...ids) as SourceRow[];

    for (const row of rows) {
      const key = row.asset_id as AssetId;
      const list = grouped.get(key) ?? [];
      list.push({
        pageUrl: row.page_url,
        extractor: row.extractor as AssetSource['extractor'],
        alt: row.alt,
        discoveredAt: row.discovered_at,
      });
      grouped.set(key, list);
    }
    return grouped;
  }

  private mapJobRow(row: JobRow): Result<JobRecord, RepositoryError> {
    const id = jobIdSchema.safeParse(row.id);
    if (!id.success) {
      return err({ kind: 'corrupt-row', entity: 'jobs', id: row.id, detail: 'malformed job id' });
    }
    const config = jobConfigSchema.safeParse(parseJson(row.config_json));
    if (!config.success) {
      return err({
        kind: 'corrupt-row',
        entity: 'jobs',
        id: row.id,
        detail: `config: ${config.error.message}`,
      });
    }
    const state = jobStateSchema.safeParse(parseJson(row.state_json));
    if (!state.success) {
      return err({
        kind: 'corrupt-row',
        entity: 'jobs',
        id: row.id,
        detail: `state: ${state.error.message}`,
      });
    }
    const ledger = budgetLedgerSchema.safeParse({
      pagesCrawled: row.pages_crawled,
      filesWritten: row.files_written,
      bytesWritten: row.bytes_written,
      startedAt: row.started_at ?? row.created_at,
    });
    if (!ledger.success) {
      return err({
        kind: 'corrupt-row',
        entity: 'jobs',
        id: row.id,
        detail: `ledger: ${ledger.error.message}`,
      });
    }

    return ok({
      id: id.data,
      seedUrl: row.seed_url,
      config: config.data,
      state: state.data,
      ledger: ledger.data,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private mapAssetRow(row: AssetRow, sources: AssetSource[]): Result<Asset, RepositoryError> {
    const parsed = {
      id: assetIdSchema.safeParse(row.id),
      jobId: jobIdSchema.safeParse(row.job_id),
      kind: mediaKindSchema.safeParse(row.kind),
      acquisition: acquisitionPlanSchema.safeParse(parseJson(row.acquisition_json)),
      hints: mediaHintsSchema.safeParse(parseJson(row.hints_json)),
      probe: probeStateSchema.safeParse(parseJson(row.probe_json)),
      filter: filterVerdictSchema.safeParse(parseJson(row.filter_json)),
      download: downloadStateSchema.safeParse(parseJson(row.download_json)),
    };

    for (const [field, result] of Object.entries(parsed)) {
      if (!result.success) {
        return err({
          kind: 'corrupt-row',
          entity: 'assets',
          id: row.id,
          detail: `${field}: ${result.error.message}`,
        });
      }
    }
    if (
      !parsed.id.success ||
      !parsed.jobId.success ||
      !parsed.kind.success ||
      !parsed.acquisition.success ||
      !parsed.hints.success ||
      !parsed.probe.success ||
      !parsed.filter.success ||
      !parsed.download.success
    ) {
      return err({ kind: 'corrupt-row', entity: 'assets', id: row.id, detail: 'unreachable' });
    }
    if (sources.length === 0) {
      return err({
        kind: 'corrupt-row',
        entity: 'assets',
        id: row.id,
        detail: 'asset has no provenance rows',
      });
    }

    return ok({
      id: parsed.id.data,
      jobId: parsed.jobId.data,
      url: row.url,
      normalizedUrl: row.normalized_url,
      kind: parsed.kind.data,
      acquisition: parsed.acquisition.data,
      hints: parsed.hints.data,
      sources,
      probe: parsed.probe.data,
      filter: parsed.filter.data,
      selected: row.selected === 1,
      download: parsed.download.data,
      firstSeenAt: row.first_seen_at,
      updatedAt: row.updated_at,
    });
  }
}

/** Later sightings only ever add information; they never erase what we knew. */
export const mergeHints = (existing: MediaHints, incoming: MediaHints): MediaHints => ({
  alt: existing.alt ?? incoming.alt,
  title: existing.title ?? incoming.title,
  width: pickLarger(existing.width, incoming.width),
  height: pickLarger(existing.height, incoming.height),
  declaredMimeType: existing.declaredMimeType ?? incoming.declaredMimeType,
  srcsetDescriptor: existing.srcsetDescriptor ?? incoming.srcsetDescriptor,
});

const pickLarger = (a: number | null, b: number | null): number | null => {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
};
