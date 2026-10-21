import type { MediaCandidate } from "../media";
import { emptyHints } from "../media";
import {
    classifyKind,
    classifyKindOrDefault,
    extractBackgroundUrls,
    extractComputedBackgroundUrls,
    isHlsUrl,
} from "./css-urls";
import {
    directCandidate,
    type Extractor,
    hintsFrom,
    type PageContext,
    resolveAgainst,
} from "./context";
import { parseSrcset, pickLargestVariant } from "./srcset";
import { extensionOf } from "../url";

/** Lazy-loading attributes, in the order they should be trusted. */
const LAZY_SRC_ATTRIBUTES = [
    "data-src",
    "data-original",
    "data-lazy-src",
    "data-echo",
] as const;
const LAZY_SRCSET_ATTRIBUTES = ["data-srcset", "data-lazy-srcset"] as const;

export const extractImgSrc: Extractor = (context) => {
    const candidates: MediaCandidate[] = [];

    context.$("img").each((_index, element) => {
        const $element = context.$(element);
        const raw =
            $element.attr("src") ??
            LAZY_SRC_ATTRIBUTES.map((attribute) =>
                $element.attr(attribute)
            ).find((value) => value !== undefined);
        if (raw === undefined) return;

        const url = resolveAgainst(context, raw);
        if (url === null) return;

        const hints = hintsFrom({
            alt: $element.attr("alt"),
            title: $element.attr("title"),
            width: $element.attr("width"),
            height: $element.attr("height"),
        });
        candidates.push(
            directCandidate(
                url,
                classifyKindOrDefault(url, null, "image"),
                "img-src",
                context.pageUrl,
                hints
            )
        );
    });

    return candidates;
};

export const extractImgSrcset: Extractor = (context) => {
    const candidates: MediaCandidate[] = [];

    context
        .$("img[srcset], img[data-srcset], img[data-lazy-srcset]")
        .each((_index, element) => {
            const $element = context.$(element);
            const raw =
                $element.attr("srcset") ??
                LAZY_SRCSET_ATTRIBUTES.map((attribute) =>
                    $element.attr(attribute)
                ).find((value) => value !== undefined);
            if (raw === undefined) return;

            const best = pickLargestVariant(parseSrcset(raw));
            if (best === null) return;

            const url = resolveAgainst(context, best.url);
            if (url === null) return;

            const hints = hintsFrom({
                alt: $element.attr("alt"),
                title: $element.attr("title"),
                // The `w` descriptor is the file's real intrinsic width, which is better
                // information than the `width` attribute's layout size.
                width:
                    best.width === null
                        ? $element.attr("width")
                        : String(best.width),
                height:
                    best.width === null ? $element.attr("height") : undefined,
                descriptor: best.descriptor,
            });
            candidates.push(
                directCandidate(
                    url,
                    classifyKindOrDefault(url, null, "image"),
                    "img-srcset",
                    context.pageUrl,
                    hints
                )
            );
        });

    return candidates;
};

export const extractPictureSource: Extractor = (context) => {
    const candidates: MediaCandidate[] = [];

    context.$("picture source").each((_index, element) => {
        const $element = context.$(element);
        const raw = $element.attr("srcset") ?? $element.attr("data-srcset");
        if (raw === undefined) return;

        const best = pickLargestVariant(parseSrcset(raw));
        if (best === null) return;

        const url = resolveAgainst(context, best.url);
        if (url === null) return;

        const type = $element.attr("type");
        const hints = hintsFrom({
            alt: context.$(element).parent().find("img").first().attr("alt"),
            width:
                $element.attr("width") ??
                (best.width === null ? undefined : String(best.width)),
            height: $element.attr("height"),
            type,
            descriptor: best.descriptor,
        });
        candidates.push(
            directCandidate(
                url,
                classifyKindOrDefault(url, type ?? null, "image"),
                "picture-source",
                context.pageUrl,
                hints
            )
        );
    });

    return candidates;
};

