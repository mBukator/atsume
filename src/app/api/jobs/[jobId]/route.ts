import { NextResponse } from 'next/server';
import { getJobService } from '../../_lib/service';
import { jobIdFrom, respond, type RouteContext } from '../../_lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const jobId = await jobIdFrom(context);
  if (!jobId.ok) return respond(jobId);

  const service = getJobService();
  const job = service.getJob(jobId.value);
  if (!job.ok) return respond(job);

  return NextResponse.json({
    id: job.value.id,
    seedUrl: job.value.seedUrl,
    state: job.value.state,
    config: job.value.config,
    ledger: job.value.ledger,
    counts: service.repo.countAssets(jobId.value),
  });
}

export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  const jobId = await jobIdFrom(context);
  if (!jobId.ok) return respond(jobId);
  return respond(getJobService().cancel(jobId.value), () => ({ cancelled: true }));
}
