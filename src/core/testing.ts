import type { Clock } from "./clock";
import type { ComputedBackground, NetworkRecord } from "./extract/context";
import type {
    RenderedPage,
    RenderError,
    Renderer,
    RenderOptions,
} from "./render/renderer";
import { err, ok, type Result } from "./result";
import type { FileStore, FsError, WriteHandle } from "./download/file-store";
import type {
    RunOptions,
    SubprocessError,
    SubprocessResult,
    SubprocessRunner,
} from "./media-tool/subprocess";
import type {
    HeadResult,
    HttpClient,
    HttpError,
    HttpResponse,
    RequestOptions,
    StreamedResponse,
    StreamOptions,
} from "./net/http";

export interface FakeResponseSpec {
    readonly status?: number;
    readonly body?: string;
    readonly contentType?: string;
    readonly headers?: Readonly<Record<string, string>>;
    /** Simulates a redirect: the response reports a different final URL. */
    readonly finalUrl?: string;
    readonly error?: HttpError;
    /** Raw bytes, for binary fixtures where `body` as text will not do. */
    readonly bytes?: Uint8Array;
    /** Chunk the body so streaming and progress reporting are exercised. */
    readonly chunkSize?: number;
    /** Answer 200 with the whole file even when a Range was asked for. */
    readonly ignoreRange?: boolean;
    /** Fail the stream partway through, once, to exercise resume. */
    readonly truncateAfter?: number;
    /** Return these statuses in order before falling back to the normal one. */
    readonly statusSequence?: readonly number[];
    /** Resolve on a timer, so the response needs real event-loop progress. */
    readonly delayMs?: number;
}

export interface RecordedRequest {
    readonly url: string;
    readonly userAgent: string;
    readonly at: number;
    /** Undefined when the caller sent none, which is its own assertion. */
    readonly referer: string | undefined;
}

/**
 * Canned responses keyed by exact URL. Everything not in the table is a 404,
 * which keeps tests honest about what they actually stubbed.
 */
export class FakeHttpClient implements HttpClient {
    readonly requests: RecordedRequest[] = [];

    constructor(
        private readonly routes: Readonly<Record<string, FakeResponseSpec>>,
        private readonly clock?: Clock
    ) {}

    private readonly statusCursor = new Map<string, number>();
    readonly truncated = new Set<string>();

    private bodyFor(spec: FakeResponseSpec | undefined): Uint8Array {
        if (spec?.bytes !== undefined) return spec.bytes;
        return new TextEncoder().encode(spec?.body ?? "");
    }

    private headersFor(
        spec: FakeResponseSpec | undefined,
        body: Uint8Array
    ): Map<string, string> {
        const headers = new Map<string, string>();
        headers.set(
            "content-type",
            spec?.contentType ?? "text/html; charset=utf-8"
        );
        headers.set("content-length", String(body.byteLength));
        headers.set("accept-ranges", "bytes");
        for (const [key, value] of Object.entries(spec?.headers ?? {})) {
            headers.set(key.toLowerCase(), value);
        }
        return headers;
    }

    private statusFor(url: string, spec: FakeResponseSpec | undefined): number {
        const sequence = spec?.statusSequence;
        if (sequence !== undefined && sequence.length > 0) {
            const index = this.statusCursor.get(url) ?? 0;
            this.statusCursor.set(url, index + 1);
            const staged = sequence[index];
            if (staged !== undefined) return staged;
        }
        return spec?.status ?? (spec === undefined ? 404 : 200);
    }

    async get(
        url: string,
        options: RequestOptions
    ): Promise<Result<HttpResponse, HttpError>> {
        this.requests.push({
            url,
            userAgent: options.userAgent,
            at: this.clock?.now() ?? 0,
            referer: options.referer,
        });

        const spec = this.routes[url];
        if (spec?.error !== undefined) return { ok: false, error: spec.error };

        if (spec?.delayMs !== undefined) {
            await new Promise<void>((resolve) =>
                setTimeout(resolve, spec.delayMs)
            );
        }

        const body = this.bodyFor(spec);
        return ok({
            url: spec?.finalUrl ?? url,
            status: this.statusFor(url, spec),
            headers: this.headersFor(spec, body),
            body,
        });
    }

    async head(
        url: string,
        options: RequestOptions
    ): Promise<Result<HeadResult, HttpError>> {
        this.requests.push({
            url,
            userAgent: options.userAgent,
            at: this.clock?.now() ?? 0,
            referer: options.referer,
        });

        const spec = this.routes[url];
        if (spec?.error !== undefined) return { ok: false, error: spec.error };

        const body = this.bodyFor(spec);
        return ok({
            url: spec?.finalUrl ?? url,
            status: this.statusFor(url, spec),
            headers: this.headersFor(spec, body),
        });
    }

