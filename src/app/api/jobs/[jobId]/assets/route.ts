import { NextResponse } from 'next/server';
import { knownBytes, knownDimensions } from '@/core/media';
import { getJobService } from '../../../_lib/service';
import { jobIdFrom, respond, type RouteContext } from '../../../_lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PAGE = 500;

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const jobId = await jobIdFrom(context);
  if (!jobId.ok) return respond(jobId);

  const url = new URL(request.url);
  const verdict = url.searchParams.get('verdict') ?? 'any';
  const selectedParam = url.searchParams.get('selected');
  const limit = Math.min(MAX_PAGE, Number(url.searchParams.get('limit') ?? MAX_PAGE) || MAX_PAGE);
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);

  const service = getJobService();
  const assets = service.repo.listAssets(jobId.value, {
    verdict: verdict === 'included' || verdict === 'excluded' || verdict === 'unevaluated' ? verdict : 'any',
    selected: selectedParam === null ? null : selectedParam === 'true',
    limit,
    offset,
  });

  if (!assets.ok) {
    return NextResponse.json({ error: { kind: 'repository', detail: assets.error.kind } }, { status: 500 });
  }

  // Flattened for the grid: it needs one shape per tile, not a nested record.
  const items = assets.value.map((asset) => {
    const { width, height } = knownDimensions(asset);
    return {
      id: asset.id,
      url: asset.url,
      kind: asset.kind,
      acquisition: asset.acquisition.strategy,
      alt: asset.hints.alt,
      width,
      height,
      bytes: knownBytes(asset),
      extractors: [...new Set(asset.sources.map((source) => source.extractor))],
      pages: [...new Set(asset.sources.map((source) => source.pageUrl))],
      filter: asset.filter,
      selected: asset.selected,
      download: asset.download,
    };
  });

  return NextResponse.json({ items, counts: service.repo.countAssets(jobId.value), offset, limit });
}
