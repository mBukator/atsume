import { toolOptionsSchema } from "@/core/config";
import { describeGaps, probeEnvironment } from "@/core/media-tool/environment";
import { NodeSubprocessRunner } from "@/core/media-tool/subprocess";
import { NextResponse } from "next/server";

import { parseJobId, respond } from "../_lib/respond";
import { getJobService } from "../_lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
    /*
    Tool paths come from a saved job, never from the query string. A path taken
    from the URL would be run as a program by anyone able to make a browser
    request this route, and an `<img>` on any web page can. A job's config is
    something you saved yourself, so `?jobId=` checks the binaries that job
    will actually use; without it, the defaults on PATH are checked.
  */
    const url = new URL(request.url);
    const rawJobId = url.searchParams.get("jobId");
    let tools = toolOptionsSchema.parse({});
    if (rawJobId !== null) {
        const jobId = parseJobId(rawJobId);
        if (!jobId.ok) return respond(jobId);
        const job = getJobService().getJob(jobId.value);
        if (!job.ok) return respond(job);
        tools = job.value.config.tools;
    }

    const report = await probeEnvironment(new NodeSubprocessRunner(), tools);

    return NextResponse.json({
        ...report,
        // Everything below is optional; the core crawl and download path needs none
        // of it, so a job can always run.
        ready: true,
        gaps: describeGaps(report),
    });
}
