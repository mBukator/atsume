import { z } from "zod";
import { assetIdSchema, jobIdSchema } from "./ids";
import { isHttpUrl } from "./url";

export const httpUrlSchema = z
    .string()
    .min(1)
    .refine(isHttpUrl, "must be an absolute http(s) URL");

export const epochMsSchema = z.number().int().nonnegative();

export const mediaKindSchema = z.enum(["image", "gif", "video"]);
export type MediaKind = z.infer<typeof mediaKindSchema>;

/**
 * Provenance is a first-class field, not a debug aid: the manifest reports it,
 * and the selection UI lets you filter by it when one extractor turns out to
 * be producing junk on a particular site.
 */
export const extractorIdSchema = z.enum([
    "img-src",
    "img-srcset",
    "picture-source",
    "video-src",
    "video-source",
    "video-poster",
    "css-background",
    "open-graph",
    "twitter-card",
    "json-ld",
    "iframe-embed",
    "link-href",
    "network-log",
    "hls-manifest",
]);
export type ExtractorId = z.infer<typeof extractorIdSchema>;

export const embedProviderSchema = z.enum([
    "youtube",
    "vimeo",
    "dailymotion",
    "generic",
]);
export type EmbedProvider = z.infer<typeof embedProviderSchema>;

/**
 * How the downloader will actually fetch this thing. Deciding it at discovery
 * time keeps the downloader a dispatch table instead of a pile of URL sniffing.
 */
export const acquisitionPlanSchema = z.discriminatedUnion("strategy", [
    z.strictObject({ strategy: z.literal("direct"), url: httpUrlSchema }),
    z.strictObject({ strategy: z.literal("hls"), manifestUrl: httpUrlSchema }),
    z.strictObject({
        strategy: z.literal("embed"),
        provider: embedProviderSchema,
        embedUrl: httpUrlSchema,
    }),
]);
export type AcquisitionPlan = z.infer<typeof acquisitionPlanSchema>;

/** What the DOM already told us, before any network probe. */
export const mediaHintsSchema = z.strictObject({
    alt: z.string().nullable(),
    title: z.string().nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    declaredMimeType: z.string().nullable(),
    /** The winning `srcset` descriptor, e.g. `1200w` or `3x`. */
    srcsetDescriptor: z.string().nullable(),
});
export type MediaHints = z.infer<typeof mediaHintsSchema>;

export const emptyHints = (): MediaHints => ({
    alt: null,
    title: null,
    width: null,
    height: null,
    declaredMimeType: null,
    srcsetDescriptor: null,
});

/** The pure output of an extractor. No id: identity is assigned on persist. */
export const mediaCandidateSchema = z.strictObject({
    url: httpUrlSchema,
    kind: mediaKindSchema,
    acquisition: acquisitionPlanSchema,
    hints: mediaHintsSchema,
    foundBy: extractorIdSchema,
    foundOn: httpUrlSchema,
});
export type MediaCandidate = z.infer<typeof mediaCandidateSchema>;

export const assetSourceSchema = z.strictObject({
    pageUrl: httpUrlSchema,
    extractor: extractorIdSchema,
    alt: z.string().nullable(),
    discoveredAt: epochMsSchema,
});
export type AssetSource = z.infer<typeof assetSourceSchema>;

export const probeStateSchema = z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("unprobed") }),
    z.strictObject({
        status: z.literal("probed"),
        contentType: z.string().nullable(),
        contentLength: z.number().int().nonnegative().nullable(),
        width: z.number().int().positive().nullable(),
        height: z.number().int().positive().nullable(),
        acceptsRanges: z.boolean(),
        etag: z.string().nullable(),
        lastModified: z.string().nullable(),
        probedAt: epochMsSchema,
    }),
    z.strictObject({
        status: z.literal("probe-failed"),
        reason: z.string(),
        probedAt: epochMsSchema,
    }),
]);
export type ProbeState = z.infer<typeof probeStateSchema>;

