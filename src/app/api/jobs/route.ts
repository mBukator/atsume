import { NextResponse } from 'next/server';
import { getJobService } from '../_lib/service';
import { readJson, respond } from '../_lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const jobs = getJobService()
    .listJobs()
    .map((job) => ({
      id: job.id,
      seedUrl: job.seedUrl,
      status: job.state.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    }));

  return NextResponse.json({ jobs });
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = await readJson(request);
  if (!body.ok) return respond(body);

  return respond(
    getJobService().createJob(body.value),
    (job) => ({ id: job.id, config: job.config, state: job.state }),
    201,
  );
}
