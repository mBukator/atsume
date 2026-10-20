import { describe, expect, it } from "vitest";
import { jobConfigSchema, type JobConfig } from "../config";
import { type Db, openDatabase } from "../db/open";
import { JobRepository } from "../db/repository";
import type { JobId } from "../ids";
import { emptyLedger } from "../job/budget";
import type { JobEvent } from "../job/events";
import {
    type AssetDiscovery,
    type CrawlResult,
    type FetchedPage,
    noDiscovery,
    runCrawl,
} from "./crawler";
import { Frontier } from "./frontier";
import {
    FakeHttpClient,
    FakeRenderer,
    type FakeResponseSpec,
    htmlPage,
    linksTo,
    ManualClock,
} from "../testing";

const T0 = 1_700_000_000_000;
const SEED = "https://a.test/";

interface RunOptions {
    readonly routes: Readonly<Record<string, FakeResponseSpec>>;
    readonly config?: Partial<{
        crawl: unknown;
        caps: unknown;
        renderer: unknown;
    }>;
    readonly onPage?: (url: string) => AssetDiscovery;
    readonly abortAfter?: number;
    /** Reuse a database across runs to exercise caching and resumption. */
    readonly db?: Db;
    readonly prepare?: (db: Db, jobId: JobId) => void;
    readonly renderer?: FakeRenderer;
    readonly onPageFull?: (page: FetchedPage) => AssetDiscovery;
}

interface RunOutput {
    readonly result: CrawlResult | null;
    readonly error: unknown;
    readonly events: JobEvent[];
    readonly http: FakeHttpClient;
    readonly clock: ManualClock;
    readonly frontier: Frontier;
    readonly db: Db;
    readonly jobId: JobId;
}

const freshDb = (): Db => openDatabase(":memory:");

const crawl = async (options: RunOptions): Promise<RunOutput> => {
    const config: JobConfig = jobConfigSchema.parse({
        seedUrl: SEED,
        output: { directory: "/tmp/out" },
        ...options.config,
    });

    // Each run gets its own database unless a test deliberately shares one; the
    // robots cache and the frontier both outlive a single crawl by design.
    const db = options.db ?? freshDb();
    const jobId = new JobRepository(db).createJob(config, T0).id;
    options.prepare?.(db, jobId);

    const clock = new ManualClock(T0);
    const http = new FakeHttpClient(options.routes, clock);
    const events: JobEvent[] = [];
    const controller = new AbortController();
    let pageCount = 0;

    const outcome = await runCrawl(
        {
            http,
            clock,
            db,
            emit: (event) => events.push(event),
            renderer: options.renderer ?? null,
        },
        {
            jobId,
            config,
            ledger: emptyLedger(T0),
            signal: controller.signal,
            onPage: (page) => {
                pageCount += 1;
                if (
                    options.abortAfter !== undefined &&
                    pageCount >= options.abortAfter
                )
                    controller.abort();
                return (
                    options.onPageFull?.(page) ??
                    options.onPage?.(page.url) ??
                    noDiscovery
                );
            },
        }
    );

    return {
        result: outcome.ok ? outcome.value : null,
        error: outcome.ok ? null : outcome.error,
        events,
        http,
        clock,
        frontier: new Frontier(db, jobId),
        db,
        jobId,
    };
};

const visited = (output: RunOutput): string[] =>
    output.events
        .filter(
            (
                event
            ): event is Extract<JobEvent, { type: "crawl/page-visited" }> =>
                event.type === "crawl/page-visited"
        )
        .map((event) => event.url);

