import type { NextResponse } from "next/server";

import { jobIdFrom, respond, type RouteContext } from "../../../_lib/respond";
import { getJobService } from "../../../_lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
    _request: Request,
    context: RouteContext
): Promise<NextResponse> {
    const jobId = await jobIdFrom(context);
    if (!jobId.ok) return respond(jobId);
    return respond(
        getJobService().finishDiscovery(jobId.value),
        () => ({ ok: true, action: "finish-discovery" }),
        202
    );
}
