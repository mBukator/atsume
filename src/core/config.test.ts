import { describe, expect, it } from 'vitest';
import {
  downloadOptionsSchema,
  filterOptionsSchema,
  jobConfigSchema,
  pathTemplateSchema,
} from './config';

const minimal = { seedUrl: 'https://example.test/gallery', output: { directory: '/tmp/out' } };

describe('jobConfigSchema', () => {
  it('fills every section from a seed URL and an output directory', () => {
    const config = jobConfigSchema.parse(minimal);

    expect(config.crawl.maxDepth).toBe(2);
    expect(config.crawl.sameOriginOnly).toBe(true);
    expect(config.download.globalConcurrency).toBe(6);
    expect(config.download.perHostConcurrency).toBe(2);
    expect(config.download.backoff.baseMs).toBe(500);
    expect(config.renderer.escalation.minImageCount).toBe(3);
    expect(config.filters.kinds).toEqual(['image', 'gif', 'video']);
    expect(config.output.pathTemplate).toBe('{host}/{pagePath}/{type}/{name}-{hash8}.{ext}');
    expect(config.caps.maxPagesCrawled).toBe(200);
  });

  it('rejects a non-http seed', () => {
    expect(jobConfigSchema.safeParse({ ...minimal, seedUrl: 'ftp://example.test' }).success).toBe(
      false,
    );
    expect(jobConfigSchema.safeParse({ ...minimal, seedUrl: '/relative/path' }).success).toBe(false);
  });

  it('rejects a relative output directory', () => {
    expect(
      jobConfigSchema.safeParse({ ...minimal, output: { directory: './downloads' } }).success,
    ).toBe(false);
  });

  it('rejects unknown keys instead of ignoring them', () => {
    const result = jobConfigSchema.safeParse({ ...minimal, crawl: { maxDepth: 1, respectRobots: false } });
    expect(result.success).toBe(false);
  });

  it('is idempotent: parsing its own output changes nothing', () => {
    const once = jobConfigSchema.parse(minimal);
    expect(jobConfigSchema.parse(once)).toEqual(once);
  });
});

describe('downloadOptionsSchema', () => {
  it('rejects a per-host ceiling above the global ceiling', () => {
    const result = downloadOptionsSchema.safeParse({ globalConcurrency: 2, perHostConcurrency: 8 });
    expect(result.success).toBe(false);
  });

  it('accepts equal ceilings', () => {
    expect(
      downloadOptionsSchema.safeParse({ globalConcurrency: 4, perHostConcurrency: 4 }).success,
    ).toBe(true);
  });
});

describe('filterOptionsSchema', () => {
  it('rejects a regex that does not compile', () => {
    expect(filterOptionsSchema.safeParse({ urlExclude: '([a-z' }).success).toBe(false);
  });

  it('accepts a valid regex and null', () => {
    expect(filterOptionsSchema.parse({ urlInclude: '\\.jpe?g$' }).urlInclude).toBe('\\.jpe?g$');
    expect(filterOptionsSchema.parse({}).urlExclude).toBeNull();
  });

  it('requires at least one media kind', () => {
    expect(filterOptionsSchema.safeParse({ kinds: [] }).success).toBe(false);
  });
});

describe('pathTemplateSchema', () => {
  it('accepts the default template', () => {
    expect(pathTemplateSchema.safeParse('{host}/{pagePath}/{type}/{name}-{hash8}.{ext}').success).toBe(
      true,
    );
  });

  it.each([
    ['unknown token', '{host}/{nope}/{name}.{ext}'],
    ['absolute path', '/{host}/{name}.{ext}'],
    ['parent traversal', '{host}/../{name}.{ext}'],
    ['no unique component', '{host}/{type}/image.{ext}'],
  ])('rejects %s', (_label, template) => {
    expect(pathTemplateSchema.safeParse(template).success).toBe(false);
  });

  it('accepts a template keyed only on the content hash', () => {
    expect(pathTemplateSchema.safeParse('{type}/{hash8}.{ext}').success).toBe(true);
  });
});
