import type { Clock } from '../clock';
import {
  type BudgetCaps,
  budgetCapsPatchSchema,
  type FilterOptions,
  filterOptionsSchema,
  type JobConfig,
  jobConfigSchema,
} from '../config';
import { runCrawl } from '../crawler/crawler';
import type { Db } from '../db/open';
import { JobRepository, type JobRecord, type RepositoryError } from '../db/repository';
import { runDownloads } from '../download/downloader';
import type { FileStore } from '../download/file-store';
import { buildPageContext } from '../extract/context';
import { runExtractors } from '../extract/index';
import { ConcurrencyPool } from '../download/pool';
import { applyFilters } from '../filter/filter';
import { probe } from '../filter/probe';
import type { AssetId, JobId } from '../ids';
import { checkBudget, describeBreach } from '../job/budget';
import type { JobEvent } from '../job/events';
import { reduce } from '../job/reducer';
import { crawlSummaryFrom, type JobState, type JobSummary } from '../job/state';
import type { HttpClient } from '../net/http';
import type { SubprocessRunner } from '../media-tool/subprocess';
import type { Renderer } from '../render/renderer';
import { err, ok, type Result } from '../result';
import { EventBus, type Subscription } from './bus';
import { buildManifest, writeManifest } from './manifest';
import type { EventEnvelope } from './sse';

export type ServiceError =
  | { readonly kind: 'not-found'; readonly jobId: string }
  | { readonly kind: 'invalid-input'; readonly detail: string }
  | { readonly kind: 'invalid-state'; readonly detail: string }
  | { readonly kind: 'repository'; readonly detail: string };

export interface ServiceDeps {
  readonly db: Db;
  readonly http: HttpClient;
  readonly clock: Clock;
  readonly files: FileStore;
  readonly renderer?: Renderer | null;
  readonly subprocess?: SubprocessRunner | null;
}

type RunMode = 'running' | 'pausing' | 'cancelling';

interface ActiveRun {
  readonly controller: AbortController;
  mode: RunMode;
  readonly finished: Promise<void>;
}

const PROBE_CONCURRENCY = 6;
/** How many assets to measure between progress events. */
const PROBE_PROGRESS_EVERY = 10;

/**
 * The one place that owns the pipeline. Route handlers are thin adapters over
 * this; nothing in here knows about HTTP.
 */
export class JobService {
  readonly repo: JobRepository;
  private readonly bus = new EventBus<EventEnvelope>();
  private readonly active = new Map<JobId, ActiveRun>();

  constructor(private readonly deps: ServiceDeps) {
    this.repo = new JobRepository(deps.db);
  }

  /** Called once at startup: jobs the database still thinks are running are not. */
  recoverInterrupted(): JobId[] {
    return this.repo.rehydrateInterrupted(this.deps.clock.now());
  }

  createJob(input: unknown): Result<JobRecord, ServiceError> {
    const parsed = jobConfigSchema.safeParse(input);
    if (!parsed.success) {
      return err({ kind: 'invalid-input', detail: parsed.error.message });
    }
    return ok(this.repo.createJob(parsed.data, this.deps.clock.now()));
  }

  getJob(jobId: JobId): Result<JobRecord, ServiceError> {
    const record = this.repo.getJob(jobId);
    return record.ok ? record : err(toServiceError(record.error, jobId));
  }

  listJobs(limit = 50): JobRecord[] {
    return this.repo.listJobs(limit);
  }

  subscribe(jobId: JobId, fromSeq: number): Result<
    { readonly backlog: readonly EventEnvelope[]; readonly live: Subscription<EventEnvelope> },
    ServiceError
  > {
    const record = this.getJob(jobId);
    if (!record.ok) return record;

    // Subscribe before reading the backlog. The other order leaves a window
    // where an event fired between the two is in neither.
    const live = this.bus.subscribe(String(jobId));
    const stored = this.repo.eventsSince(jobId, fromSeq);
    if (!stored.ok) {
      live.close();
      return err(toServiceError(stored.error, jobId));
    }

    const backlog = stored.value.map((entry) => ({
      seq: entry.seq,
      event: entry.event,
      state: record.value.state,
    }));

    return ok({ backlog, live });
  }