export const extractVideo: Extractor = (context) => {
    const candidates: MediaCandidate[] = [];

    const push = (
        raw: string | undefined,
        foundBy: MediaCandidate["foundBy"],
        mime: string | null,
        hints = emptyHints()
    ): void => {
        if (raw === undefined) return;
        const url = resolveAgainst(context, raw);
        if (url === null) return;

        // An `.m3u8` in a `<source>` is a manifest, not a file: yt-dlp has to
        // fetch the segments and remux them.
        if (isHlsUrl(url)) {
            candidates.push({
                url,
                kind: "video",
                acquisition: { strategy: "hls", manifestUrl: url },
                hints,
                foundBy: "hls-manifest",
                foundOn: context.pageUrl,
            });
            return;
        }

        candidates.push(
            directCandidate(
                url,
                classifyKindOrDefault(url, mime, "video"),
                foundBy,
                context.pageUrl,
                hints
            )
        );
    };

    context.$("video").each((_index, element) => {
        const $element = context.$(element);
        const hints = hintsFrom({
            title: $element.attr("title"),
            width: $element.attr("width"),
            height: $element.attr("height"),
        });

        push(
            $element.attr("src") ?? $element.attr("data-src"),
            "video-src",
            null,
            hints
        );

        const poster = $element.attr("poster");
        if (poster !== undefined) {
            const url = resolveAgainst(context, poster);
            if (url !== null) {
                candidates.push(
                    directCandidate(
                        url,
                        classifyKindOrDefault(url, null, "image"),
                        "video-poster",
                        context.pageUrl,
                        hints
                    )
                );
            }
        }

        $element.find("source").each((_sourceIndex, source) => {
            const $source = context.$(source);
            push(
                $source.attr("src"),
                "video-source",
                $source.attr("type") ?? null,
                hints
            );
        });
    });

    return candidates;
};

export const extractCssBackground: Extractor = (context) => {
    const seen = new Set<string>();
    const candidates: MediaCandidate[] = [];

    const push = (raw: string): void => {
        const url = resolveAgainst(context, raw);
        if (url === null || seen.has(url)) return;
        seen.add(url);
        candidates.push(
            directCandidate(
                url,
                classifyKindOrDefault(url, null, "image"),
                "css-background",
                context.pageUrl
            )
        );
    };

    context.$("[style]").each((_index, element) => {
        const style = context.$(element).attr("style");
        if (style !== undefined)
            for (const raw of extractBackgroundUrls(`;${style}`)) push(raw);
    });

    context.$("style").each((_index, element) => {
        for (const raw of extractBackgroundUrls(context.$(element).text()))
            push(raw);
    });

    for (const sheet of context.stylesheets) {
        for (const raw of extractBackgroundUrls(sheet)) push(raw);
    }

    // Computed styles only exist for rendered pages, and are the only way to see
    // a background applied by a class in a stylesheet we never fetched.
    for (const background of context.computedBackgrounds) {
        for (const raw of extractComputedBackgroundUrls(background.value))
            push(raw);
    }

    return candidates;
};

interface EmbedMatch {
    readonly provider: "youtube" | "vimeo" | "dailymotion";
}

/**
 * Only recognised video hosts become embeds. Handing every `<iframe>` to
 * yt-dlp would mean spawning a subprocess for each ad slot, map widget and
 * comment box on the page.
 */
export const matchEmbedProvider = (url: string): EmbedMatch | null => {
    let host: string;
    try {
        host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
        return null;
    }

    if (
        host === "youtube.com" ||
        host === "youtube-nocookie.com" ||
        host === "youtu.be"
    ) {
        return { provider: "youtube" };
    }
    if (host === "vimeo.com" || host === "player.vimeo.com")
        return { provider: "vimeo" };
    if (host === "dailymotion.com" || host === "geo.dailymotion.com")
        return { provider: "dailymotion" };
    return null;
};

export const extractIframeEmbed: Extractor = (context) => {
    const candidates: MediaCandidate[] = [];

    context.$("iframe[src], iframe[data-src]").each((_index, element) => {
        const $element = context.$(element);
        const raw = $element.attr("src") ?? $element.attr("data-src");
        if (raw === undefined) return;

        const url = resolveAgainst(context, raw);
        if (url === null) return;

        const match = matchEmbedProvider(url);
        if (match === null) return;

        candidates.push({
            url,
            kind: "video",
            acquisition: {
                strategy: "embed",
                provider: match.provider,
                embedUrl: url,
            },
            hints: hintsFrom({
                title: $element.attr("title"),
                width: $element.attr("width"),
                height: $element.attr("height"),
            }),
            foundBy: "iframe-embed",
            foundOn: context.pageUrl,
        });
    });

    return candidates;
};

/**
 * Attributes lightbox scripts hang the full-size URL on. Fancybox, PhotoSwipe,
 * Lightbox2, Magnific and the rest all differ, but they cluster here.
 */
const LINK_MEDIA_ATTRIBUTES = [
    "data-src",
    "data-full",
    "data-large",
    "data-image",
    "data-original",
    "data-big",
    "data-zoom-image",
] as const;

/** Lightbox types that are explicitly not an image file. */
const NON_IMAGE_LIGHTBOX_TYPES = /^(iframe|ajax|inline|html|video|pdf)$/i;

