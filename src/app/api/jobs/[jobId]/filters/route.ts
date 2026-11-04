import type { NextResponse } from "next/server";

import { jobIdFrom, readJson, respond, type RouteContext } from "../../../_lib/respond";
import { getJobService } from "../../../_lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
    request: Request,
    context: RouteContext
): Promise<NextResponse> {
    const jobId = await jobIdFrom(context);
    if (!jobId.ok) return respond(jobId);

    const body = await readJson(request);
    if (!body.ok) return respond(body);

    // Re-filtering is deliberately cheap: no crawl, no network, just a re-read
    // of stored probe data against the new thresholds.
    return respond(getJobService().updateFilters(jobId.value, body.value), (filters) => ({
        filters,
    }));
}
