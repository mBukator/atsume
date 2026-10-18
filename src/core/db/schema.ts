/**
 * DDL lives in TypeScript rather than a `.sql` file so it survives Next.js
 * bundling without a filesystem read at runtime. Migrations are append-only and
 * indexed by `PRAGMA user_version`.
 */
export const MIGRATIONS: readonly string[] = [
  // 1 — initial schema
  `
  CREATE TABLE jobs (
    id            TEXT    PRIMARY KEY,
    seed_url      TEXT    NOT NULL,
    status        TEXT    NOT NULL,
    config_json   TEXT    NOT NULL,
    state_json    TEXT    NOT NULL,
    pages_crawled INTEGER NOT NULL DEFAULT 0,
    files_written INTEGER NOT NULL DEFAULT 0,
    bytes_written INTEGER NOT NULL DEFAULT 0,
    started_at    INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE INDEX idx_jobs_updated ON jobs (updated_at DESC);

  CREATE TABLE pages (
    id              TEXT    PRIMARY KEY,
    job_id          TEXT    NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    url             TEXT    NOT NULL,
    normalized_url  TEXT    NOT NULL,
    depth           INTEGER NOT NULL,
    discovered_from TEXT,
    -- queued | fetching | fetched | failed | skipped-robots | skipped-scope
    fetch_state     TEXT    NOT NULL DEFAULT 'queued',
    render_mode     TEXT,
    http_status     INTEGER,
    content_type    TEXT,
    error_json      TEXT,
    queued_at       INTEGER NOT NULL,
    visited_at      INTEGER,
    UNIQUE (job_id, normalized_url)
  );

  CREATE INDEX idx_pages_frontier ON pages (job_id, fetch_state, depth);

  CREATE TABLE assets (
    id               TEXT    PRIMARY KEY,
    job_id           TEXT    NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    url              TEXT    NOT NULL,
    normalized_url   TEXT    NOT NULL,
    kind             TEXT    NOT NULL,
    acquisition_json TEXT    NOT NULL,
    hints_json       TEXT    NOT NULL,
    probe_json       TEXT    NOT NULL,
    filter_json      TEXT    NOT NULL,
    selected         INTEGER NOT NULL DEFAULT 0,
    download_json    TEXT    NOT NULL,
    content_sha256   TEXT,
    local_path       TEXT,
    bytes            INTEGER,
    first_seen_at    INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    UNIQUE (job_id, normalized_url)
  );

  CREATE INDEX idx_assets_selection ON assets (job_id, selected);
  CREATE INDEX idx_assets_kind ON assets (job_id, kind);
  -- Duplicate detection is a lookup on this index, not a table scan.
  CREATE INDEX idx_assets_hash ON assets (job_id, content_sha256);

  -- One asset can be reached from many pages by many extractors. Provenance is
  -- a separate table so the manifest can report all of them.
  CREATE TABLE asset_sources (
    asset_id      TEXT    NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
    page_url      TEXT    NOT NULL,
    extractor     TEXT    NOT NULL,
    alt           TEXT,
    discovered_at INTEGER NOT NULL,
    PRIMARY KEY (asset_id, page_url, extractor)
  );

  -- Durable events only. Sequence numbers double as SSE Last-Event-ID.
  CREATE TABLE job_events (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT    NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    type         TEXT    NOT NULL,
    payload_json TEXT    NOT NULL,
    created_at   INTEGER NOT NULL
  );

  CREATE INDEX idx_job_events_stream ON job_events (job_id, seq);

  CREATE TABLE robots_cache (
    host           TEXT    PRIMARY KEY,
    body           TEXT,
    status         INTEGER,
    crawl_delay_ms INTEGER,
    fetched_at     INTEGER NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
