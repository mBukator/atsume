import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MediaCandidate } from "../media";
import {
    buildPageContext,
    type NetworkRecord,
    type PageContextInput,
} from "./context";
import { dedupeCandidates, extractNetworkLog, runExtractors } from "./index";
import {
    extractCssBackground,
    extractIframeEmbed,
    extractImgSrc,
    extractImgSrcset,
    extractPictureSource,
    extractVideo,
    matchEmbedProvider,
} from "./html";
import { extractJsonLd, extractMeta } from "./meta";
import { extractLinkedMedia } from "./html";

const PAGE_URL = "https://example.test/gallery/";

const fixture = readFileSync(
    fileURLToPath(new URL("./fixtures/gallery.html", import.meta.url)),
    "utf8"
);

const context = (input: Partial<PageContextInput> & { html: string }) =>
    buildPageContext({ pageUrl: PAGE_URL, ...input });

const urls = (candidates: readonly MediaCandidate[]): string[] =>
    candidates.map((candidate) => candidate.url);

const find = (
    candidates: readonly MediaCandidate[],
    suffix: string
): MediaCandidate | undefined =>
    candidates.find((candidate) => candidate.url.endsWith(suffix));

describe("extractImgSrc", () => {
    const found = extractImgSrc(context({ html: fixture }));

    it("resolves relative sources against the page", () => {
        expect(urls(found)).toContain("https://example.test/img/plain.jpg");
    });

    it("carries alt text and dimensions as hints", () => {
        expect(find(found, "/img/plain.jpg")?.hints).toMatchObject({
            alt: "A plain image",
            width: 800,
            height: 600,
        });
    });

    it("falls back to data-src for lazy-loaded images", () => {
        expect(urls(found)).toContain("https://example.test/img/lazy.png");
    });

    it("classifies a gif as its own kind", () => {
        expect(find(found, "/img/animated.gif")?.kind).toBe("gif");
    });

    it("ignores an img with no usable source", () => {
        expect(extractImgSrc(context({ html: '<img alt="nothing">' }))).toEqual(
            []
        );
    });
});

describe("extractImgSrcset", () => {
    const found = extractImgSrcset(context({ html: fixture }));

    it("takes the largest variant rather than the first", () => {
        expect(urls(found)).toEqual(["https://example.test/img/large.jpg"]);
    });

    it("prefers the w descriptor over the layout width attribute", () => {
        expect(found[0]?.hints).toMatchObject({
            width: 1600,
            srcsetDescriptor: "1600w",
        });
    });

    it("reads data-srcset when srcset is absent", () => {
        const lazy = extractImgSrcset(
            context({
                html: '<img data-srcset="/a.jpg 400w, /b.jpg 900w" alt="x">',
            })
        );
        expect(urls(lazy)).toEqual(["https://example.test/b.jpg"]);
    });
});

describe("extractPictureSource", () => {
    const found = extractPictureSource(context({ html: fixture }));

    it("takes the largest variant from every source element", () => {
        expect(urls(found)).toEqual([
            "https://example.test/img/hero@2x.avif",
            "https://example.test/img/hero.webp",
        ]);
    });

    it("keeps the declared type and borrows alt text from the sibling img", () => {
        expect(found[0]?.hints).toMatchObject({
            declaredMimeType: "image/avif",
            alt: "Hero fallback",
        });
    });
});

describe("extractVideo", () => {
    const found = extractVideo(context({ html: fixture }));

    it("collects every source element", () => {
        expect(urls(found)).toEqual(
            expect.arrayContaining([
                "https://example.test/video/tour.webm",
                "https://example.test/video/tour.mp4",
            ])
        );
    });

    it("treats the poster as an image, not a video", () => {
        expect(find(found, "/video/poster.jpg")?.kind).toBe("image");
        expect(find(found, "/video/poster.jpg")?.foundBy).toBe("video-poster");
    });

    it("routes an m3u8 source to HLS acquisition rather than a direct fetch", () => {
        const stream = find(found, "stream.m3u8");
        expect(stream?.acquisition).toEqual({
            strategy: "hls",
            manifestUrl: "https://cdn.example.test/live/stream.m3u8",
        });
        expect(stream?.foundBy).toBe("hls-manifest");
    });
});

