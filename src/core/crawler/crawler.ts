import type { Clock } from "../clock";
import type { JobConfig } from "../config";
import type { Db } from "../db/open";
import type { JobId, PageId } from "../ids";
import {
    type BudgetBreach,
    type BudgetLedger,
    checkBudget,
    creditPage,
} from "../job/budget";
import type { ComputedBackground, NetworkRecord } from "../extract/context";
import { classifyKind } from "../extract/css-urls";
import type { JobEvent } from "../job/events";
import type { Renderer } from "../render/renderer";
import { shouldEscalate } from "../render/renderer";
import { type CrawlSummary, type JobError } from "../job/state";
import { err, ok, type Result } from "../result";
import { normalizeUrl } from "../url";
import { Frontier } from "./frontier";
import {
    contentTypeOf,
    decodeText,
    describeHttpError,
    type HttpClient,
    isHtml,
} from "../net/http";
import { HostRateLimiter } from "./rate-limiter";
import { decideUrl, RobotsRegistry } from "./robots-registry";
import { collectSitemapUrls } from "./sitemap";
import { decideScope, extractLinks, readMetaRobots } from "./scope";

export type RenderMode = "static" | "rendered";

export interface FetchedPage {
    readonly id: PageId;
    readonly url: string;
    readonly normalizedUrl: string;
    readonly depth: number;
    readonly status: number;
    readonly contentType: string | null;
    readonly html: string;
    readonly renderMode: RenderMode;
    /** Non-empty only for rendered pages; this is where `.m3u8` URLs come from. */
    readonly networkLog: readonly NetworkRecord[];
    readonly computedBackgrounds: readonly ComputedBackground[];
}

/** What the extractor layer reports back after seeing a page. */
export interface AssetDiscovery {
    readonly found: number;
    readonly unique: number;
    readonly bytesProjectedDelta: number;
}

export const noDiscovery: AssetDiscovery = {
    found: 0,
    unique: 0,
    bytesProjectedDelta: 0,
};

export interface CrawlDeps {
    readonly http: HttpClient;
    readonly clock: Clock;
    readonly db: Db;
    readonly emit: (event: JobEvent) => void;
    /** Omit to stay on the static path entirely; the crawl still works. */
    readonly renderer?: Renderer | null;
}

export interface CrawlRequest {
    readonly jobId: JobId;
    readonly config: JobConfig;
    readonly ledger: BudgetLedger;
    readonly signal: AbortSignal;
    /** Milestone 3 wires the extractors in here; until then it can be a stub. */
    readonly onPage: (
        page: FetchedPage
    ) => Promise<AssetDiscovery> | AssetDiscovery;
}

export interface CrawlResult {
    readonly stopped: "finished" | "cancelled" | "budget";
    readonly summary: CrawlSummary;
    readonly breach: BudgetBreach | null;
    readonly ledger: BudgetLedger;
}

const SITEMAP_INDEX_DEPTH = 3;
/** Ceilings on the seeding step, so it can never become the whole run. */
const SITEMAP_MAX_DOCUMENTS = 50;
const SITEMAP_BUDGET_MS = 30_000;
/** Above this, a per-host delay is worth telling the user about. */
const SLOW_DELAY_MS = 2_000;
/** How long an idle worker waits before looking for work again. */
const IDLE_POLL_MS = 25;

/**
 * Runs discovery to completion, cancellation, or a budget breach. Downloads
 * nothing: the output is a frontier walked and a manifest of candidates handed
 * to `onPage`.
 */
