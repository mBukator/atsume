import { assetIdSchema } from "@/core/ids";
import type { NextResponse } from "next/server";
import { z } from "zod";

import { jobIdFrom, readJson, respond, type RouteContext } from "../../../_lib/respond";
import { getJobService } from "../../../_lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const selectionSchema = z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("all") }),
    z.strictObject({ mode: z.literal("none") }),
    z.strictObject({
        mode: z.literal("ids"),
        assetIds: z.array(assetIdSchema).min(1).max(10_000),
        selected: z.boolean(),
    }),
]);

export async function PATCH(
    request: Request,
    context: RouteContext
): Promise<NextResponse> {
    const jobId = await jobIdFrom(context);
    if (!jobId.ok) return respond(jobId);

    const body = await readJson(request);
    if (!body.ok) return respond(body);

    const parsed = selectionSchema.safeParse(body.value);
    if (!parsed.success) {
        return respond({
            ok: false,
            error: { kind: "invalid-input", detail: parsed.error.message },
        });
    }

    return respond(
        getJobService().setSelection(jobId.value, parsed.data),
        (selected) => ({
            selected,
        })
    );
}