describe("extractCssBackground", () => {
    it("reads inline styles, style blocks and fetched stylesheets", () => {
        const found = extractCssBackground(
            context({
                html: fixture,
                stylesheets: [
                    ".late { background-image: url(/sheet/late.png) }",
                ],
            })
        );

        expect(urls(found)).toEqual(
            expect.arrayContaining([
                "https://example.test/inline/banner.webp",
                "https://example.test/css/hero-2400.jpg",
                "https://example.test/css/decor.png",
                "https://example.test/sheet/late.png",
            ])
        );
    });

    it("does not mistake a font src for page media", () => {
        const found = extractCssBackground(context({ html: fixture }));
        expect(urls(found)).not.toContain(
            "https://example.test/fonts/inter.woff2"
        );
    });

    it("reads computed backgrounds from a rendered page", () => {
        const found = extractCssBackground(
            context({
                html: '<div class="x"></div>',
                computedBackgrounds: [
                    {
                        value: 'url("https://cdn.example.test/computed.jpg")',
                        selector: "div.x",
                    },
                    { value: "none", selector: "body" },
                ],
            })
        );
        expect(urls(found)).toEqual(["https://cdn.example.test/computed.jpg"]);
    });
});

describe("extractMeta", () => {
    const found = extractMeta(context({ html: fixture }));

    it("reads og:image with the dimensions that follow it", () => {
        const share = find(found, "/social/share.png");
        expect(share?.hints).toMatchObject({
            width: 1200,
            height: 630,
            alt: "Share card",
        });
        expect(share?.foundBy).toBe("open-graph");
    });

    it("reads og:video as video and twitter:image as image", () => {
        expect(find(found, "promo.mp4")?.kind).toBe("video");
        expect(find(found, "twitter-card.jpg")?.kind).toBe("image");
    });

    it("ignores meta tags that are not media", () => {
        expect(
            found.every((candidate) => !candidate.url.includes("description"))
        ).toBe(true);
    });
});

describe("extractJsonLd", () => {
    const found = extractJsonLd(context({ html: fixture }));

    it("finds media objects buried inside @graph", () => {
        expect(urls(found)).toEqual(
            expect.arrayContaining([
                "https://cdn.example.test/jsonld-hero.jpg",
                "https://cdn.example.test/jsonld-clip.mp4",
                "https://cdn.example.test/jsonld-thumb.jpg",
            ])
        );
    });

    it("keeps dimensions and captions from the ImageObject", () => {
        expect(find(found, "jsonld-hero.jpg")?.hints).toMatchObject({
            width: 2000,
            height: 1333,
            alt: "Buried image object",
        });
    });

    it("skips a malformed block without losing the valid one", () => {
        expect(found.length).toBeGreaterThan(0);
    });

    it("reads a bare thumbnailUrl string", () => {
        const html = `<script type="application/ld+json">
      {"@type":"Recipe","thumbnailUrl":"https://a.test/thumb.jpg"}
    </script>`;
        expect(urls(extractJsonLd(context({ html })))).toEqual([
            "https://a.test/thumb.jpg",
        ]);
    });

    it("handles an array of images", () => {
        const html = `<script type="application/ld+json">
      {"@type":"Article","image":["https://a.test/1.jpg","https://a.test/2.jpg"]}
    </script>`;
        expect(urls(extractJsonLd(context({ html })))).toHaveLength(2);
    });
});

describe("extractIframeEmbed", () => {
    const found = extractIframeEmbed(context({ html: fixture }));

    it("picks up recognised video hosts", () => {
        expect(found.map((candidate) => candidate.acquisition)).toEqual([
            {
                strategy: "embed",
                provider: "youtube",
                embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
            },
            {
                strategy: "embed",
                provider: "vimeo",
                embedUrl: "https://player.vimeo.com/video/76979871",
            },
        ]);
    });

    it("leaves unrecognised iframes alone", () => {
        expect(urls(found).some((url) => url.includes("google.com/maps"))).toBe(
            false
        );
    });

    it("recognises hosts with and without www", () => {
        expect(matchEmbedProvider("https://youtu.be/abc")?.provider).toBe(
            "youtube"
        );
        expect(
            matchEmbedProvider("https://www.youtube-nocookie.com/embed/x")
                ?.provider
        ).toBe("youtube");
        expect(matchEmbedProvider("https://example.test/embed/x")).toBeNull();
    });
});