export const runCrawl = async (
    deps: CrawlDeps,
    request: CrawlRequest
): Promise<Result<CrawlResult, JobError>> => {
    const { config, jobId, signal } = request;
    const startedAt = deps.clock.now();

    const seed = normalizeUrl(config.seedUrl);
    if (!seed.ok) {
        return err({
            kind: "seed-unreachable",
            url: config.seedUrl,
            message: "not a usable URL",
        });
    }
    const seedUrl = seed.value;

    const requestOptions = {
        timeoutMs: config.crawl.requestTimeoutMs,
        signal,
    };

    const robots = new RobotsRegistry(
        deps.http,
        deps.db,
        config.crawl.userAgent
    );
    const limiter = new HostRateLimiter(
        deps.clock,
        config.crawl.requestDelayMs
    );
    const frontier = new Frontier(deps.db, jobId);

    // The seed decides the whole run, so it is checked before anything is queued.
    const seedRobots = await robots.forUrl(seedUrl, requestOptions, startedAt);
    if (!seedRobots.ok)
        return err({ kind: "internal", message: "robots lookup failed" });
    const seedDecision = decideUrl(seedRobots.value, seedUrl);
    if (seedDecision.kind === "disallowed") {
        return err({
            kind: "robots-denied",
            url: seedUrl,
            reason: "disallowed",
        });
    }
    if (seedDecision.kind === "unavailable") {
        return err({
            kind: "robots-denied",
            url: seedUrl,
            reason: "robots-unavailable",
        });
    }

    frontier.requeueStale();
    frontier.enqueue(seedUrl, 0, null, startedAt);

    // Sitemap URLs enter at depth 1, so at depth 0 every one of them would be
    // discarded as out of scope. Reading the sitemap at all is pure cost, and on
    // a large site it is minutes of it before the seed page is ever fetched.
    if (config.crawl.followSitemap && config.crawl.maxDepth > 0) {
        await seedFromSitemaps(
            deps,
            {
                seedUrl,
                config,
                requestOptions,
                sitemaps: seedRobots.value.sitemaps,
            },
            frontier,
            startedAt
        );
    }

    let ledger = request.ledger;
    // Held in one object rather than two `let`s: TypeScript drops the narrowing
    // on locals that only closures assign, and `breach` would read as `never`.
    const stop: {
        reason: CrawlResult["stopped"];
        breach: BudgetBreach | null;
    } = {
        reason: "finished",
        breach: null,
    };
    let pagesVisited = 0;
    let pagesFailed = 0;
    let pagesSkipped = 0;
    let uniqueAssets = 0;
    let bytesProjected = 0;
    let inFlight = 0;
    const announcedDelay = new Set<string>();

    const halt = (
        reason: CrawlResult["stopped"],
        cause: BudgetBreach | null
    ): void => {
        if (stop.reason === "finished") stop.reason = reason;
        if (cause !== null) stop.breach ??= cause;
    };

    const skip = (
        entry: NonNullable<ReturnType<Frontier["claim"]>>,
        state: Parameters<Frontier["markSkipped"]>[1],
        reason: string,
        at: number
    ): void => {
        pagesSkipped += 1;
        frontier.markSkipped(entry.id, state, reason, at);
        // A page dropped in silence is indistinguishable from a page that was
        // never found. Say why, or the run looks like it did nothing.
        deps.emit({
            type: "crawl/page-skipped",
            at,
            url: entry.url,
            reason,
            queueDepth: frontier.queueDepth(),
        });
    };

    const processEntry = async (
        entry: ReturnType<Frontier["claim"]>
    ): Promise<void> => {
        if (entry === null) return;
        const now = deps.clock.now();

        const scope = decideScope(
            entry.url,
            entry.depth,
            seedUrl,
            config.crawl
        );
        if (scope.kind !== "in-scope") {
            skip(
                entry,
                "skipped-scope",
                scope.kind === "too-deep"
                    ? "past the depth limit"
                    : `off-origin: ${scope.host}`,
                now
            );
            return;
        }

        const host = new URL(entry.url).host.toLowerCase();
        const hostRobots = await robots.forUrl(entry.url, requestOptions, now);
        if (hostRobots.ok) {
            const decision = decideUrl(hostRobots.value, entry.url);
            if (decision.kind === "disallowed") {
                skip(
                    entry,
                    "skipped-robots",
                    `robots.txt disallows ${decision.pattern}`,
                    now
                );
                return;
            }
            if (decision.kind === "unavailable") {
                skip(
                    entry,
                    "skipped-robots",
                    "robots.txt could not be read",
                    now
                );
                return;
            }
        }

        const crawlDelayMs = hostRobots.ok
            ? hostRobots.value.crawlDelayMs
            : null;
        const effectiveDelay = limiter.delayFor(crawlDelayMs);

        // Waiting on a rate limit looks identical to being hung. Say so once per
        // host rather than sitting silent on a page that is merely queued.
        if (effectiveDelay >= SLOW_DELAY_MS && !announcedDelay.has(host)) {
            announcedDelay.add(host);
            const source =
                crawlDelayMs !== null && crawlDelayMs >= effectiveDelay
                    ? `${host} asks for`
                    : "You configured";
            deps.emit({
                type: "crawl/notice",
                at: now,
                message: `${source} ${Math.round(effectiveDelay / 1000)}s between requests${
                    crawlDelayMs !== null && crawlDelayMs >= effectiveDelay
                        ? " (robots.txt Crawl-delay)"
                        : ""
                }. Pages will arrive slowly.`,
            });
        }

        await limiter.acquire(host, crawlDelayMs, signal);
        if (signal.aborted) {
            skip(entry, "skipped-scope", "cancelled", deps.clock.now());
            halt("cancelled", null);
            return;
        }

        const response = await deps.http.get(entry.url, {
            ...requestOptions,
            userAgent: config.crawl.userAgent,
        });
        const visitedAt = deps.clock.now();

        // The page counts against the budget whether or not it parsed.
        ledger = creditPage(ledger);
        const budget = checkBudget(ledger, config.caps, visitedAt, "crawl");
        if (!budget.ok) halt("budget", budget.error);

        if (!response.ok) {
            pagesFailed += 1;
            const reason = describeHttpError(response.error);
            frontier.markFailed(entry.id, reason, null, visitedAt);
            deps.emit({
                type: "crawl/page-failed",
                at: visitedAt,
                url: entry.url,
                reason,
                queueDepth: frontier.queueDepth(),
            });
            if (response.error.kind === "aborted") halt("cancelled", null);
            return;
        }

        const { status } = response.value;
        if (status >= 400) {
            pagesFailed += 1;
            frontier.markFailed(entry.id, `HTTP ${status}`, status, visitedAt);
            deps.emit({
                type: "crawl/page-failed",
                at: visitedAt,
                url: entry.url,
                reason: `HTTP ${status}`,
                queueDepth: frontier.queueDepth(),
            });
            return;
        }

        // A redirect can land somewhere the original URL's scope check never saw.
        const finalScope = decideScope(
            response.value.url,
            entry.depth,
            seedUrl,
            config.crawl
        );
        if (finalScope.kind !== "in-scope") {
            skip(
                entry,
                "skipped-scope",
                `redirected off-origin to ${response.value.url}`,
                visitedAt
            );
            return;
        }

        const contentType = contentTypeOf(response.value);
        if (!isHtml(response.value)) {
            skip(
                entry,
                "skipped-type",
                `not HTML (${contentType ?? "no content type"})`,
                visitedAt
            );
            return;
        }

        const staticHtml = decodeText(response.value);

        // Escalate only when the static parse looks untrustworthy. Chromium costs
        // orders of magnitude more than being occasionally wrong about that.
        let html = staticHtml;
        let renderMode: RenderMode = "static";
        let networkLog: readonly NetworkRecord[] = [];
        let computedBackgrounds: readonly ComputedBackground[] = [];

        const renderer = deps.renderer ?? null;
        if (renderer !== null) {
            const decision = shouldEscalate(staticHtml, config.renderer);
            if (decision.escalate) {
                const rendered = await renderer.render(response.value.url, {
                    userAgent: config.crawl.userAgent,
                    timeoutMs: config.renderer.timeoutMs,
                    networkIdleMs: config.renderer.networkIdleMs,
                    signal,
                });
                // A render failure is not a page failure: the static HTML is still
                // usable, just thinner than it might have been.
                if (rendered.ok) {
                    html = rendered.value.html;
                    renderMode = "rendered";
                    networkLog = rendered.value.networkLog;
                    computedBackgrounds = rendered.value.computedBackgrounds;
                }
            }
        }

        frontier.markFetched(
            entry.id,
            { httpStatus: status, contentType, renderMode },
            visitedAt
        );
        pagesVisited += 1;

        const meta = readMetaRobots(html);
        if (!meta.nofollow && entry.depth < config.crawl.maxDepth) {
            const links = extractLinks(html, response.value.url).filter(
                (link) =>
                    decideScope(link, entry.depth + 1, seedUrl, config.crawl)
                        .kind === "in-scope" &&
                    // A link straight to a file is an asset, and the extractors already
                    // collected it. Queueing it as a page just spends a request to
                    // discover it is not HTML.
                    classifyKind(link, null) === null
            );
            frontier.enqueueMany(links, entry.depth + 1, entry.id, visitedAt);
        }

        deps.emit({
            type: "crawl/page-visited",
            at: visitedAt,
            url: entry.url,
            depth: entry.depth,
            queueDepth: frontier.queueDepth(),
        });``

        const discovery = await request.onPage({
            id: entry.id,
            url: response.value.url,
            normalizedUrl: entry.normalizedUrl,
            depth: entry.depth,
            status,
            contentType,
            html,
            renderMode,
            networkLog,
            computedBackgrounds,
        });

        if (discovery.found > 0 || discovery.unique > 0) {
            uniqueAssets += discovery.unique;
            bytesProjected += discovery.bytesProjectedDelta;
            deps.emit({
                type: "crawl/assets-discovered",
                at: deps.clock.now(),
                found: discovery.found,
                unique: discovery.unique,
                bytesProjectedDelta: discovery.bytesProjectedDelta,
            });
        }
    };

    const worker = async (): Promise<void> => {
        for (;;) {
            if (signal.aborted) {
                halt("cancelled", null);
                return;
            }
            if (stop.reason !== "finished") return;

            const elapsed = checkBudget(
                ledger,
                config.caps,
                deps.clock.now(),
                "crawl"
            );
            if (!elapsed.ok) {
                halt("budget", elapsed.error);
                return;
            }

            const entry = frontier.claim();
            if (entry === null) {
                // Another worker may still be about to enqueue more links.
                if (inFlight === 0) return;
                // A real interval, not zero: spare workers idle here for the whole of
                // a fetch, and a hot loop would keep the event loop too busy to ever
                // finish that fetch.
                await deps.clock.sleep(IDLE_POLL_MS);
                continue;
            }

            inFlight += 1;
            try {
                await processEntry(entry);
            } finally {
                inFlight -= 1;
            }
        }
    };

    const workerCount = Math.max(1, config.crawl.maxConcurrentPages);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const finishedAt = deps.clock.now();
    const summary: CrawlSummary = {
        pagesVisited,
        pagesFailed,
        pagesSkipped,
        uniqueAssets,
        bytesProjected,
        durationMs: Math.max(0, finishedAt - startedAt),
        truncatedBy: stop.breach?.cap ?? null,
        finishedAt,
    };

    return ok({ stopped: stop.reason, summary, breach: stop.breach, ledger });
};