describe("link following", () => {
    it("walks the graph breadth-first within the depth limit", async () => {
        const output = await crawl({
            config: { crawl: { maxDepth: 1, maxConcurrentPages: 1 } },
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo("/one", "/two"),
                "https://a.test/one": linksTo("/deep"),
                "https://a.test/two": linksTo("/deep"),
                "https://a.test/deep": linksTo(),
            },
        });

        expect(visited(output).sort()).toEqual([
            "https://a.test/",
            "https://a.test/one",
            "https://a.test/two",
        ]);
        expect(output.result?.summary.pagesVisited).toBe(3);
    });

    it("fetches a page reachable from two parents only once", async () => {
        const output = await crawl({
            config: { crawl: { maxDepth: 3, maxConcurrentPages: 1 } },
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo("/one", "/two"),
                "https://a.test/one": linksTo("/shared"),
                "https://a.test/two": linksTo("/shared"),
                "https://a.test/shared": linksTo(),
            },
        });

        expect(output.http.countFor("https://a.test/shared")).toBe(1);
    });

    it("does not queue a linked file as a page, trailing slash and all", async () => {
        // A gallery of tokenised originals. Each href is an asset the
        // extractors claim, so spending a request to learn it is not HTML —
        // once per item, behind the crawl delay — is pure waste.
        const output = await crawl({
            config: { crawl: { maxDepth: 1, maxConcurrentPages: 1 } },
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: htmlPage(
                    '<a href="/get_image/2/abc/21663.jpg/?1-acctoken=W1c1"><img src="/t/1.jpg"></a>' +
                        '<a href="/album/next/">Next</a>'
                ),
                "https://a.test/album/next/": linksTo(),
            },
        });

        expect(
            output.http
                .urlsRequested()
                .some((url) => url.includes("get_image"))
        ).toBe(false);
        expect(output.http.urlsRequested()).toContain(
            "https://a.test/album/next/"
        );
        expect(output.result?.summary.pagesSkipped).toBe(0);
    });

    it("leaves other origins alone", async () => {
        const output = await crawl({
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo("https://elsewhere.test/page", "/local"),
                "https://a.test/local": linksTo(),
            },
        });

        expect(output.http.urlsRequested()).not.toContain(
            "https://elsewhere.test/page"
        );
        expect(visited(output)).toContain("https://a.test/local");
    });

    it("stops following links when meta robots says nofollow", async () => {
        const output = await crawl({
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: {
                    status: 200,
                    body: '<meta name="robots" content="nofollow"><a href="/hidden">x</a>',
                },
                "https://a.test/hidden": linksTo(),
            },
        });

        expect(visited(output)).toEqual(["https://a.test/"]);
    });
});

