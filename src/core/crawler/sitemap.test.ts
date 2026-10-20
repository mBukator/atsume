import { describe, expect, it } from 'vitest';
import { collectSitemapUrls, parseSitemap } from './sitemap';
import { FakeHttpClient } from '../testing';

const requestOptions = { userAgent: 'Atsume/0.1', timeoutMs: 5_000 };

const bounds = {
  maxDocuments: 100,
  deadline: Number.MAX_SAFE_INTEGER,
  now: () => 0,
};

const urlset = (...locs: readonly string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
   <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
     ${locs.map((loc) => `<url><loc>${loc}</loc><lastmod>2026-01-01</lastmod></url>`).join('')}
   </urlset>`;

const sitemapIndex = (...locs: readonly string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
   <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
     ${locs.map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`).join('')}
   </sitemapindex>`;

describe('parseSitemap', () => {
  it('reads a urlset', () => {
    const parsed = parseSitemap(urlset('https://a.test/one', 'https://a.test/two'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.kind !== 'urlset') return;
    expect(parsed.value.entries).toEqual([
      { loc: 'https://a.test/one', lastModified: '2026-01-01' },
      { loc: 'https://a.test/two', lastModified: '2026-01-01' },
    ]);
  });

  it('reads a single-entry urlset, which the XML parser hands back unwrapped', () => {
    const parsed = parseSitemap(urlset('https://a.test/only'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.kind !== 'urlset') return;
    expect(parsed.value.entries).toHaveLength(1);
  });

  it('reads a sitemap index', () => {
    const parsed = parseSitemap(sitemapIndex('https://a.test/s1.xml', 'https://a.test/s2.xml'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.kind !== 'index') return;
    expect(parsed.value.sitemaps).toEqual(['https://a.test/s1.xml', 'https://a.test/s2.xml']);
  });

  it('handles a namespace prefix on the root element', () => {
    const xml = `<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
                   <sm:url><sm:loc>https://a.test/p</sm:loc></sm:url>
                 </sm:urlset>`;
    const parsed = parseSitemap(xml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.kind !== 'urlset') return;
    expect(parsed.value.entries[0]?.loc).toBe('https://a.test/p');
  });

  it('rejects XML that is neither a urlset nor an index', () => {
    expect(parseSitemap('<rss><channel/></rss>').ok).toBe(false);
  });

  it('skips url nodes with no loc', () => {
    const xml = `<urlset><url><lastmod>2026-01-01</lastmod></url><url><loc>https://a.test/p</loc></url></urlset>`;
    const parsed = parseSitemap(xml);
    if (!parsed.ok || parsed.value.kind !== 'urlset') throw new Error('expected a urlset');
    expect(parsed.value.entries).toHaveLength(1);
  });
});