  /**
   * The single write path for state. Every event goes through the reducer, is
   * persisted if durable, and only then reaches subscribers, so a client can
   * never observe a state the server has not committed.
   */
  dispatch(jobId: JobId, event: JobEvent): Result<JobState, ServiceError> {
    const record = this.repo.getJob(jobId);
    if (!record.ok) return err(toServiceError(record.error, jobId));

    const next = reduce(record.value.state, event);
    if (!next.ok) {
      return err({
        kind: 'invalid-state',
        detail:
          next.error.kind === 'invalid-transition'
            ? `${event.type} is not valid while ${next.error.from}`
            : next.error.message,
      });
    }

    const saved = this.repo.saveState(jobId, next.value, this.deps.clock.now());
    if (!saved.ok) return err(toServiceError(saved.error, jobId));

    const appended = this.repo.appendEvent(jobId, event, this.deps.clock.now());
    const seq = appended.ok ? appended.value : null;

    this.bus.publish(String(jobId), { seq, event, state: next.value });
    return ok(next.value);
  }

  startCrawl(jobId: JobId): Result<null, ServiceError> {
    const record = this.getJob(jobId);
    if (!record.ok) return record;
    if (this.active.has(jobId)) {
      return err({ kind: 'invalid-state', detail: 'this job is already running' });
    }

    const started = this.dispatch(jobId, { type: 'crawl/started', at: this.deps.clock.now() });
    if (!started.ok) return started;
    this.repo.markStarted(jobId, this.deps.clock.now());

    this.spawn(jobId, (controller) => this.crawlPipeline(record.value, controller));
    return ok(null);
  }

  startDownload(jobId: JobId): Result<null, ServiceError> {
    const record = this.getJob(jobId);
    if (!record.ok) return record;
    if (this.active.has(jobId)) {
      return err({ kind: 'invalid-state', detail: 'this job is already running' });
    }

    const counts = this.repo.countAssets(jobId);
    if (counts.selected === 0) {
      return err({ kind: 'invalid-state', detail: 'nothing is selected' });
    }

    const submitted = this.dispatch(jobId, {
      type: 'selection/submitted',
      at: this.deps.clock.now(),
      selected: counts.selected,
      bytesExpected: this.expectedBytes(jobId),
    });
    if (!submitted.ok) return submitted;

    this.spawn(jobId, (controller) => this.downloadPipeline(record.value, controller, undefined));
    return ok(null);
  }

  retryFailed(jobId: JobId): Result<number, ServiceError> {
    const record = this.getJob(jobId);
    if (!record.ok) return record;
    if (this.active.has(jobId)) {
      return err({ kind: 'invalid-state', detail: 'this job is already running' });
    }

    const assets = this.repo.listAssets(jobId, { selected: true, limit: 100_000 });
    if (!assets.ok) return err(toServiceError(assets.error, jobId));

    const failed = assets.value
      .filter((asset) => asset.download.status === 'failed')
      .map((asset) => asset.id);
    if (failed.length === 0) {
      return err({ kind: 'invalid-state', detail: 'there are no failed downloads to retry' });
    }

    const requested = this.dispatch(jobId, {
      type: 'download/retry-requested',
      at: this.deps.clock.now(),
      assetIds: failed,
      bytesExpected: null,
    });
    if (!requested.ok) return requested;

    this.spawn(jobId, (controller) => this.downloadPipeline(record.value, controller, failed));
    return ok(failed.length);
  }