describe("robots.txt", () => {
    it("refuses to start when the seed itself is disallowed", async () => {
        const output = await crawl({
            routes: {
                "https://a.test/robots.txt": {
                    status: 200,
                    contentType: "text/plain",
                    body: "User-agent: *\nDisallow: /",
                },
                [SEED]: linksTo(),
            },
        });

        expect(output.result).toBeNull();
        expect(output.error).toEqual({
            kind: "robots-denied",
            url: SEED,
            reason: "disallowed",
        });
        expect(output.http.countFor(SEED)).toBe(0);
    });

    it("skips disallowed pages but keeps crawling the rest", async () => {
        const output = await crawl({
            routes: {
                "https://a.test/robots.txt": {
                    status: 200,
                    contentType: "text/plain",
                    body: "User-agent: *\nDisallow: /private",
                },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo("/private/secret", "/public"),
                "https://a.test/private/secret": linksTo(),
                "https://a.test/public": linksTo(),
            },
        });

        expect(output.http.urlsRequested()).not.toContain(
            "https://a.test/private/secret"
        );
        expect(visited(output)).toContain("https://a.test/public");
        expect(output.frontier.counts().skipped).toBe(1);
    });

    it("fails closed when robots.txt is unreachable", async () => {
        const output = await crawl({
            routes: {
                "https://a.test/robots.txt": {
                    error: { kind: "network", message: "ECONNRESET" },
                },
                [SEED]: linksTo(),
            },
        });

        expect(output.error).toEqual({
            kind: "robots-denied",
            url: SEED,
            reason: "robots-unavailable",
        });
    });

    it("treats a 5xx robots.txt as a full disallow but a 404 as permission", async () => {
        const denied = await crawl({
            routes: {
                "https://a.test/robots.txt": { status: 503 },
                [SEED]: linksTo(),
            },
        });
        expect(denied.result).toBeNull();

        const allowed = await crawl({
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo(),
            },
        });
        expect(allowed.result?.summary.pagesVisited).toBe(1);
    });

    it("reuses the cached robots.txt on a later run against the same database", async () => {
        const db = freshDb();
        const routes = {
            "https://a.test/robots.txt": {
                status: 200,
                contentType: "text/plain",
                body: "User-agent: *\nDisallow: /private",
            },
            "https://a.test/sitemap.xml": { status: 404 },
            [SEED]: linksTo(),
        };

        const first = await crawl({ db, routes });
        const second = await crawl({ db, routes });

        expect(first.http.countFor("https://a.test/robots.txt")).toBe(1);
        expect(second.http.countFor("https://a.test/robots.txt")).toBe(0);
        expect(second.result?.summary.pagesVisited).toBe(1);
    });

    it("fetches robots.txt once for the whole run", async () => {
        const output = await crawl({
            config: { crawl: { maxDepth: 2, maxConcurrentPages: 3 } },
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo("/a", "/b", "/c"),
                "https://a.test/a": linksTo(),
                "https://a.test/b": linksTo(),
                "https://a.test/c": linksTo(),
            },
        });

        expect(output.http.countFor("https://a.test/robots.txt")).toBe(1);
    });

    it("announces a long Crawl-delay instead of sitting silent on it", async () => {
        const output = await crawl({
            config: { crawl: { maxDepth: 0 } },
            routes: {
                "https://a.test/robots.txt": {
                    status: 200,
                    contentType: "text/plain",
                    body: "User-agent: *\nCrawl-delay: 3600",
                },
                [SEED]: linksTo(),
            },
        });

        // Without this, an hour-long wait is indistinguishable from a hang.
        const notices = output.events.filter(
            (event): event is Extract<JobEvent, { type: "crawl/notice" }> =>
                event.type === "crawl/notice"
        );
        expect(notices.map((event) => event.message).join(" ")).toContain(
            "3600s between requests"
        );
        expect(notices.map((event) => event.message).join(" ")).toContain(
            "Crawl-delay"
        );
    });

    it("says nothing about a delay short enough not to matter", async () => {
        const output = await crawl({
            config: { crawl: { maxDepth: 0, requestDelayMs: 100 } },
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                [SEED]: linksTo(),
            },
        });

        expect(
            output.events.some((event) => event.type === "crawl/notice")
        ).toBe(false);
    });

    it("applies Crawl-delay on top of the configured floor", async () => {
        const output = await crawl({
            config: {
                crawl: {
                    maxDepth: 1,
                    maxConcurrentPages: 1,
                    requestDelayMs: 100,
                },
            },
            routes: {
                "https://a.test/robots.txt": {
                    status: 200,
                    contentType: "text/plain",
                    body: "User-agent: *\nCrawl-delay: 2",
                },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo("/one"),
                "https://a.test/one": linksTo(),
            },
        });

        // Seed, then one link: a single 2s gap between the two page fetches.
        expect(output.clock.sleeps.filter((ms) => ms === 2_000)).toHaveLength(
            1
        );
    });
});

