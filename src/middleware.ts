import { checkRequest, configuredHosts, describeRefusal } from "@/core/request-guard";
import { NextResponse, type NextRequest } from "next/server";

/**
 * The one place a request is turned away.
 *
 * Everything behind this is written for an audience of one on `localhost`, and
 * the API is correspondingly trusting: it will start a run that writes files to
 * any absolute path on this machine, launch a browser, and run the external
 * tools a job config names. Any web page open in your own browser can reach
 * the port too, so before anything else runs, `src/core/request-guard.ts`
 * refuses a request for a host this app is not reached by, which is how DNS
 * rebinding arrives, and an API request that another site's page sent. Neither
 * check has a setting that turns it off, because nothing legitimate needs one.
 */
export const middleware = (request: NextRequest): NextResponse => {
    const { pathname } = request.nextUrl;

    const guarded = checkRequest(
        {
            pathname,
            host: request.headers.get("host"),
            origin: request.headers.get("origin"),
            secFetchSite: request.headers.get("sec-fetch-site"),
        },
        configuredHosts(process.env)
    );
    if (guarded.ok) return NextResponse.next();

    const detail = describeRefusal(guarded.error);
    return pathname.startsWith("/api/")
        ? NextResponse.json({ error: { kind: "forbidden", detail } }, { status: 403 })
        : new NextResponse(detail, { status: 403 });
};

/**
 * Everything except the static asset paths, which are cheaper to skip before the
 * middleware runs at all.
 */
export const config = {
    matcher: ["/((?!_next/static|_next/image).*)"],
};