describe("extractNetworkLog", () => {
    const record = (overrides: Partial<NetworkRecord>): NetworkRecord => ({
        url: "https://cdn.example.test/asset.jpg",
        resourceType: "image",
        contentType: "image/jpeg",
        contentLength: 1_000,
        status: 200,
        ...overrides,
    });

    it("catches an image the markup never mentioned", () => {
        const found = extractNetworkLog(
            context({ html: "<p>nothing</p>", networkLog: [record({})] })
        );
        expect(urls(found)).toEqual(["https://cdn.example.test/asset.jpg"]);
        expect(found[0]?.foundBy).toBe("network-log");
    });

    it("routes an m3u8 request to HLS acquisition", () => {
        const found = extractNetworkLog(
            context({
                html: "",
                networkLog: [
                    record({
                        url: "https://cdn.example.test/live/index.m3u8",
                        resourceType: "xhr",
                        contentType: "application/vnd.apple.mpegurl",
                    }),
                ],
            })
        );
        expect(found[0]?.acquisition).toEqual({
            strategy: "hls",
            manifestUrl: "https://cdn.example.test/live/index.m3u8",
        });
    });

    it("ignores non-media requests and failed responses", () => {
        const found = extractNetworkLog(
            context({
                html: "",
                networkLog: [
                    record({
                        url: "https://a.test/app.js",
                        resourceType: "script",
                        contentType: "text/javascript",
                    }),
                    record({
                        url: "https://a.test/api",
                        resourceType: "fetch",
                        contentType: "application/json",
                    }),
                    record({ url: "https://a.test/gone.jpg", status: 404 }),
                ],
            })
        );
        expect(found).toEqual([]);
    });

    it("catches an image loaded by fetch, which the resource type alone would miss", () => {
        const found = extractNetworkLog(
            context({
                html: "",
                networkLog: [
                    record({
                        url: "https://a.test/blob/1",
                        resourceType: "fetch",
                        contentType: "image/webp",
                    }),
                ],
            })
        );
        expect(found[0]?.kind).toBe("image");
    });
});

describe("dedupeCandidates", () => {
    it("collapses repeats from the same extractor and merges their hints", () => {
        const html =
            '<img src="/a.jpg" alt="first"><img src="/a.jpg" width="900" height="600">';
        const found = extractImgSrc(context({ html }));
        const deduped = dedupeCandidates(found);

        expect(deduped).toHaveLength(1);
        expect(deduped[0]?.hints).toMatchObject({
            alt: "first",
            width: 900,
            height: 600,
        });
    });

    it("keeps one candidate per extractor for a URL found several ways", () => {
        const html = `
      <img src="https://cdn.example.test/shared.jpg" alt="in markup">
      <meta property="og:image" content="https://cdn.example.test/shared.jpg">`;
        const { candidates } = runExtractors(context({ html }));
        const shared = candidates.filter((candidate) =>
            candidate.url.endsWith("shared.jpg")
        );

        expect(shared.map((candidate) => candidate.foundBy).sort()).toEqual([
            "img-src",
            "open-graph",
        ]);
    });
});

describe("runExtractors on the fixture", () => {
    const { candidates, uniqueUrls } = runExtractors(
        context({
            html: fixture,
            stylesheets: [".late { background-image: url(/sheet/late.png) }"],
        })
    );

    it("finds every asset on the page exactly once per extractor", () => {
        expect(candidates.length).toBe(
            new Set(candidates.map((c) => `${c.foundBy}|${c.url}`)).size
        );
        expect(uniqueUrls).toBeGreaterThanOrEqual(18);
    });

    it("collects a tokenised original and its cross-host thumbnail", () => {
        const original = find(
            candidates,
            "/get_image/2/9f2c8ad1/21663.jpg/?1-acctoken=abc123"
        );
        expect(original).toMatchObject({ kind: "image", foundBy: "link-href" });

        // The thumbnail is a separate asset on a separate host, and stays one:
        // `minWidth` is what tells them apart, not the extractor.
        const thumbnail = find(candidates, "/albums/200x150/1621664.jpg");
        expect(thumbnail).toMatchObject({ foundBy: "img-src" });
        expect(thumbnail?.hints).toMatchObject({ width: 200, height: 150 });
    });

    it("records provenance on every candidate", () => {
        expect(
            candidates.every((candidate) => candidate.foundOn === PAGE_URL)
        ).toBe(true);
        expect(
            new Set(candidates.map((candidate) => candidate.foundBy)).size
        ).toBeGreaterThanOrEqual(8);
    });

    it("never emits a relative or non-http URL", () => {
        expect(
            candidates.every((candidate) =>
                candidate.url.startsWith("https://")
            )
        ).toBe(true);
    });

    it("assigns every candidate an acquisition strategy matching its kind", () => {
        for (const candidate of candidates) {
            if (candidate.acquisition.strategy === "embed")
                expect(candidate.kind).toBe("video");
            if (candidate.acquisition.strategy === "hls")
                expect(candidate.kind).toBe("video");
        }
    });

    it("resolves against <base href> when the page declares one", () => {
        const html =
            '<head><base href="https://cdn.example.test/assets/"></head><img src="x.jpg">';
        const { candidates: based } = runExtractors(context({ html }));
        expect(urls(based)).toEqual(["https://cdn.example.test/assets/x.jpg"]);
    });

    it("returns nothing for a page with no media", () => {
        const { candidates: none } = runExtractors(
            context({ html: "<p>just words</p>" })
        );
        expect(none).toEqual([]);
    });
});

