import { NextResponse } from 'next/server';
import { assetIdSchema } from '@/core/ids';
import { fetchHttpClient } from '@/core/net/http';
import { getJobService } from '../../../../../_lib/service';
import { errorResponse, parseJobId } from '../../../../../_lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serves an asset's bytes through this server so the grid can preview it.
 *
 * Image hosts commonly refuse a request whose `Referer` is some other origin,
 * and the browser has no choice but to send one. Fetching here instead lets us
 * send the page the asset was actually found on, which is exactly what a
 * request from that page would have looked like.
 *
 * The URL is read from the job's own asset row and never from the query string.
 * That is the whole SSRF guard: this cannot be pointed at an arbitrary host.
 */

/** Previews are for looking at. Anything larger is a download, not a thumbnail. */
const MAX_PREVIEW_BYTES = 24 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

interface PreviewContext {
  readonly params: Promise<{ readonly jobId: string; readonly assetId: string }>;
}

export async function GET(_request: Request, context: PreviewContext): Promise<Response> {
  const { jobId: rawJobId, assetId: rawAssetId } = await context.params;

  const jobId = parseJobId(rawJobId);
  if (!jobId.ok) return errorResponse(jobId.error);

  const assetId = assetIdSchema.safeParse(rawAssetId);
  if (!assetId.success) {
    return errorResponse({ kind: 'not-found', jobId: rawJobId });
  }

  const service = getJobService();
  const job = service.getJob(jobId.value);
  if (!job.ok) return errorResponse(job.error);

  const asset = service.repo.getAsset(assetId.data);
  // Scoped to the job in the path, so one job's id cannot be used to read
  // another's assets.
  if (!asset.ok || asset.value.jobId !== jobId.value) {
    return errorResponse({ kind: 'not-found', jobId: rawJobId });
  }

  if (asset.value.acquisition.strategy !== 'direct') {
    return errorResponse({
      kind: 'invalid-state',
      detail: 'only directly fetchable assets can be previewed',
    });
  }
  if (asset.value.kind === 'video') {
    return errorResponse({ kind: 'invalid-state', detail: 'video is not previewable' });
  }

  const response = await fetchHttpClient.stream(asset.value.url, {
    userAgent: job.value.config.crawl.userAgent,
    timeoutMs: TIMEOUT_MS,
    maxBytes: MAX_PREVIEW_BYTES,
    accept: 'image/*,*/*;q=0.8',
    referer: asset.value.sources[0]?.pageUrl,
  });

  if (!response.ok) {
    return errorResponse({ kind: 'repository', detail: `upstream ${response.error.kind}` });
  }
  if (response.value.status >= 400) {
    return errorResponse({
      kind: 'repository',
      detail: `upstream HTTP ${response.value.status}`,
    });
  }

  const contentType =
    response.value.headers.get('content-type') ??
    (asset.value.probe.status === 'probed' ? asset.value.probe.contentType : null);

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of response.value.body) controller.enqueue(chunk);
        controller.close();
      } catch (cause) {
        controller.error(cause);
      }
    },
  });

  return new NextResponse(body, {
    status: 200,
    headers: {
      'content-type': contentType ?? 'application/octet-stream',
      // Without this the browser re-fetches every tile on each re-render, and
      // re-renders are frequent while the grid is filling in measurements.
      'cache-control': 'private, max-age=3600',
      'referrer-policy': 'no-referrer',
    },
  });
}
