import { NextResponse } from 'next/server';
import { buildManifest } from '@/core/orchestrator/manifest';
import { getJobService } from '../../../_lib/service';
import { jobIdFrom, respond, type RouteContext } from '../../../_lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const jobId = await jobIdFrom(context);
  if (!jobId.ok) return respond(jobId);

  const service = getJobService();
  const job = service.getJob(jobId.value);
  if (!job.ok) return respond(job);

  const assets = service.repo.listAssets(jobId.value, { limit: 100_000 });
  if (!assets.ok) {
    return NextResponse.json({ error: { kind: 'repository', detail: assets.error.kind } }, { status: 500 });
  }

  const manifest = buildManifest(jobId.value, job.value.config, assets.value, new Date());

  return new NextResponse(JSON.stringify(manifest, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="manifest-${jobId.value}.json"`,
    },
  });
}
