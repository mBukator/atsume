import { z } from 'zod';
import { httpUrlSchema, mediaKindSchema } from './media';

/**
 * Every field has a default so the UI can render a fully populated options
 * panel from the schema, and so a job can be created from just a seed URL and
 * an output directory.
 */

const hostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i, 'invalid hostname');

/** A user-supplied regex is external input like any other: it must compile. */
const regexSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((pattern) => {
    try {
      new RegExp(pattern);
      return true;
    } catch {
      return false;
    }
  }, 'not a valid regular expression');

export const crawlOptionsSchema = z.strictObject({
  maxDepth: z.number().int().min(0).max(10).default(2),
  sameOriginOnly: z.boolean().default(true),
  /** Extra hosts to treat as in-scope. Ignored when `sameOriginOnly` is true. */
  additionalHosts: z.array(hostnameSchema).max(50).default([]),
  followSitemap: z.boolean().default(true),
  /** Floor between requests to one host. A larger robots.txt `Crawl-delay` wins. */
  requestDelayMs: z.number().int().min(0).max(60_000).default(250),
  maxConcurrentPages: z.number().int().min(1).max(8).default(3),
  requestTimeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
  userAgent: z
    .string()
    .min(1)
    .max(200)
    .default('Atsume/0.1 (local tool; obeys robots.txt)'),
});
export type CrawlOptions = z.infer<typeof crawlOptionsSchema>;

export const rendererOptionsSchema = z.strictObject({
  mode: z.enum(['auto', 'static-only', 'always-render']).default('auto'),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(20_000),
  networkIdleMs: z.number().int().min(0).max(30_000).default(1_500),
  /** Thresholds that decide when the static parse looks too thin to trust. */
  escalation: z
    .strictObject({
      minBodyTextLength: z.number().int().min(0).default(200),
      minImageCount: z.number().int().min(0).default(3),
      maxScriptToMarkupRatio: z.number().min(0).max(1).default(0.6),
    })
    .prefault({}),
});
export type RendererOptions = z.infer<typeof rendererOptionsSchema>;

export const filterOptionsSchema = z.strictObject({
  kinds: z.array(mediaKindSchema).min(1).default(['image', 'gif', 'video']),
  /** Empty means "any extension". */
  extensions: z.array(z.string().regex(/^[a-z0-9]{1,8}$/)).max(50).default([]),
  minWidth: z.number().int().min(0).default(0),
  minHeight: z.number().int().min(0).default(0),
  minBytes: z.number().int().min(0).default(0),
  urlInclude: regexSchema.nullable().default(null),
  urlExclude: regexSchema.nullable().default(null),
  /**
   * Whether an asset survives when its size or dimensions could not be
   * determined. Defaults to keeping it: silently dropping unmeasurable assets
   * is the failure mode people notice last.
   */
  keepUnmeasured: z.boolean().default(true),
});
export type FilterOptions = z.infer<typeof filterOptionsSchema>;

export const downloadOptionsSchema = z
  .strictObject({
    globalConcurrency: z.number().int().min(1).max(32).default(6),
    perHostConcurrency: z.number().int().min(1).max(16).default(2),
    maxAttempts: z.number().int().min(1).max(10).default(4),
    backoff: z
      .strictObject({
        baseMs: z.number().int().min(50).max(10_000).default(500),
        maxMs: z.number().int().min(100).max(300_000).default(30_000),
        jitterRatio: z.number().min(0).max(1).default(0.3),
      })
      .prefault({}),
    resumePartials: z.boolean().default(true),
    requestTimeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
  })
  .refine(
    (options) => options.perHostConcurrency <= options.globalConcurrency,
    'perHostConcurrency cannot exceed globalConcurrency',
  );
export type DownloadOptions = z.infer<typeof downloadOptionsSchema>;

const PATH_TEMPLATE_TOKENS = [
  'host',
  'pagePath',
  'type',
  'name',
  'hash8',
  'ext',
  'index',
  'date',
] as const;
export type PathTemplateToken = (typeof PATH_TEMPLATE_TOKENS)[number];

const TOKEN_PATTERN = /\{([a-zA-Z0-9]+)\}/g;

export const unknownTemplateTokens = (template: string): string[] =>
  [...template.matchAll(TOKEN_PATTERN)]
    .map((match) => match[1] ?? '')
    .filter((token) => !(PATH_TEMPLATE_TOKENS as readonly string[]).includes(token));