describe("extractLinkedMedia", () => {
    const PAGE = "https://site.test/album/";
    const ctx = (html: string) => buildPageContext({ pageUrl: PAGE, html });

    it("takes the full-size file a thumbnail links to", () => {
        const found = extractLinkedMedia(
            ctx(
                '<a href="/full/photo.jpg"><img src="/thumb/photo.jpg" alt="Plate one"></a>'
            )
        );

        expect(found.map((c) => c.url)).toEqual([
            "https://site.test/full/photo.jpg",
        ]);
        expect(found[0]).toMatchObject({ kind: "image", foundBy: "link-href" });
        // The alt on the thumbnail describes the full-size file too.
        expect(found[0]?.hints.alt).toBe("Plate one");
    });

    it("reads the data attributes lightboxes hang the real URL on", () => {
        const found = extractLinkedMedia(
            ctx(
                '<a href="/album/2/" data-large="/full/2.jpg" data-src="/full/2-hd.webp"><img src="/t.jpg"></a>'
            )
        );

        expect(found.map((c) => c.url).sort()).toEqual([
            "https://site.test/full/2-hd.webp",
            "https://site.test/full/2.jpg",
        ]);
    });

    it("leaves ordinary navigation alone", () => {
        const found = extractLinkedMedia(
            ctx(
                '<a href="/about/">About</a><a href="/gallery/page-2">Next</a><a href="/x.pdf">Doc</a>'
            )
        );
        expect(found).toEqual([]);
    });

    it("classifies a linked video as video and a linked gif as gif", () => {
        const found = extractLinkedMedia(
            ctx('<a href="/clip.mp4">clip</a><a href="/anim.gif">anim</a>')
        );
        expect(found.map((c) => c.kind)).toEqual(["video", "gif"]);
    });

    it("does not duplicate when href and a data attribute agree", () => {
        const found = extractLinkedMedia(
            ctx(
                '<a href="/full/a.jpg" data-src="/full/a.jpg"><img src="/t.jpg"></a>'
            )
        );
        expect(found).toHaveLength(1);
    });

    it("takes an original whose path ends in a slash after the extension", () => {
        // The shape a tokenised gallery endpoint serves: the extension is not in
        // the last path segment, and the token is required to fetch the file.
        const found = extractLinkedMedia(
            ctx(
                '<a href="https://site.test/get_image/2/9f2c/21663.jpg/?1-acctoken=xyz"' +
                    ' class="item" rel="images" data-fancybox-type="image">' +
                    '<img class="thumb" src="https://cdn.other.test/200x150/1621664.jpg"' +
                    ' alt="Plate one" width="200" height="150"></a>'
            )
        );

        expect(found.map((c) => c.url)).toEqual([
            "https://site.test/get_image/2/9f2c/21663.jpg/?1-acctoken=xyz",
        ]);
        expect(found[0]).toMatchObject({ kind: "image", foundBy: "link-href" });
        expect(found[0]?.hints.alt).toBe("Plate one");
    });

    it("trusts a link the lightbox markup declares to be an image", () => {
        const found = extractLinkedMedia(
            ctx(
                '<a href="/get_image/9f2c" data-fancybox-type="image"><img src="/t.jpg"></a>'
            )
        );
        expect(found.map((c) => c.url)).toEqual(["https://site.test/get_image/9f2c"]);
        expect(found[0]?.kind).toBe("image");
    });

    it("believes a lightbox that declares a type other than image", () => {
        const found = extractLinkedMedia(
            ctx(
                '<a href="/page/2" data-fancybox-type="iframe"><img src="/t.jpg"></a>'
            )
        );
        expect(found).toEqual([]);
    });

    it("needs a thumbnail before a generic lightbox marker counts", () => {
        const wrapping = extractLinkedMedia(
            ctx('<a class="lightbox" href="/photo/1234"><img src="/t.jpg"></a>')
        );
        expect(wrapping.map((c) => c.url)).toEqual(["https://site.test/photo/1234"]);

        const bare = extractLinkedMedia(
            ctx('<a class="lightbox" href="/photo/1234">See more</a>')
        );
        expect(bare).toEqual([]);
    });

    it("will not guess when the URL states an extension of its own", () => {
        // The path says `.html`; a lightbox claiming otherwise does not win.
        const found = extractLinkedMedia(
            ctx(
                '<a href="/album/2.html" data-fancybox-type="image"><img src="/t.jpg"></a>'
            )
        );
        expect(found).toEqual([]);
    });

    it("leaves an unmarked link to a detail page alone", () => {
        // No extension and no declaration, so this stays a page for the crawler.
        const found = extractLinkedMedia(
            ctx('<a href="/photo/1234"><img src="/t.jpg"></a>')
        );
        expect(found).toEqual([]);
    });
});