describe("sitemaps", () => {
    it("seeds from the sitemap as well as from links", async () => {
        const output = await crawl({
            config: { crawl: { maxDepth: 1 } },
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": {
                    status: 200,
                    contentType: "application/xml",
                    body: `<urlset><url><loc>https://a.test/orphan</loc></url></urlset>`,
                },
                [SEED]: linksTo(),
                "https://a.test/orphan": linksTo(),
            },
        });

        expect(visited(output).sort()).toEqual([
            "https://a.test/",
            "https://a.test/orphan",
        ]);
    });

    it("uses the sitemap location advertised in robots.txt", async () => {
        const output = await crawl({
            config: { crawl: { maxDepth: 1 } },
            routes: {
                "https://a.test/robots.txt": {
                    status: 200,
                    contentType: "text/plain",
                    body: "Sitemap: https://a.test/custom-sitemap.xml\nUser-agent: *\nDisallow:",
                },
                "https://a.test/custom-sitemap.xml": {
                    status: 200,
                    contentType: "application/xml",
                    body: `<urlset><url><loc>https://a.test/from-robots</loc></url></urlset>`,
                },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo(),
                "https://a.test/from-robots": linksTo(),
            },
        });

        expect(visited(output)).toContain("https://a.test/from-robots");
    });

    it("does not read the sitemap at all on a depth-0 crawl", async () => {
        const output = await crawl({
            config: { crawl: { maxDepth: 0 } },
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": {
                    status: 200,
                    contentType: "application/xml",
                    body: `<urlset><url><loc>https://a.test/orphan</loc></url></urlset>`,
                },
                [SEED]: linksTo(),
            },
        });

        // Everything it produced would be discarded as out of scope, so fetching
        // it is pure cost — and on a large site, minutes of it.
        expect(output.http.urlsRequested()).not.toContain(
            "https://a.test/sitemap.xml"
        );
        expect(output.result?.summary.pagesVisited).toBe(1);
    });

    it("keeps sitemap URLs out of a depth-0 crawl", async () => {
        const output = await crawl({
            config: { crawl: { maxDepth: 0 } },
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": {
                    status: 200,
                    contentType: "application/xml",
                    body: `<urlset><url><loc>https://a.test/orphan</loc></url></urlset>`,
                },
                [SEED]: linksTo(),
                "https://a.test/orphan": linksTo(),
            },
        });

        expect(visited(output)).toEqual(["https://a.test/"]);
    });

    it("carries on when there is no sitemap at all", async () => {
        const output = await crawl({
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo(),
            },
        });

        expect(output.result?.stopped).toBe("finished");
    });
});

describe("failures and non-HTML", () => {
    it("records a failed page and keeps going", async () => {
        const output = await crawl({
            config: { crawl: { maxConcurrentPages: 1 } },
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo("/broken", "/fine"),
                "https://a.test/broken": { status: 500 },
                "https://a.test/fine": linksTo(),
            },
        });

        expect(output.result?.summary.pagesFailed).toBe(1);
        expect(output.result?.summary.pagesVisited).toBe(2);
        expect(
            output.events.some((event) => event.type === "crawl/page-failed")
        ).toBe(true);
    });

    it("does not parse non-HTML responses as pages", async () => {
        const output = await crawl({
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo("/data.json"),
                "https://a.test/data.json": {
                    status: 200,
                    contentType: "application/json",
                    body: "{}",
                },
            },
        });

        expect(visited(output)).toEqual(["https://a.test/"]);
        expect(output.frontier.counts().skipped).toBe(1);
    });

    it("drops a page that redirects off-origin", async () => {
        const output = await crawl({
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo("/redirect"),
                "https://a.test/redirect": {
                    ...linksTo(),
                    finalUrl: "https://elsewhere.test/landing",
                },
            },
        });

        expect(visited(output)).toEqual(["https://a.test/"]);
    });
});

describe("budget and cancellation", () => {
    it("stops cleanly at the page cap and reports which cap tripped", async () => {
        const output = await crawl({
            config: {
                crawl: { maxDepth: 3, maxConcurrentPages: 1 },
                caps: { maxPagesCrawled: 2 },
            },
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo("/a"),
                "https://a.test/a": linksTo("/b"),
                "https://a.test/b": linksTo("/c"),
                "https://a.test/c": linksTo(),
            },
        });

        expect(output.result?.stopped).toBe("budget");
        expect(output.result?.breach?.cap).toBe("pages-crawled");
        expect(output.result?.summary.truncatedBy).toBe("pages-crawled");
        expect(output.result?.summary.pagesVisited).toBeLessThanOrEqual(3);
    });

    it("stops on the wall-clock cap", async () => {
        const output = await crawl({
            config: {
                crawl: {
                    maxDepth: 3,
                    maxConcurrentPages: 1,
                    requestDelayMs: 5_000,
                },
                caps: { maxDurationMs: 6_000 },
            },
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo("/a"),
                "https://a.test/a": linksTo("/b"),
                "https://a.test/b": linksTo("/c"),
                "https://a.test/c": linksTo(),
            },
        });

        expect(output.result?.breach?.cap).toBe("duration");
    });

    it("halts on abort", async () => {
        const output = await crawl({
            abortAfter: 1,
            config: { crawl: { maxDepth: 3, maxConcurrentPages: 1 } },
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo("/a", "/b"),
                "https://a.test/a": linksTo(),
                "https://a.test/b": linksTo(),
            },
        });

        expect(output.result?.stopped).toBe("cancelled");
        expect(output.result?.summary.pagesVisited).toBeLessThan(3);
    });
});

