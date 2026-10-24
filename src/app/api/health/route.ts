import { NextResponse } from 'next/server';
import { toolOptionsSchema } from '@/core/config';
import { describeGaps, probeEnvironment } from '@/core/media-tool/environment';
import { NodeSubprocessRunner } from '@/core/media-tool/subprocess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  // Paths are overridable so you can check a binary that is installed but not
  // on PATH before committing it to a job config.
  const url = new URL(request.url);
  const tools = toolOptionsSchema.parse({
    ...(url.searchParams.get('ytDlpPath') === null
      ? {}
      : { ytDlpPath: url.searchParams.get('ytDlpPath') }),
    ...(url.searchParams.get('ffmpegPath') === null
      ? {}
      : { ffmpegPath: url.searchParams.get('ffmpegPath') }),
  });

  const report = await probeEnvironment(new NodeSubprocessRunner(), tools);

  return NextResponse.json({
    ...report,
    // Everything below is optional; the core crawl and download path needs none
    // of it, so a job can always run.
    ready: true,
    gaps: describeGaps(report),
  });
}
