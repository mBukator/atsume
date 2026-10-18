import { gunzipSync } from 'node:zlib';
import { err, ok, type Result } from '../result';

export type HttpError =
  | { readonly kind: 'network'; readonly message: string }
  | { readonly kind: 'timeout'; readonly afterMs: number }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'too-large'; readonly limitBytes: number };

export interface HttpResponse {
  /** The URL after redirects, which is what scope and robots must be judged on. */
  readonly url: string;
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: Uint8Array;
}

export interface RequestOptions {
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly maxBytes?: number | undefined;
  readonly accept?: string | undefined;
  /**
   * The page the URL was found on. Hotlink protection is common enough on image
   * hosts that omitting this loses real files. Node treats `referer` as an
   * ordinary header; only browsers forbid setting it.
   */
  readonly referer?: string | undefined;
}

/** Shared by all three methods so the header set cannot drift between them. */
export const baseHeaders = (
  options: RequestOptions,
  defaultAccept: string,
): Record<string, string> => {
  const headers: Record<string, string> = {
    'user-agent': options.userAgent,
    accept: options.accept ?? defaultAccept,
  };
  if (options.referer !== undefined) headers['referer'] = options.referer;
  return headers;
};

export interface HeadResult {
  readonly url: string;
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
}

/** Inclusive on both ends, matching the HTTP `Range` header. */
export interface ByteRange {
  readonly from: number;
  readonly to?: number | undefined;
}

export interface StreamOptions extends RequestOptions {
  readonly range?: ByteRange | undefined;
}

export interface StreamedResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: AsyncIterable<Uint8Array>;
}

/**
 * A port, not a class. The crawler never touches `fetch` directly, so its tests
 * run against a table of canned responses with no network and no Playwright.
 */
export interface HttpClient {
  get(url: string, options: RequestOptions): Promise<Result<HttpResponse, HttpError>>;
  /** Probing: cheap metadata without pulling the body. */
  head(url: string, options: RequestOptions): Promise<Result<HeadResult, HttpError>>;
  /** Downloading: chunks as they arrive, so hashing and writing interleave. */
  stream(url: string, options: StreamOptions): Promise<Result<StreamedResponse, HttpError>>;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

const headerMap = (headers: Headers): Map<string, string> => {
  const map = new Map<string, string>();
  headers.forEach((value, key) => map.set(key.toLowerCase(), value));
  return map;
};

const rangeHeader = (range: ByteRange | undefined): string | null => {
  if (range === undefined) return null;
  return range.to === undefined ? `bytes=${range.from}-` : `bytes=${range.from}-${range.to}`;
};

export const fetchHttpClient: HttpClient = {
  async get(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: baseHeaders(options, 'text/html,application/xhtml+xml,*/*;q=0.8'),
      });

      const limit = options.maxBytes ?? DEFAULT_MAX_BYTES;
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > limit) return err({ kind: 'too-large', limitBytes: limit });

      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > limit) return err({ kind: 'too-large', limitBytes: limit });

      return ok({
        url: response.url,
        status: response.status,
        headers: headerMap(response.headers),
        body: buffer,
      });
    } catch (cause) {
      if (options.signal?.aborted === true) return err({ kind: 'aborted' });
      if (controller.signal.aborted) return err({ kind: 'timeout', afterMs: options.timeoutMs });
      return err({ kind: 'network', message: cause instanceof Error ? cause.message : 'unknown' });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  },

  async head(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
        headers: baseHeaders(options, '*/*'),
      });
      return ok({
        url: response.url,
        status: response.status,
        headers: headerMap(response.headers),
      });
    } catch (cause) {
      if (options.signal?.aborted === true) return err({ kind: 'aborted' });
      if (controller.signal.aborted) return err({ kind: 'timeout', afterMs: options.timeoutMs });
      return err({ kind: 'network', message: cause instanceof Error ? cause.message : 'unknown' });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  },

  async stream(url, options) {
    const controller = new AbortController();
    // The timeout guards connection setup only. Once bytes are flowing, a slow
    // large file is not a failure, and killing it mid-transfer would throw away
    // a partial download that Range could otherwise resume.
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const range = rangeHeader(options.range);
      const headers = baseHeaders(options, '*/*');
      if (range !== null) headers['range'] = range;

      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers,
      });
      clearTimeout(timer);

      const body = response.body;
      const iterable: AsyncIterable<Uint8Array> =
        body === null ? emptyStream() : streamOf(body, options.signal);

      return ok({
        url: response.url,
        status: response.status,
        headers: headerMap(response.headers),
        body: iterable,
      });
    } catch (cause) {
      if (options.signal?.aborted === true) return err({ kind: 'aborted' });
      if (controller.signal.aborted) return err({ kind: 'timeout', afterMs: options.timeoutMs });
      return err({ kind: 'network', message: cause instanceof Error ? cause.message : 'unknown' });
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  },
};

async function* emptyStream(): AsyncIterable<Uint8Array> {
  // Intentionally yields nothing.
}

async function* streamOf(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      if (signal?.aborted === true) return;
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Collects at most `limit` bytes, then stops pulling. */
export const collectStream = async (
  body: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;

  for await (const chunk of body) {
    chunks.push(chunk);
    total += chunk.byteLength;
    if (total >= limit) break;
  }

  const out = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.length) break;
    const slice = chunk.subarray(0, Math.min(chunk.length, out.length - offset));
    out.set(slice, offset);
    offset += slice.length;
  }
  return out;
};

export const numericHeader = (
  headers: ReadonlyMap<string, string>,
  name: string,
): number | null => {
  const raw = headers.get(name);
  if (raw === undefined) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

export const acceptsRanges = (headers: ReadonlyMap<string, string>): boolean =>
  (headers.get('accept-ranges') ?? '').toLowerCase().includes('bytes');

const GZIP_MAGIC = [0x1f, 0x8b] as const;

const looksGzipped = (body: Uint8Array): boolean =>
  body.length > 2 && body[0] === GZIP_MAGIC[0] && body[1] === GZIP_MAGIC[1];

/**
 * `fetch` transparently handles `Content-Encoding: gzip`, but a `.xml.gz`
 * sitemap arrives as gzip *content* and has to be inflated by hand.
 */
export const decodeText = (response: HttpResponse): string => {
  const body = looksGzipped(response.body) ? new Uint8Array(gunzipSync(response.body)) : response.body;
  return new TextDecoder('utf-8', { fatal: false }).decode(body);
};

export const contentTypeOf = (response: HttpResponse): string | null => {
  const raw = response.headers.get('content-type');
  return raw === undefined ? null : (raw.split(';')[0]?.trim().toLowerCase() ?? null);
};

export const isHtml = (response: HttpResponse): boolean => {
  const type = contentTypeOf(response);
  return type === 'text/html' || type === 'application/xhtml+xml';
};

export const describeHttpError = (error: HttpError): string => {
  switch (error.kind) {
    case 'network':
      return `network error: ${error.message}`;
    case 'timeout':
      return `timed out after ${error.afterMs}ms`;
    case 'aborted':
      return 'cancelled';
    case 'too-large':
      return `response exceeded ${error.limitBytes} bytes`;
  }
};
