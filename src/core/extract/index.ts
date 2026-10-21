import type { MediaCandidate } from "../media";
import { emptyHints } from "../media";
import { classifyKind, isHlsUrl } from "./css-urls";
import {
    directCandidate,
    type Extractor,
    type PageContext,
    resolveAgainst,
} from "./context";
import { extractJsonLd, extractMeta } from "./meta";
import {
    extractCssBackground,
    extractIframeEmbed,
    extractImgSrc,
    extractImgSrcset,
    extractLinkedMedia,
    extractPictureSource,
    extractVideo,
} from "./html";

const MEDIA_RESOURCE_TYPES = new Set(["image", "media"]);

/**
 * The network log is how lazy-loaded assets and HLS manifests get caught: an
 * image inserted by script after load never appears in the served markup, and
 * an `.m3u8` is usually requested by a player rather than written into HTML.
 */
export const extractNetworkLog: Extractor = (context) => {
    const candidates: MediaCandidate[] = [];
    const seen = new Set<string>();

    for (const record of context.networkLog) {
        if (record.status >= 400) continue;

        const url = resolveAgainst(context, record.url);
        if (url === null || seen.has(url)) continue;

        if (isHlsUrl(url) || record.contentType?.includes("mpegurl") === true) {
            seen.add(url);
            candidates.push({
                url,
                kind: "video",
                acquisition: { strategy: "hls", manifestUrl: url },
                hints: emptyHints(),
                foundBy: "hls-manifest",
                foundOn: context.pageUrl,
            });
            continue;
        }

        // A request is media if the browser said so or the response says so;
        // resource type alone misses `fetch`-loaded images.
        const kind = classifyKind(url, record.contentType);
        if (kind === null && !MEDIA_RESOURCE_TYPES.has(record.resourceType))
            continue;
        if (kind === null) continue;

        seen.add(url);
        candidates.push(
            directCandidate(url, kind, "network-log", context.pageUrl, {
                ...emptyHints(),
                declaredMimeType: record.contentType,
            })
        );
    }

    return candidates;
};

export const EXTRACTORS: readonly Extractor[] = [
    extractImgSrc,
    extractImgSrcset,
    extractPictureSource,
    extractVideo,
    extractCssBackground,
    extractMeta,
    extractJsonLd,
    extractIframeEmbed,
    extractLinkedMedia,
    extractNetworkLog,
];

/**
 * Deduped on `(url, extractor)` rather than on URL alone. Collapsing to one
 * candidate per URL would throw away the fact that an asset was found three
 * different ways, which is exactly the provenance the manifest reports and the
 * UI filters on. The repository merges the hints when it persists them.
 */
export const dedupeCandidates = (
    candidates: readonly MediaCandidate[]
): MediaCandidate[] => {
    const byKey = new Map<string, MediaCandidate>();

    for (const candidate of candidates) {
        const key = `${candidate.foundBy}\u0000${candidate.url}`;
        const existing = byKey.get(key);
        if (existing === undefined) {
            byKey.set(key, candidate);
            continue;
        }

        byKey.set(key, {
            ...existing,
            hints: {
                alt: existing.hints.alt ?? candidate.hints.alt,
                title: existing.hints.title ?? candidate.hints.title,
                width:
                    Math.max(
                        existing.hints.width ?? 0,
                        candidate.hints.width ?? 0
                    ) || null,
                height:
                    Math.max(
                        existing.hints.height ?? 0,
                        candidate.hints.height ?? 0
                    ) || null,
                declaredMimeType:
                    existing.hints.declaredMimeType ??
                    candidate.hints.declaredMimeType,
                srcsetDescriptor:
                    existing.hints.srcsetDescriptor ??
                    candidate.hints.srcsetDescriptor,
            },
        });
    }

    return [...byKey.values()];
};

export interface ExtractionResult {
    readonly candidates: readonly MediaCandidate[];
    /** Distinct URLs, which is what the crawl counter reports. */
    readonly uniqueUrls: number;
}

export const runExtractors = (
    context: PageContext,
    extractors: readonly Extractor[] = EXTRACTORS
): ExtractionResult => {
    const raw = extractors.flatMap((extractor) => extractor(context));
    const candidates = dedupeCandidates(raw);
    return {
        candidates,
        uniqueUrls: new Set(candidates.map((entry) => entry.url)).size,
    };
};

export * from "./context";
export * from "./css-urls";
export * from "./srcset";
export { extractJsonLd, extractMeta, walkJsonLd } from "./meta";
export {
    extractCssBackground,
    extractIframeEmbed,
    extractImgSrc,
    extractImgSrcset,
    extractLinkedMedia,
    extractPictureSource,
    extractVideo,
    matchEmbedProvider,
} from "./html";