    async stream(
        url: string,
        options: StreamOptions
    ): Promise<Result<StreamedResponse, HttpError>> {
        this.requests.push({
            url,
            userAgent: options.userAgent,
            at: this.clock?.now() ?? 0,
            referer: options.referer,
        });

        const spec = this.routes[url];
        if (spec?.error !== undefined) return { ok: false, error: spec.error };

        const full = this.bodyFor(spec);
        const status = this.statusFor(url, spec);
        const headers = this.headersFor(spec, full);

        if (status >= 400) {
            return ok({
                url,
                status,
                headers,
                body: chunked(new Uint8Array(0), 1),
            });
        }

        const range = options.range;
        if (range === undefined || spec?.ignoreRange === true) {
            const truncateAt =
                spec?.truncateAfter !== undefined && !this.truncated.has(url)
                    ? spec.truncateAfter
                    : null;
            if (truncateAt !== null) this.truncated.add(url);
            return ok({
                url,
                status: 200,
                headers,
                body: chunked(
                    full,
                    spec?.chunkSize ?? (full.byteLength || 1),
                    truncateAt
                ),
            });
        }

        if (range.from >= full.byteLength && full.byteLength > 0) {
            return ok({
                url,
                status: 416,
                headers,
                body: chunked(new Uint8Array(0), 1),
            });
        }

        const end =
            range.to === undefined
                ? full.byteLength - 1
                : Math.min(range.to, full.byteLength - 1);
        const slice = full.subarray(range.from, end + 1);
        const partial = new Map(headers);
        partial.set("content-length", String(slice.byteLength));
        partial.set(
            "content-range",
            `bytes ${range.from}-${end}/${full.byteLength}`
        );

        return ok({
            url,
            status: 206,
            headers: partial,
            body: chunked(slice, spec?.chunkSize ?? (slice.byteLength || 1)),
        });
    }

    urlsRequested(): string[] {
        return this.requests.map((request) => request.url);
    }

    countFor(url: string): number {
        return this.requests.filter((request) => request.url === url).length;
    }
}

/**
 * Sleeping jumps the clock forward instead of waiting, so rate-limiter and
 * duration-cap behaviour is exercised at full speed and stays deterministic.
 */
export class ManualClock implements Clock {
    private current: number;
    readonly sleeps: number[] = [];

    constructor(start = 1_700_000_000_000) {
        this.current = start;
    }

    now(): number {
        return this.current;
    }

    advance(ms: number): void {
        this.current += ms;
    }

