import type { ProbeState } from '../media';
import {
  acceptsRanges,
  collectStream,
  type HttpClient,
  type RequestOptions,
  numericHeader,
} from '../net/http';
import { HEADER_PROBE_BYTES, readImageDimensions } from './image-header';

export interface ProbeRequest {
  readonly url: string;
  /** Skip the header read for kinds where dimensions are not meaningful. */
  readonly wantDimensions: boolean;
  readonly options: RequestOptions;
}

const contentTypeOf = (headers: ReadonlyMap<string, string>): string | null =>
  headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;

/**
 * HEAD first, because it costs one round trip and no body. Servers that reject
 * HEAD (405, or a 403 that a GET would not produce) fall through to a ranged
 * GET, which doubles as the dimension read.
 */
export const probe = async (http: HttpClient, request: ProbeRequest): Promise<ProbeState> => {
  const probedAt = Date.now();
  const head = await http.head(request.url, request.options);

  let headers: ReadonlyMap<string, string> | null = null;
  let status: number | null = null;

  if (head.ok) {
    headers = head.value.headers;
    status = head.value.status;
  }

  const headUnusable = status === null || status >= 400;

  if (headUnusable && !request.wantDimensions) {
    const ranged = await http.stream(request.url, { ...request.options, range: { from: 0, to: 0 } });
    if (!ranged.ok) {
      return { status: 'probe-failed', reason: head.ok ? `HTTP ${status ?? 0}` : head.error.kind, probedAt };
    }
    // Drain so the connection is not left open holding a socket.
    await collectStream(ranged.value.body, 1);
    if (ranged.value.status >= 400) {
      return { status: 'probe-failed', reason: `HTTP ${ranged.value.status}`, probedAt };
    }
    headers = ranged.value.headers;
  }

  let width: number | null = null;
  let height: number | null = null;

  if (request.wantDimensions) {
    const ranged = await http.stream(request.url, {
      ...request.options,
      range: { from: 0, to: HEADER_PROBE_BYTES - 1 },
    });

    if (ranged.ok && ranged.value.status < 400) {
      const bytes = await collectStream(ranged.value.body, HEADER_PROBE_BYTES);
      const dimensions = readImageDimensions(bytes);
      if (dimensions !== null) {
        width = dimensions.width;
        height = dimensions.height;
      }
      headers ??= ranged.value.headers;
    } else if (headers === null) {
      return {
        status: 'probe-failed',
        reason: ranged.ok ? `HTTP ${ranged.value.status}` : ranged.error.kind,
        probedAt,
      };
    }
  }

  if (headers === null) {
    return { status: 'probe-failed', reason: 'no usable response', probedAt };
  }

  return {
    status: 'probed',
    contentType: contentTypeOf(headers),
    // A 206 reports the slice length in Content-Length; the full size is in
    // Content-Range, so a ranged probe must not mistake 64 KB for the file size.
    contentLength: totalSizeOf(headers),
    width,
    height,
    acceptsRanges: acceptsRanges(headers) || headers.has('content-range'),
    etag: headers.get('etag') ?? null,
    lastModified: headers.get('last-modified') ?? null,
    probedAt,
  };
};

export const totalSizeOf = (headers: ReadonlyMap<string, string>): number | null => {
  const contentRange = headers.get('content-range');
  if (contentRange !== undefined) {
    const total = /\/(\d+)\s*$/.exec(contentRange)?.[1];
    if (total !== undefined) {
      const value = Number.parseInt(total, 10);
      if (Number.isFinite(value)) return value;
    }
    return null;
  }
  return numericHeader(headers, 'content-length');
};
