import type { NextResponse } from 'next/server';
import { getJobService } from '../../../_lib/service';
import { jobIdFrom, readJson, respond, type RouteContext } from '../../../_lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  const jobId = await jobIdFrom(context);
  if (!jobId.ok) return respond(jobId);

  const body = await readJson(request);
  if (!body.ok) return respond(body);

  const service = getJobService();
  const updated = service.updateCaps(jobId.value, body.value);
  if (!updated.ok) return respond(updated);

  const job = service.getJob(jobId.value);
  // The ledger comes back too, so the caller can see the headroom it just made
  // rather than guessing whether the new cap is above current usage.
  return respond(updated, (caps) => ({
    caps,
    ledger: job.ok ? job.value.ledger : null,
  }));
}