    async sleep(ms: number, signal?: AbortSignal): Promise<void> {
        this.sleeps.push(ms);
        if (signal?.aborted === true) throw new Error("aborted");
        if (ms > 0) this.current += ms;
        // Yields to the macrotask queue rather than resolving into a microtask.
        // A microtask-only clock cannot starve anything, which is precisely why
        // the suite could not see the worker deadlock it was hiding.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
}

export const htmlPage = (body: string): FakeResponseSpec => ({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html><body>${body}</body></html>`,
});

export const linksTo = (...hrefs: readonly string[]): FakeResponseSpec =>
    htmlPage(hrefs.map((href) => `<a href="${href}">link</a>`).join(""));

export interface FakeRenderSpec {
    readonly html?: string;
    readonly networkLog?: readonly NetworkRecord[];
    readonly computedBackgrounds?: readonly ComputedBackground[];
    readonly error?: RenderError;
}

/** Stands in for Chromium so escalation behaviour is testable without a browser. */
export class FakeRenderer implements Renderer {
    readonly rendered: string[] = [];
    closed = false;

    constructor(
        private readonly routes: Readonly<Record<string, FakeRenderSpec>> = {}
    ) {}

    async render(
        url: string,
        _options: RenderOptions
    ): Promise<Result<RenderedPage, RenderError>> {
        this.rendered.push(url);
        const spec = this.routes[url];
        if (spec?.error !== undefined) return err(spec.error);

        return ok({
            url,
            html: spec?.html ?? "<html><body></body></html>",
            networkLog: spec?.networkLog ?? [],
            computedBackgrounds: spec?.computedBackgrounds ?? [],
        });
    }

    async close(): Promise<void> {
        this.closed = true;
    }
}

async function* chunked(
    bytes: Uint8Array,
    size: number,
    truncateAfter: number | null = null
): AsyncIterable<Uint8Array> {
    const limit = truncateAfter ?? bytes.byteLength;
    for (
        let offset = 0;
        offset < Math.min(limit, bytes.byteLength);
        offset += size
    ) {
        yield bytes.subarray(
            offset,
            Math.min(offset + size, limit, bytes.byteLength)
        );
        await Promise.resolve();
    }
    if (truncateAfter !== null) throw new Error("connection reset mid-stream");
}

/** An in-memory FileStore, so downloader tests never touch a real disk. */
export class MemoryFileStore implements FileStore {
    readonly files = new Map<string, Uint8Array>();
    /** Paths that should fail on open, to exercise the filesystem error path. */
    readonly unwritable = new Set<string>();
    /** Fail every write, for simulating a full or read-only output directory. */
    failAllWrites = false;

    async sizeOf(path: string): Promise<number | null> {
        return this.files.get(path)?.byteLength ?? null;
    }

    read(path: string): AsyncIterable<Uint8Array> {
        const bytes = this.files.get(path);
        return (async function* () {
            if (bytes !== undefined) yield bytes;
        })();
    }

    async openWrite(
        path: string,
        mode: "create" | "append"
    ): Promise<Result<WriteHandle, FsError>> {
        if (this.failAllWrites || this.unwritable.has(path)) {
            return err({ kind: "permission", path } satisfies FsError);
        }
        if (mode === "create") this.files.set(path, new Uint8Array(0));
        else if (!this.files.has(path)) this.files.set(path, new Uint8Array(0));

        const store = this.files;
        return ok({
            async write(chunk: Uint8Array) {
                const existing = store.get(path) ?? new Uint8Array(0);
                const next = new Uint8Array(
                    existing.byteLength + chunk.byteLength
                );
                next.set(existing, 0);
                next.set(chunk, existing.byteLength);
                store.set(path, next);
                return { ok: true as const, value: null };
            },
            async close() {
                // Nothing to release in memory.
            },
        });
    }

    async move(from: string, to: string): Promise<Result<null, FsError>> {
        const bytes = this.files.get(from);
        if (bytes === undefined)
            return err({ kind: "not-found", path: from } satisfies FsError);
        this.files.delete(from);
        this.files.set(to, bytes);
        return { ok: true as const, value: null };
    }

    async remove(path: string): Promise<void> {
        this.files.delete(path);
    }

    textAt(path: string): string | null {
        const bytes = this.files.get(path);
        return bytes === undefined ? null : new TextDecoder().decode(bytes);
    }

    paths(): string[] {
        return [...this.files.keys()].sort();
    }
}

export interface FakeProcessSpec {
    readonly exitCode?: number;
    readonly stdout?: readonly string[];
    readonly stderr?: readonly string[];
    readonly error?: SubprocessError;
    /** Files the process leaves behind, so the caller can find and hash them. */
    readonly writes?: readonly {
        readonly path: string;
        readonly body: string;
    }[];
}

export interface FakeInvocation {
    readonly command: string;
    readonly args: readonly string[];
}

/** Stands in for yt-dlp so nothing is spawned and no network is touched. */
export class FakeSubprocessRunner implements SubprocessRunner {
    readonly invocations: FakeInvocation[] = [];

    constructor(
        private readonly route: (
            command: string,
            args: readonly string[]
        ) => FakeProcessSpec,
        private readonly files?: MemoryFileStore
    ) {}

    async run(
        command: string,
        args: readonly string[],
        options: RunOptions
    ): Promise<Result<SubprocessResult, SubprocessError>> {
        this.invocations.push({ command, args: [...args] });

        const spec = this.route(command, args);
        if (spec.error !== undefined) return err(spec.error);
        if (options.signal?.aborted === true) return err({ kind: "cancelled" });

        for (const line of spec.stdout ?? []) options.onStdoutLine?.(line);
        for (const line of spec.stderr ?? []) options.onStderrLine?.(line);

        for (const file of spec.writes ?? []) {
            this.files?.files.set(
                file.path,
                new TextEncoder().encode(file.body)
            );
        }

        return ok({
            exitCode: spec.exitCode ?? 0,
            signal: null,
            stdout: (spec.stdout ?? []).join("\n"),
            stderr: (spec.stderr ?? []).join("\n"),
        });
    }

    argsFor(
        predicate: (args: readonly string[]) => boolean
    ): readonly string[] | undefined {
        return this.invocations.find((invocation) => predicate(invocation.args))
            ?.args;
    }
}