/** Markers the common lightboxes tag a gallery link with. */
const LIGHTBOX_MARKER_ATTRIBUTES = [
    "data-fancybox",
    "data-lightbox",
    "data-pswp",
    "data-gallery",
    "data-slb-active",
] as const;
const LIGHTBOX_REL = /^(lightbox|fancybox|prettyphoto|colorbox|shadowbox|magnific)/i;
const LIGHTBOX_CLASS =
    /(^|\s)(lightbox|fancybox|colorbox|glightbox|swipebox|magnific|mfp-image)/i;

/**
 * Fancybox and friends tag the link with the type they will open it as. When
 * that says `image`, the href is an image file even where the path carries no
 * usable extension, which is how a tokenised `get_image` endpoint stays
 * reachable.
 *
 * Takes plain attribute values rather than a Cheerio node: the element generics
 * are awkward to name, and the rule is worth reading on its own.
 */
const declaresImage = (anchor: {
    readonly declaredType: string | undefined;
    readonly rel: string | undefined;
    readonly className: string | undefined;
    readonly hasMarkerAttribute: boolean;
    readonly wrapsImage: boolean;
}): boolean => {
    const declared = anchor.declaredType?.trim().toLowerCase();
    if (declared !== undefined && declared !== "") {
        if (NON_IMAGE_LIGHTBOX_TYPES.test(declared)) return false;
        if (declared === "image") return true;
    }

    // A generic marker only counts when it wraps a thumbnail. That pairing is a
    // gallery item; a bare marked link is as often a detail page.
    const marked =
        anchor.hasMarkerAttribute ||
        LIGHTBOX_REL.test(anchor.rel ?? "") ||
        LIGHTBOX_CLASS.test(anchor.className ?? "");
    return marked && anchor.wrapsImage;
};

/**
 * The gallery pattern: a thumbnail wrapped in a link to the real file.
 *
 *   <a href="/full/photo.jpg"><img src="/thumb/photo.jpg"></a>
 *
 * Without this the thumbnail is collected and the full-size URL is handed to
 * the crawler as if it were a page, fetched, and discarded for not being HTML.
 * The one file worth having is the one that gets thrown away.
 */
export const extractLinkedMedia: Extractor = (context) => {
    const candidates: MediaCandidate[] = [];
    const seen = new Set<string>();

    context.$("a").each((_index, element) => {
        const $element = context.$(element);
        // A link wrapping an image is a gallery item; a bare link is navigation.
        const $thumbnail = $element.find("img").first();
        const wrapsImage = $thumbnail.length > 0;

        const anchorDeclaresImage = declaresImage({
            declaredType:
                $element.attr("data-fancybox-type") ?? $element.attr("data-type"),
            rel: $element.attr("rel"),
            className: $element.attr("class"),
            hasMarkerAttribute: LIGHTBOX_MARKER_ATTRIBUTES.some(
                (attribute) => $element.attr(attribute) !== undefined
            ),
            wrapsImage,
        });

        const raw = [
            $element.attr("href"),
            ...LINK_MEDIA_ATTRIBUTES.map((attribute) =>
                $element.attr(attribute)
            ),
        ].filter(
            (value): value is string =>
                value !== undefined && value.trim() !== ""
        );

        for (const value of raw) {
            const url = resolveAgainst(context, value);
            if (url === null || seen.has(url)) continue;

            // Only when the target is recognisably media. Otherwise every
            // navigation link on the page becomes a download candidate.
            let kind = classifyKind(url, null);
            if (kind === null) {
                // The markup's word is taken only for an extensionless URL. A
                // path that states `.html` and still did not classify is
                // telling us what it is, whatever the lightbox claims.
                if (!anchorDeclaresImage || extensionOf(url) !== null) continue;
                kind = "image";
            }

            seen.add(url);
            candidates.push(
                directCandidate(
                    url,
                    kind,
                    "link-href",
                    context.pageUrl,
                    hintsFrom({
                        alt: wrapsImage
                            ? $thumbnail.attr("alt")
                            : $element.attr("title"),
                        title: $element.attr("title"),
                    })
                )
            );
        }
    });

    return candidates;
};

export const htmlExtractors: readonly {
    readonly name: string;
    readonly run: Extractor;
}[] = [
    { name: "img-src", run: extractImgSrc },
    { name: "img-srcset", run: extractImgSrcset },
    { name: "picture-source", run: extractPictureSource },
    { name: "video", run: extractVideo },
    { name: "css-background", run: extractCssBackground },
    { name: "iframe-embed", run: extractIframeEmbed },
    { name: "link-href", run: extractLinkedMedia },
];

export type { PageContext };