interface SitemapSeedContext {
    readonly seedUrl: string;
    readonly config: JobConfig;
    readonly requestOptions: {
        readonly timeoutMs: number;
        readonly signal: AbortSignal;
    };
    readonly sitemaps: readonly string[];
}

/**
 * Sitemap URLs enter at depth 1, not 0: `maxDepth: 0` should still mean "just
 * the page I gave you".
 */
const seedFromSitemaps = async (
    deps: CrawlDeps,
    context: SitemapSeedContext,
    frontier: Frontier,
    now: number
): Promise<void> => {
    const origin = new URL(context.seedUrl).origin;
    const roots = [...new Set([...context.sitemaps, `${origin}/sitemap.xml`])];

    deps.emit({ type: "crawl/notice", at: now, message: "Reading sitemap…" });

    const collected = await collectSitemapUrls(deps.http, roots, {
        maxUrls: context.config.caps.maxPagesCrawled,
        maxIndexDepth: SITEMAP_INDEX_DEPTH,
        maxDocuments: SITEMAP_MAX_DOCUMENTS,
        deadline: deps.clock.now() + SITEMAP_BUDGET_MS,
        now: () => deps.clock.now(),
        request: {
            ...context.requestOptions,
            userAgent: context.config.crawl.userAgent,
        },
    });

    const inScope = collected.urls.filter(
        (url) =>
            decideScope(url, 1, context.seedUrl, context.config.crawl).kind ===
            "in-scope"
    );
    const added = frontier.enqueueMany(inScope, 1, null, now);

    deps.emit({
        type: "crawl/notice",
        at: deps.clock.now(),
        message:
            collected.sitemapsRead === 0
                ? "No sitemap found; following links instead."
                : `Sitemap: ${added} page(s) queued from ${collected.sitemapsRead} file(s)${
                      collected.truncated ? ", stopped early" : ""
                  }.`,
    });
};