  updateFilters(jobId: JobId, input: unknown): Result<FilterOptions, ServiceError> {
    const parsed = filterOptionsSchema.safeParse(input);
    if (!parsed.success) return err({ kind: 'invalid-input', detail: parsed.error.message });

    const record = this.getJob(jobId);
    if (!record.ok) return record;

    const config: JobConfig = { ...record.value.config, filters: parsed.data };
    this.deps.db
      .prepare('UPDATE jobs SET config_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(config), this.deps.clock.now(), jobId);

    const tally = this.reapply(jobId, parsed.data);
    if (!tally.ok) return tally;
    return ok(parsed.data);
  }

  setSelection(
    jobId: JobId,
    request: { readonly mode: 'all' | 'none' | 'ids'; readonly assetIds?: readonly AssetId[]; readonly selected?: boolean },
  ): Result<number, ServiceError> {
    const record = this.getJob(jobId);
    if (!record.ok) return record;

    if (request.mode === 'all') this.repo.setSelectionForIncluded(jobId, true, this.deps.clock.now());
    else if (request.mode === 'none')
      this.repo.setSelectionForIncluded(jobId, false, this.deps.clock.now());
    else {
      this.repo.setSelection(
        jobId,
        request.assetIds ?? [],
        request.selected ?? true,
        this.deps.clock.now(),
      );
    }

    const selected = this.repo.countAssets(jobId).selected;
    // A selection change outside the review phase is a no-op for state, not an
    // error: the counts still moved and the UI still wants to know.
    this.dispatch(jobId, { type: 'selection/changed', at: this.deps.clock.now(), selected });
    return ok(selected);
  }

  pause(jobId: JobId): Result<null, ServiceError> {
    const run = this.active.get(jobId);
    if (run === undefined) {
      return err({ kind: 'invalid-state', detail: 'this job is not running' });
    }
    run.mode = 'pausing';
    run.controller.abort();
    return ok(null);
  }

  cancel(jobId: JobId): Result<null, ServiceError> {
    const run = this.active.get(jobId);
    if (run !== undefined) {
      run.mode = 'cancelling';
      run.controller.abort();
      return ok(null);
    }

    const record = this.getJob(jobId);
    if (!record.ok) return record;
    const cancelled = this.dispatch(jobId, {
      type: 'job/cancelled',
      at: this.deps.clock.now(),
      summary: this.summaryFor(jobId, 'cancelled', record.value),
    });
    return cancelled.ok ? ok(null) : cancelled;
  }

  resume(jobId: JobId): Result<null, ServiceError> {
    const record = this.getJob(jobId);
    if (!record.ok) return record;
    if (record.value.state.status !== 'paused') {
      return err({ kind: 'invalid-state', detail: 'this job is not paused' });
    }
    if (this.active.has(jobId)) {
      return err({ kind: 'invalid-state', detail: 'this job is already running' });
    }

    // Time spent paused is not time spent working. Without crediting it back,
    // a job paused over lunch could never resume under a wall-clock cap.
    const now = this.deps.clock.now();
    this.repo.shiftStart(jobId, Math.max(0, now - record.value.state.pausedAt), now);

    // Resuming into a spent budget trips again on the first loop iteration and
    // lands straight back here. Check every cap, not just bytes, and say which
    // one needs raising.
    const current = this.repo.getJob(jobId);
    if (current.ok) {
      const headroom = checkBudget(
        current.value.ledger,
        current.value.config.caps,
        now,
        record.value.state.suspended.from === 'crawling' ? 'crawl' : 'download',
      );
      if (!headroom.ok) {
        return err({
          kind: 'invalid-state',
          detail: `${describeBreach(headroom.error)} — raise the ${headroom.error.cap} cap before resuming`,
        });
      }
    }

    const from = record.value.state.suspended.from;
    const resumed = this.dispatch(jobId, { type: 'job/resumed', at: now });
    if (!resumed.ok) return resumed;

    const latest = current.ok ? current.value : record.value;
    this.spawn(jobId, (controller) =>
      from === 'crawling'
        ? this.crawlPipeline(latest, controller)
        : this.downloadPipeline(latest, controller, undefined),
    );
    return ok(null);
  }

  updateCaps(jobId: JobId, input: unknown): Result<BudgetCaps, ServiceError> {
    const parsed = budgetCapsPatchSchema.safeParse(input);
    if (!parsed.success) return err({ kind: 'invalid-input', detail: parsed.error.message });

    const record = this.getJob(jobId);
    if (!record.ok) return record;

    // Only the keys actually named are touched; an absent key keeps its value
    // rather than reverting to the schema default.
    const caps: BudgetCaps = { ...record.value.config.caps };
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value !== undefined) caps[key as keyof BudgetCaps] = value;
    }

