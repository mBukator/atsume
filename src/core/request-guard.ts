import { err, unit, type Result } from "./result";

/**
 * Turns away requests that a web page sent on someone else's behalf.
 *
 * The API trusts whoever reaches it, which is right for one person on
 * `localhost` and wrong for a page open in a browser on this very machine:
 * nothing stood between such a page and the API at all. A page on any site
 * could point an `<img>` at `localhost:3000/api/...` or post
 * a `text/plain` body to it, and the browser would deliver the request. The
 * response stays unreadable to that page, but the request has already done its
 * work by then.
 *
 * Two checks close that, and both always run:
 *
 * - The `Host` must be one this app is actually reached by: a loopback or LAN
 *   name, any IP address, or a name listed in `ATSUME_HOSTS`. DNS rebinding,
 *   where an attacker's domain starts resolving to 127.0.0.1 so its page
 *   becomes "same origin" with this server, always arrives under the attacker's
 *   name, so it fails here. An IP address can never be rebound.
 * - An API request must come from this app's own pages, or from no page at
 *   all. A browser marks where a request came from in `Sec-Fetch-Site` and, for
 *   anything but a plain GET, in `Origin`; a page on another site or another
 *   port cannot forge either. curl and scripts send neither, so they pass.
 *
 * Browsers send `Sec-Fetch-Site` only to secure contexts, which a LAN address
 * over plain HTTP is not. There only the `Origin` check applies, so a
 * cross-site GET to a LAN address is not stopped by this file alone.
 */

export type RequestRefusal =
    | { readonly kind: "foreign-host"; readonly host: string }
    | { readonly kind: "cross-site"; readonly site: string }
    | { readonly kind: "foreign-origin"; readonly origin: string };

export interface GuardedRequest {
    readonly pathname: string;
    readonly host: string | null;
    readonly origin: string | null;
    readonly secFetchSite: string | null;
}

/** Sec-Fetch-Site values a request from this app's own pages, or a typed URL, carries. */
const OWN_SITES = new Set(["same-origin", "none"]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** `example.test:3000` to `example.test`, and `[::1]:3000` to `::1`. */
const hostnameOf = (host: string): string => {
    const trimmed = host.trim().toLowerCase();
    if (trimmed.startsWith("[")) {
        const end = trimmed.indexOf("]");
        return end === -1 ? trimmed : trimmed.slice(1, end);
    }
    const colon = trimmed.lastIndexOf(":");
    return colon === -1 ? trimmed : trimmed.slice(0, colon);
};

const isKnownHost = (host: string, extra: ReadonlySet<string>): boolean => {
    const name = hostnameOf(host);
    if (name === "") return false;
    if (name.includes(":") || IPV4.test(name)) return true;
    if (name === "localhost" || name.endsWith(".localhost")) return true;
    // `.local` is mDNS: answered on the local network, never by public DNS, so
    // nobody outside the network can point one at this machine.
    if (name.endsWith(".local")) return true;
    return extra.has(name);
};

/** The host and port an `Origin` header names, or null when it names none. */
const originHost = (origin: string): string | null => {
    try {
        return new URL(origin).host.toLowerCase();
    } catch {
        return null;
    }
};

export const checkRequest = (
    request: GuardedRequest,
    extraHosts: ReadonlySet<string>
): Result<null, RequestRefusal> => {
    // A request without a Host header did not come from a browser, and a browser
    // is the only thing this file defends against.
    if (request.host !== null && !isKnownHost(request.host, extraHosts)) {
        return err({ kind: "foreign-host", host: request.host });
    }

    // Pages may be linked to from anywhere; only the API acts on a request.
    if (!request.pathname.startsWith("/api/")) return unit;

    if (request.secFetchSite !== null && !OWN_SITES.has(request.secFetchSite)) {
        return err({ kind: "cross-site", site: request.secFetchSite });
    }

    if (request.origin !== null) {
        const from = originHost(request.origin);
        if (
            from === null ||
            request.host === null ||
            from !== request.host.trim().toLowerCase()
        ) {
            return err({ kind: "foreign-origin", origin: request.origin });
        }
    }

    return unit;
};

/**
 * Extra host names from `ATSUME_HOSTS`, comma separated, for reaching the app
 * by a name the built-in list does not cover, such as a tailnet name.
 */
export const configuredHosts = (
    env: Record<string, string | undefined>
): ReadonlySet<string> =>
    new Set(
        (env["ATSUME_HOSTS"] ?? "")
            .split(",")
            .map((entry) => hostnameOf(entry))
            .filter((entry) => entry !== "")
    );

export const describeRefusal = (refusal: RequestRefusal): string => {
    switch (refusal.kind) {
        case "foreign-host":
            return `requests for host ${refusal.host} are not served; add it to ATSUME_HOSTS if it is yours`;
        case "cross-site":
            return "the API only answers this app and direct requests, not other sites";
        case "foreign-origin":
            return `the API does not answer requests from ${refusal.origin}`;
    }
};