describe("discovery reporting", () => {
    it("accumulates asset counts from the page handler", async () => {
        const output = await crawl({
            config: { crawl: { maxDepth: 1, maxConcurrentPages: 1 } },
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo("/one"),
                "https://a.test/one": linksTo(),
            },
            onPage: () => ({ found: 5, unique: 3, bytesProjectedDelta: 1_000 }),
        });

        expect(output.result?.summary.uniqueAssets).toBe(6);
        expect(output.result?.summary.bytesProjected).toBe(2_000);
        expect(
            output.events.filter(
                (event) => event.type === "crawl/assets-discovered"
            )
        ).toHaveLength(2);
    });

    it("emits nothing when a page yields no assets", async () => {
        const output = await crawl({
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo(),
            },
        });

        expect(
            output.events.some(
                (event) => event.type === "crawl/assets-discovered"
            )
        ).toBe(false);
    });
});

describe("resumability", () => {
    it("picks up a frontier left behind by an earlier run", async () => {
        const output = await crawl({
            prepare: (db, jobId) => {
                new Frontier(db, jobId).enqueue(
                    "https://a.test/leftover",
                    1,
                    null,
                    T0
                );
            },
            config: { crawl: { maxDepth: 1, maxConcurrentPages: 1 } },
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo(),
                "https://a.test/leftover": linksTo(),
            },
        });

        expect(visited(output)).toContain("https://a.test/leftover");
    });
});

