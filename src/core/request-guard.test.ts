import { describe, expect, it } from "vitest";

import {
    checkRequest,
    configuredHosts,
    describeRefusal,
    type GuardedRequest,
} from "./request-guard";

const none: ReadonlySet<string> = new Set();

const request = (overrides: Partial<GuardedRequest> = {}): GuardedRequest => ({
    pathname: "/api/jobs",
    host: "localhost:3000",
    origin: null,
    secFetchSite: null,
    ...overrides,
});

const refusalOf = (input: GuardedRequest, extra = none): string | null => {
    const result = checkRequest(input, extra);
    return result.ok ? null : result.error.kind;
};

describe("the Host check", () => {
    it.each([
        "localhost:3000",
        "localhost",
        "atsume.localhost:3000",
        "127.0.0.1:3000",
        "192.168.1.20:3000",
        "10.0.0.5",
        "100.101.102.103:3000",
        "[::1]:3000",
        "[fe80::1]:3000",
        "desktop.local:3000",
        "LOCALHOST:3000",
    ])("serves %s", (host) => {
        expect(refusalOf(request({ host }))).toBeNull();
    });

    it.each([
        "evil.example:3000",
        "evil.example",
        "localhost.evil.example:3000",
        "local:3000",
        ":3000",
    ])("refuses %s, which is how a rebound DNS name arrives", (host) => {
        expect(refusalOf(request({ host }))).toBe("foreign-host");
    });

    it("refuses a foreign host on a page as well as on the API", () => {
        expect(refusalOf(request({ pathname: "/", host: "evil.example:3000" }))).toBe(
            "foreign-host"
        );
    });

    it("serves a name listed in ATSUME_HOSTS", () => {
        const extra = configuredHosts({ ATSUME_HOSTS: "pc.tailnet.ts.net" });
        expect(refusalOf(request({ host: "pc.tailnet.ts.net:3000" }), extra)).toBeNull();
    });

    it("lets a request with no Host header through, since no browser sends one", () => {
        expect(refusalOf(request({ host: null }))).toBeNull();
    });
});

describe("the API origin checks", () => {
    it.each(["same-origin", "none"])("serves Sec-Fetch-Site %s", (site) => {
        expect(refusalOf(request({ secFetchSite: site }))).toBeNull();
    });

    it("serves a request that carries neither header, as curl and scripts send", () => {
        expect(refusalOf(request())).toBeNull();
    });

    it("refuses a request another site made", () => {
        expect(refusalOf(request({ secFetchSite: "cross-site" }))).toBe("cross-site");
    });

    /** Another port on localhost is a different origin but the same site. */
    it("refuses a request from another port on the same machine", () => {
        expect(refusalOf(request({ secFetchSite: "same-site" }))).toBe("cross-site");
    });

    it("serves an Origin that matches the Host", () => {
        expect(refusalOf(request({ origin: "http://localhost:3000" }))).toBeNull();
        expect(
            refusalOf(
                request({ host: "192.168.1.20:3000", origin: "http://192.168.1.20:3000" })
            )
        ).toBeNull();
    });

    it.each(["https://evil.example", "http://localhost:5173", "null", "not a url"])(
        "refuses Origin %s",
        (origin) => {
            expect(refusalOf(request({ origin }))).toBe("foreign-origin");
        }
    );

    it("leaves pages alone, since following a link from another site is how a page is opened", () => {
        expect(
            refusalOf(
                request({
                    pathname: "/jobs",
                    secFetchSite: "cross-site",
                    origin: "https://a.example",
                })
            )
        ).toBeNull();
    });

    it("guards the unlock route like any other API route", () => {
        expect(
            refusalOf(request({ pathname: "/api/unlock", secFetchSite: "cross-site" }))
        ).toBe("cross-site");
    });
});

describe("configuredHosts", () => {
    it("reads a comma-separated list, ignoring ports, case and blanks", () => {
        expect([
            ...configuredHosts({ ATSUME_HOSTS: " PC.example:3000, ,nas.home " }),
        ]).toEqual(["pc.example", "nas.home"]);
    });

    it("is empty when unset", () => {
        expect(configuredHosts({}).size).toBe(0);
    });
});

describe("describeRefusal", () => {
    it("tells the operator how to allow a host that is theirs", () => {
        expect(describeRefusal({ kind: "foreign-host", host: "pc.example" })).toContain(
            "ATSUME_HOSTS"
        );
    });
});
