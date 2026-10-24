import type { NextResponse } from 'next/server';
import { getJobService } from '../../../_lib/service';
import { jobIdFrom, respond, type RouteContext } from '../../../_lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  const jobId = await jobIdFrom(context);
  if (!jobId.ok) return respond(jobId);
  return respond(getJobService().pause(jobId.value), () => ({ ok: true, action: 'pause' }), 202);
}