export const filterReasonSchema = z.enum([
    "media-kind",
    "extension",
    "min-width",
    "min-height",
    "min-bytes",
    "url-include",
    "url-exclude",
    "unknown-dimensions",
    "unknown-size",
    "not-media",
]);
export type FilterReason = z.infer<typeof filterReasonSchema>;

export const filterVerdictSchema = z.discriminatedUnion("verdict", [
    z.strictObject({ verdict: z.literal("unevaluated") }),
    z.strictObject({ verdict: z.literal("included") }),
    z.strictObject({
        verdict: z.literal("excluded"),
        reason: filterReasonSchema,
    }),
]);
export type FilterVerdict = z.infer<typeof filterVerdictSchema>;

export const downloadErrorSchema = z.discriminatedUnion("kind", [
    z.strictObject({
        kind: z.literal("http"),
        status: z.number().int(),
        message: z.string(),
    }),
    z.strictObject({ kind: z.literal("network"), message: z.string() }),
    z.strictObject({
        kind: z.literal("timeout"),
        afterMs: z.number().int().nonnegative(),
    }),
    z.strictObject({
        kind: z.literal("too-large"),
        limitBytes: z.number().int().nonnegative(),
        observedBytes: z.number().int().nonnegative(),
    }),
    z.strictObject({ kind: z.literal("filesystem"), message: z.string() }),
    z.strictObject({
        kind: z.literal("subprocess"),
        tool: z.enum(["yt-dlp", "ffmpeg"]),
        exitCode: z.number().int().nullable(),
        stderr: z.string(),
    }),
    z.strictObject({ kind: z.literal("cancelled") }),
]);
export type DownloadError = z.infer<typeof downloadErrorSchema>;

export const downloadStateSchema = z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("pending") }),
    z.strictObject({
        status: z.literal("in-progress"),
        bytesDownloaded: z.number().int().nonnegative(),
        totalBytes: z.number().int().nonnegative().nullable(),
        attempt: z.number().int().positive(),
        startedAt: epochMsSchema,
    }),
    z.strictObject({
        status: z.literal("complete"),
        localPath: z.string().min(1),
        bytes: z.number().int().nonnegative(),
        sha256: z.string().length(64),
        completedAt: epochMsSchema,
    }),
    /** Content hash already on disk under a different URL; recorded, not rewritten. */
    z.strictObject({
        status: z.literal("skipped-duplicate"),
        sha256: z.string().length(64),
        duplicateOf: assetIdSchema,
        localPath: z.string().min(1),
    }),
    z.strictObject({
        status: z.literal("failed"),
        error: downloadErrorSchema,
        attempts: z.number().int().positive(),
        failedAt: epochMsSchema,
    }),
]);
export type DownloadState = z.infer<typeof downloadStateSchema>;

/** The persisted record: a candidate plus everything learned about it since. */
export const assetSchema = z.strictObject({
    id: assetIdSchema,
    jobId: jobIdSchema,
    url: httpUrlSchema,
    normalizedUrl: httpUrlSchema,
    kind: mediaKindSchema,
    acquisition: acquisitionPlanSchema,
    hints: mediaHintsSchema,
    sources: z.array(assetSourceSchema).min(1),
    probe: probeStateSchema,
    filter: filterVerdictSchema,
    selected: z.boolean(),
    download: downloadStateSchema,
    firstSeenAt: epochMsSchema,
    updatedAt: epochMsSchema,
});
export type Asset = z.infer<typeof assetSchema>;

/**
 * Best known dimensions: a probe supersedes DOM hints, since `width`/`height`
 * attributes are frequently the layout size rather than the intrinsic size.
 */
export const knownDimensions = (
    asset: Pick<Asset, "hints" | "probe">
): { readonly width: number | null; readonly height: number | null } => {
    if (asset.probe.status === "probed" && asset.probe.width !== null) {
        return { width: asset.probe.width, height: asset.probe.height };
    }
    return { width: asset.hints.width, height: asset.hints.height };
};

export const knownBytes = (
    asset: Pick<Asset, "probe" | "download">
): number | null => {
    if (asset.download.status === "complete") return asset.download.bytes;
    if (asset.probe.status === "probed") return asset.probe.contentLength;
    return null;
};