/**
 * Template validation is the first of two lines of defence against writing
 * outside the output directory. The second is per-segment sanitisation at
 * write time, which is where a crafted URL would otherwise smuggle a `..` in.
 */
export const pathTemplateSchema = z
  .string()
  .min(1)
  .max(300)
  .superRefine((template, ctx) => {
    const unknown = unknownTemplateTokens(template);
    if (unknown.length > 0) {
      ctx.addIssue({ code: 'custom', message: `unknown token(s): ${unknown.join(', ')}` });
    }
    if (template.startsWith('/') || template.startsWith('\\')) {
      ctx.addIssue({ code: 'custom', message: 'template must be relative to the output directory' });
    }
    if (template.includes('..')) {
      ctx.addIssue({ code: 'custom', message: 'template must not contain ".."' });
    }
    if (!template.includes('{name}') && !template.includes('{hash8}')) {
      ctx.addIssue({ code: 'custom', message: 'template needs {name} or {hash8} to stay unique' });
    }
  });

const absolutePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value),
    'output directory must be an absolute path',
  );

export const outputOptionsSchema = z.strictObject({
  directory: absolutePathSchema,
  pathTemplate: pathTemplateSchema.default('{host}/{pagePath}/{type}/{name}-{hash8}.{ext}'),
  writeManifest: z.boolean().default(true),
  manifestFilename: z.string().min(1).max(120).default('manifest.json'),
});
export type OutputOptions = z.infer<typeof outputOptionsSchema>;

export const budgetCapsSchema = z.strictObject({
  maxTotalBytes: z.number().int().min(1).default(2 * 1024 ** 3),
  maxFileCount: z.number().int().min(1).default(2_000),
  maxPagesCrawled: z.number().int().min(1).default(200),
  maxDurationMs: z.number().int().min(1_000).default(30 * 60_000),
});
export type BudgetCaps = z.infer<typeof budgetCapsSchema>;

/**
 * External tools. There are deliberately no options here for cookie import,
 * browser impersonation, or age-gate bypass: this tool downloads what a plain
 * client can already reach.
 */
export const toolOptionsSchema = z.strictObject({
  enabled: z.boolean().default(true),
  ytDlpPath: z.string().min(1).max(500).default('yt-dlp'),
  ffmpegPath: z.string().min(1).max(500).default('ffmpeg'),
  timeoutMs: z.number().int().min(10_000).max(3 * 3_600_000).default(15 * 60_000),
  /** Throttles us, not them. Null means no self-imposed ceiling. */
  limitRateBytesPerSecond: z.number().int().min(1_024).nullable().default(null),
  socketTimeoutSeconds: z.number().int().min(1).max(300).default(30),
  retries: z.number().int().min(0).max(10).default(3),
  /** Preferred container when yt-dlp has to merge separate streams. */
  mergeFormat: z.enum(['mp4', 'mkv', 'webm']).default('mp4'),
});
export type ToolOptions = z.infer<typeof toolOptionsSchema>;

/**
 * Caps are the one part of a config worth changing mid-job: a run that stopped
 * at a cap is usually a run whose cap was set too low. Every field is optional
 * and none carries a default, so a patch only touches what it names.
 */
export const budgetCapsPatchSchema = z.strictObject({
  maxTotalBytes: z.number().int().min(1).optional(),
  maxFileCount: z.number().int().min(1).optional(),
  maxPagesCrawled: z.number().int().min(1).optional(),
  maxDurationMs: z.number().int().min(1_000).optional(),
});
export type BudgetCapsPatch = z.infer<typeof budgetCapsPatchSchema>;

export const jobConfigSchema = z.strictObject({
  seedUrl: httpUrlSchema,
  crawl: crawlOptionsSchema.prefault({}),
  renderer: rendererOptionsSchema.prefault({}),
  filters: filterOptionsSchema.prefault({}),
  download: downloadOptionsSchema.prefault({}),
  output: outputOptionsSchema,
  caps: budgetCapsSchema.prefault({}),
  tools: toolOptionsSchema.prefault({}),
});
export type JobConfig = z.infer<typeof jobConfigSchema>;

/**
 * There is intentionally no `respectRobots: false`. robots.txt handling is a
 * property of the crawler, not a user preference.
 */