    const saved = this.repo.saveConfig(
      jobId,
      { ...record.value.config, caps },
      this.deps.clock.now(),
    );
    return saved.ok ? ok(caps) : err(toServiceError(saved.error, jobId));
  }

  /**
   * Ends discovery where it stopped and moves to review. A cap is meant to say
   * "stop early with what you have"; without this, a truncated crawl could
   * only go forwards or into the bin, and everything it found was unreachable.
   */
  finishDiscovery(jobId: JobId): Result<null, ServiceError> {
    const record = this.getJob(jobId);
    if (!record.ok) return record;
    if (this.active.has(jobId)) {
      return err({ kind: 'invalid-state', detail: 'this job is already running' });
    }

    const state = record.value.state;
    if (state.status !== 'paused' || state.suspended.from !== 'crawling') {
      return err({ kind: 'invalid-state', detail: 'discovery is not paused' });
    }

    const now = this.deps.clock.now();
    const summary = crawlSummaryFrom(
      state.suspended.crawl,
      state.startedAt,
      now,
      state.reason.kind === 'budget' ? state.reason.breach.cap : null,
    );

    // `crawl/finished` is only valid from `crawling`, so the job passes back
    // through that state rather than the machine growing a special case.
    const resumed = this.dispatch(jobId, { type: 'job/resumed', at: now });
    if (!resumed.ok) return resumed;

    const finished = this.dispatch(jobId, { type: 'crawl/finished', at: now, summary });
    if (!finished.ok) return finished;

    this.spawn(jobId, async (controller) => {
      await this.probeAll(jobId, record.value.config, controller.signal);
      this.reapply(jobId, record.value.config.filters);
    });
    return ok(null);
  }

  /** Test and shutdown helper: waits for whatever is in flight. */
  async settle(jobId: JobId): Promise<void> {
    await this.active.get(jobId)?.finished;
  }

  async shutdown(): Promise<void> {
    for (const [jobId, run] of this.active) {
      run.mode = 'pausing';
      run.controller.abort();
      await run.finished.catch(() => undefined);
      this.bus.closeTopic(String(jobId));
    }
  }

  private spawn(jobId: JobId, work: (controller: AbortController) => Promise<void>): void {
    const controller = new AbortController();
    const run: ActiveRun = {
      controller,
      mode: 'running',
      finished: Promise.resolve().then(async () => {
        try {
          await work(controller);
        } catch (cause) {
          this.dispatch(jobId, {
            type: 'job/failed',
            at: this.deps.clock.now(),
            error: {
              kind: 'internal',
              message: cause instanceof Error ? cause.message : 'unexpected failure',
            },
          });
        } finally {
          this.active.delete(jobId);
        }
      }),
    };
    this.active.set(jobId, run);
  }

  private modeOf(jobId: JobId): RunMode {
    return this.active.get(jobId)?.mode ?? 'running';
  }

  private async crawlPipeline(record: JobRecord, controller: AbortController): Promise<void> {
    const { id: jobId, config } = record;

    const result = await runCrawl(
      {
        http: this.deps.http,
        clock: this.deps.clock,
        db: this.deps.db,
        emit: (event) => void this.dispatch(jobId, event),
        renderer: this.deps.renderer ?? null,
      },
      {
        jobId,
        config,
        ledger: record.ledger,
        signal: controller.signal,
        onPage: (page) => {
          const context = buildPageContext({
            pageUrl: page.url,
            html: page.html,
            networkLog: page.networkLog,
            computedBackgrounds: page.computedBackgrounds,
          });
          const { candidates, uniqueUrls } = runExtractors(context);
          const upserted = this.repo.upsertCandidates(jobId, candidates, this.deps.clock.now());
          const newlySeen = upserted.ok
            ? upserted.value.filter((outcome) => outcome.isNew).length
            : 0;

          this.repo.creditLedger(jobId, { pages: 1 }, this.deps.clock.now());
          return { found: candidates.length, unique: Math.min(newlySeen, uniqueUrls), bytesProjectedDelta: 0 };
        },
      },
    );

    if (!result.ok) {
      this.dispatch(jobId, { type: 'job/failed', at: this.deps.clock.now(), error: result.error });
      return;
    }

    // Order matters: pausing also aborts the run, so the crawler reports
    // `cancelled` either way. Only the run mode distinguishes the two, and
    // checking `stopped` first would turn every pause into a cancellation.
    const mode = this.modeOf(jobId);
    if (mode === 'pausing') {
      this.dispatch(jobId, { type: 'job/paused', at: this.deps.clock.now() });
      return;
    }
    if (mode === 'cancelling' || result.value.stopped === 'cancelled') {
      this.dispatch(jobId, {
        type: 'job/cancelled',
        at: this.deps.clock.now(),
        summary: this.summaryFor(jobId, 'cancelled', record),
      });
      return;
    }
    if (result.value.stopped === 'budget' && result.value.breach !== null) {
      this.dispatch(jobId, {
        type: 'budget/breached',
        at: this.deps.clock.now(),
        breach: result.value.breach,
      });
      return;
    }

    this.dispatch(jobId, {
      type: 'crawl/finished',
      at: this.deps.clock.now(),
      summary: result.value.summary,
    });

    await this.probeAll(jobId, config, controller.signal);
    this.reapply(jobId, config.filters);
  }

  /**
   * Probing is a separate pass rather than part of extraction: it needs a
   * network round trip per asset, and the crawl should not wait on it.
   */
  private async probeAll(jobId: JobId, config: JobConfig, signal: AbortSignal): Promise<void> {
    const assets = this.repo.listAssets(jobId, { limit: 100_000 });
    if (!assets.ok) return;

    const pool = new ConcurrencyPool(PROBE_CONCURRENCY, config.download.perHostConcurrency);

    const pending = assets.value.filter(
      (asset) => asset.probe.status === 'unprobed' && asset.acquisition.strategy === 'direct',
    );
    const total = pending.length;
    let probed = 0;

    // Batched, because one event per asset would be thousands of SSE frames on
    // a large job to say something the client can only act on in bulk anyway.
    const report = (): void => {
      probed += 1;
      if (probed % PROBE_PROGRESS_EVERY !== 0 && probed !== total) return;
      this.dispatch(jobId, {
        type: 'probe/progress',
        at: this.deps.clock.now(),
        probed,
        total,
      });
    };

    await Promise.all(
      pending
        .map(async (asset) => {
          if (signal.aborted) return;
          let host = 'unknown';
          try {
            host = new URL(asset.url).host;
          } catch {
            // Keeps the default bucket.
          }

          await pool.run(host, async () => {
            if (signal.aborted) return;
            const state = await probe(this.deps.http, {
              url: asset.url,
              wantDimensions:
                (asset.kind === 'image' || asset.kind === 'gif') &&
                (asset.hints.width === null || asset.hints.height === null),
              options: {
                userAgent: config.crawl.userAgent,
                timeoutMs: config.crawl.requestTimeoutMs,
                signal,
              },
            });
            this.repo.setProbe(asset.id, state, this.deps.clock.now());
            report();
          });
        }),
    );
  }

  private reapply(jobId: JobId, filters: FilterOptions): Result<null, ServiceError> {
    const assets = this.repo.listAssets(jobId, { limit: 100_000 });
    if (!assets.ok) return err(toServiceError(assets.error, jobId));

    const { tally, verdicts } = applyFilters(assets.value, filters);
    const now = this.deps.clock.now();

    this.repo.transaction(() => {
      for (const [assetId, verdict] of verdicts) this.repo.setFilterVerdict(assetId, verdict, now);
    });

    this.dispatch(jobId, {
      type: 'filters/applied',
      at: now,
      eligible: tally.eligible,
      filteredOut: tally.filteredOut,
    });
    return ok(null);
  }

  private async downloadPipeline(
    record: JobRecord,
    controller: AbortController,
    assetIds: readonly AssetId[] | undefined,
  ): Promise<void> {
    const { id: jobId } = record;
    const current = this.repo.getJob(jobId);
    const config = current.ok ? current.value.config : record.config;
    const ledger = current.ok ? current.value.ledger : record.ledger;

    const result = await runDownloads(
      {
        http: this.deps.http,
        clock: this.deps.clock,
        files: this.deps.files,
        repo: this.repo,
        emit: (event) => void this.dispatch(jobId, event),
        subprocess: this.deps.subprocess ?? null,
      },
      {
        jobId,
        config,
        ledger,
        signal: controller.signal,
        ...(assetIds === undefined ? {} : { assetIds }),
      },
    );

    if (!result.ok) {
      this.dispatch(jobId, { type: 'job/failed', at: this.deps.clock.now(), error: result.error });
      return;
    }

    // Same ordering rule as the crawl pipeline: pause and cancel are told
    // apart by the run mode, not by how the runner stopped.
    const mode = this.modeOf(jobId);
    if (mode === 'pausing') {
      this.dispatch(jobId, { type: 'job/paused', at: this.deps.clock.now() });
      return;
    }
    if (mode === 'cancelling' || result.value.stopped === 'cancelled') {
      this.dispatch(jobId, {
        type: 'job/cancelled',
        at: this.deps.clock.now(),
        summary: { ...result.value.summary, outcome: 'cancelled' },
      });
      return;
    }
    if (result.value.stopped === 'budget' && result.value.breach !== null) {
      this.dispatch(jobId, {
        type: 'budget/breached',
        at: this.deps.clock.now(),
        breach: result.value.breach,
      });
      return;
    }

    const manifestPath = await this.emitManifest(jobId, config);
    this.dispatch(jobId, {
      type: 'download/finished',
      at: this.deps.clock.now(),
      summary: { ...result.value.summary, manifestPath },
    });
  }

  private async emitManifest(jobId: JobId, config: JobConfig): Promise<string | null> {
    if (!config.output.writeManifest) return null;

    const assets = this.repo.listAssets(jobId, { limit: 100_000 });
    if (!assets.ok) return null;

    const manifest = buildManifest(jobId, config, assets.value, new Date(this.deps.clock.now()));
    const written = await writeManifest(this.deps.files, config, manifest);
    return written.ok ? written.value : null;
  }

  private expectedBytes(jobId: JobId): number | null {
    const assets = this.repo.listAssets(jobId, { selected: true, limit: 100_000 });
    if (!assets.ok) return null;

    let total = 0;
    let known = false;
    for (const asset of assets.value) {
      if (asset.probe.status === 'probed' && asset.probe.contentLength !== null) {
        total += asset.probe.contentLength;
        known = true;
      }
    }
    return known ? total : null;
  }

  private summaryFor(
    jobId: JobId,
    outcome: 'finished' | 'cancelled',
    record: JobRecord,
  ): JobSummary {
    return buildSummary(this.repo, jobId, outcome, record, this.deps.clock.now());
  }
}

const buildSummary = (
  repo: JobRepository,
  jobId: JobId,
  outcome: 'finished' | 'cancelled',
  record: JobRecord,
  now: number,
): JobSummary => {
  const assets = repo.listAssets(jobId, { limit: 100_000 });
  const list = assets.ok ? assets.value : [];

  return {
    outcome,
    downloaded: list.filter((asset) => asset.download.status === 'complete').length,
    skippedDuplicate: list.filter((asset) => asset.download.status === 'skipped-duplicate').length,
    filteredOut: list.filter((asset) => asset.filter.verdict === 'excluded').length,
    failed: list.filter((asset) => asset.download.status === 'failed').length,
    bytesWritten: record.ledger.bytesWritten,
    durationMs: Math.max(0, now - record.ledger.startedAt),
    manifestPath: null,
    finishedAt: now,
  };
};

const toServiceError = (error: RepositoryError, jobId: string): ServiceError => {
  if (error.kind === 'not-found') return { kind: 'not-found', jobId };
  return { kind: 'repository', detail: error.kind === 'corrupt-row' ? error.detail : error.detail };
};