describe('collectSitemapUrls', () => {
  it('follows an index down to the leaf sitemaps', async () => {
    const http = new FakeHttpClient({
      'https://a.test/sitemap.xml': {
        body: sitemapIndex('https://a.test/s1.xml', 'https://a.test/s2.xml'),
      },
      'https://a.test/s1.xml': { body: urlset('https://a.test/one') },
      'https://a.test/s2.xml': { body: urlset('https://a.test/two') },
    });

    const result = await collectSitemapUrls(http, ['https://a.test/sitemap.xml'], {
      maxUrls: 100,
      maxIndexDepth: 3,
      ...bounds,
      request: requestOptions,
    });

    expect(result.urls).toEqual(['https://a.test/one', 'https://a.test/two']);
    expect(result.sitemapsRead).toBe(3);
  });

  it('stops at the URL cap', async () => {
    const http = new FakeHttpClient({
      'https://a.test/sitemap.xml': {
        body: urlset('https://a.test/1', 'https://a.test/2', 'https://a.test/3'),
      },
    });

    const result = await collectSitemapUrls(http, ['https://a.test/sitemap.xml'], {
      maxUrls: 2,
      maxIndexDepth: 3,
      ...bounds,
      request: requestOptions,
    });

    expect(result.urls).toHaveLength(2);
  });

  it('refuses to descend past the index depth limit', async () => {
    const http = new FakeHttpClient({
      'https://a.test/a.xml': { body: sitemapIndex('https://a.test/b.xml') },
      'https://a.test/b.xml': { body: sitemapIndex('https://a.test/c.xml') },
      'https://a.test/c.xml': { body: urlset('https://a.test/deep') },
    });

    const result = await collectSitemapUrls(http, ['https://a.test/a.xml'], {
      maxUrls: 100,
      maxIndexDepth: 1,
      ...bounds,
      request: requestOptions,
    });

    expect(result.urls).toEqual([]);
    expect(result.failures.some((failure) => failure.reason.includes('nested too deeply'))).toBe(true);
  });

  it('records a missing sitemap and keeps going with the others', async () => {
    const http = new FakeHttpClient({
      'https://a.test/good.xml': { body: urlset('https://a.test/p') },
    });

    const result = await collectSitemapUrls(
      http,
      ['https://a.test/missing.xml', 'https://a.test/good.xml'],
      { maxUrls: 100, maxIndexDepth: 3, ...bounds, request: requestOptions },
    );

    expect(result.urls).toEqual(['https://a.test/p']);
    expect(result.failures).toEqual([{ url: 'https://a.test/missing.xml', reason: 'HTTP 404' }]);
  });

  it('does not fetch the same sitemap twice when an index cycles', async () => {
    const http = new FakeHttpClient({
      'https://a.test/a.xml': { body: sitemapIndex('https://a.test/b.xml') },
      'https://a.test/b.xml': { body: sitemapIndex('https://a.test/a.xml') },
    });

    await collectSitemapUrls(http, ['https://a.test/a.xml'], {
      maxUrls: 100,
      maxIndexDepth: 5,
      ...bounds,
      request: requestOptions,
    });

    expect(http.countFor('https://a.test/a.xml')).toBe(1);
    expect(http.countFor('https://a.test/b.xml')).toBe(1);
  });
});

describe('bounds', () => {
  const indexOf = (count: number): string =>
    sitemapIndex(...Array.from({ length: count }, (_v, i) => `https://a.test/s${i}.xml`));

  it('stops after the document ceiling, which a URL count cannot enforce', async () => {
    // An index yields no URLs, so maxUrls never moves and cannot bound this.
    const routes: Record<string, { body: string }> = {
      'https://a.test/sitemap.xml': { body: indexOf(200) },
    };
    for (let i = 0; i < 200; i += 1) {
      routes[`https://a.test/s${i}.xml`] = { body: urlset(`https://a.test/p${i}`) };
    }
    const http = new FakeHttpClient(routes);

    const result = await collectSitemapUrls(http, ['https://a.test/sitemap.xml'], {
      maxUrls: 10_000,
      maxIndexDepth: 3,
      maxDocuments: 5,
      deadline: Number.MAX_SAFE_INTEGER,
      now: () => 0,
      request: requestOptions,
    });

    expect(result.sitemapsRead).toBeLessThanOrEqual(5);
    expect(result.truncated).toBe(true);
    expect(http.requests.length).toBeLessThanOrEqual(6);
  });

  it('stops at the deadline', async () => {
    const routes: Record<string, { body: string }> = {
      'https://a.test/sitemap.xml': { body: indexOf(50) },
    };
    for (let i = 0; i < 50; i += 1) {
      routes[`https://a.test/s${i}.xml`] = { body: urlset(`https://a.test/p${i}`) };
    }

    let clock = 0;
    const result = await collectSitemapUrls(new FakeHttpClient(routes), ['https://a.test/sitemap.xml'], {
      maxUrls: 10_000,
      maxIndexDepth: 3,
      maxDocuments: 1_000,
      deadline: 100,
      // Each check advances time; the walk should give up rather than grind on.
      now: () => (clock += 40),
      request: requestOptions,
    });

    expect(result.truncated).toBe(true);
    expect(result.sitemapsRead).toBeLessThan(50);
  });
});