describe("renderer escalation", () => {
    const shell = {
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: '<!doctype html><html><body><div id="root"></div></body></html>',
    };

    const rich = {
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><body><p>${"words ".repeat(60)}</p><img src="/a.jpg"><img src="/b.jpg"><img src="/c.jpg"></body></html>`,
    };

    const baseRoutes = {
        "https://a.test/robots.txt": { status: 404 },
        "https://a.test/sitemap.xml": { status: 404 },
    };

    it("renders a page whose static HTML is an empty shell", async () => {
        const renderer = new FakeRenderer({
            [SEED]: {
                html: '<html><body><img src="https://cdn.a.test/rendered.jpg"></body></html>',
                networkLog: [
                    {
                        url: "https://cdn.a.test/live.m3u8",
                        resourceType: "xhr",
                        contentType: "application/vnd.apple.mpegurl",
                        contentLength: null,
                        status: 200,
                    },
                ],
            },
        });

        let seen: FetchedPage | null = null;
        const output = await crawl({
            renderer,
            routes: { ...baseRoutes, [SEED]: shell },
            onPageFull: (page) => {
                seen = page;
                return noDiscovery;
            },
        });

        expect(renderer.rendered).toEqual([SEED]);
        expect(output.result?.summary.pagesVisited).toBe(1);

        const page = seen as FetchedPage | null;
        expect(page?.renderMode).toBe("rendered");
        expect(page?.html).toContain("rendered.jpg");
        expect(page?.networkLog).toHaveLength(1);
    });

    it("stays on the static path for a page that already has content", async () => {
        const renderer = new FakeRenderer();
        await crawl({ renderer, routes: { ...baseRoutes, [SEED]: rich } });
        expect(renderer.rendered).toEqual([]);
    });

    it("falls back to the static HTML when rendering fails", async () => {
        const renderer = new FakeRenderer({
            [SEED]: {
                error: {
                    kind: "launch-failed",
                    message: "no Chromium installed",
                },
            },
        });

        let seen: FetchedPage | null = null;
        const output = await crawl({
            renderer,
            routes: { ...baseRoutes, [SEED]: shell },
            onPageFull: (page) => {
                seen = page;
                return noDiscovery;
            },
        });

        expect(output.result?.summary.pagesVisited).toBe(1);
        expect(output.result?.summary.pagesFailed).toBe(0);
        expect((seen as FetchedPage | null)?.renderMode).toBe("static");
    });

    it("never renders when no renderer is supplied", async () => {
        const output = await crawl({
            routes: { ...baseRoutes, [SEED]: shell },
        });
        expect(output.result?.summary.pagesVisited).toBe(1);
    });

    it("honours static-only mode even for an empty shell", async () => {
        const renderer = new FakeRenderer();
        await crawl({
            renderer,
            config: { renderer: { mode: "static-only" } },
            routes: { ...baseRoutes, [SEED]: shell },
        });
        expect(renderer.rendered).toEqual([]);
    });
});

describe("skipped pages are visible, not silent", () => {
    const skips = (output: RunOutput) =>
        output.events.filter(
            (
                event
            ): event is Extract<JobEvent, { type: "crawl/page-skipped" }> =>
                event.type === "crawl/page-skipped"
        );

    it("says why a non-HTML page was passed over", async () => {
        const output = await crawl({
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: {
                    status: 200,
                    contentType: "application/pdf",
                    body: "%PDF",
                },
            },
        });

        expect(skips(output).map((event) => event.reason)).toEqual([
            "not HTML (application/pdf)",
        ]);
        expect(output.result?.summary.pagesSkipped).toBe(1);
        expect(output.result?.summary.pagesVisited).toBe(0);
    });

    it("says why robots.txt blocked a page", async () => {
        const output = await crawl({
            routes: {
                "https://a.test/robots.txt": {
                    status: 200,
                    contentType: "text/plain",
                    body: "User-agent: *\nDisallow: /private",
                },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo("/private/x"),
                "https://a.test/private/x": linksTo(),
            },
        });

        expect(skips(output)[0]?.reason).toContain("robots.txt disallows");
    });

    it("says where a page redirected to", async () => {
        const output = await crawl({
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo("/away"),
                "https://a.test/away": {
                    ...linksTo(),
                    finalUrl: "https://elsewhere.test/landing",
                },
            },
        });

        expect(skips(output)[0]?.reason).toContain("elsewhere.test");
    });

    it("counts skips apart from failures, because they are different things", async () => {
        const output = await crawl({
            config: { crawl: { maxConcurrentPages: 1 } },
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: linksTo("/broken", "/data.json"),
                "https://a.test/broken": { status: 500 },
                "https://a.test/data.json": {
                    status: 200,
                    contentType: "application/json",
                    body: "{}",
                },
            },
        });

        expect(output.result?.summary).toMatchObject({
            pagesVisited: 1,
            pagesFailed: 1,
            pagesSkipped: 1,
        });
    });
});

describe("idle workers must not starve the event loop", () => {
    /**
     * The bug this guards against: spare workers polled on `sleep(0)`, which
     * resolved into a microtask. Microtasks drain before the poll phase, so the
     * one worker actually fetching could never get its socket callback, and the
     * crawl deadlocked at zero pages with the CPU pinned.
     *
     * `delayMs` forces the response to need real event-loop progress. With more
     * workers than pages, this test hangs on the old code and passes on the new.
     */
    it("finishes a single-page crawl when several workers have nothing to do", async () => {
        const output = await crawl({
            // Three workers, one page: two of them idle for the whole fetch.
            config: { crawl: { maxDepth: 0, maxConcurrentPages: 3 } },
            routes: {
                "https://a.test/robots.txt": { status: 404, delayMs: 5 },
                [SEED]: { ...linksTo(), delayMs: 20 },
            },
        });

        expect(output.result?.stopped).toBe("finished");
        expect(output.result?.summary.pagesVisited).toBe(1);
    }, 10_000);

    it("still completes a multi-page crawl with idle capacity", async () => {
        const output = await crawl({
            config: { crawl: { maxDepth: 1, maxConcurrentPages: 4 } },
            routes: {
                "https://a.test/robots.txt": { status: 404 },
                "https://a.test/sitemap.xml": { status: 404 },
                [SEED]: { ...linksTo("/one"), delayMs: 10 },
                "https://a.test/one": { ...linksTo(), delayMs: 10 },
            },
        });

        expect(output.result?.summary.pagesVisited).toBe(2);
    }, 10_000);
});
