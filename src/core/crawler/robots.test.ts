import { describe, expect, it } from 'vitest';
import { isPathAllowed, parseRobots, pathAndQuery, productToken, selectGroup } from './robots';

const allowed = (robots: string, path: string, agent = 'Atsume/0.1'): boolean =>
  isPathAllowed(selectGroup(parseRobots(robots), agent), path).kind === 'allowed';

describe('parseRobots', () => {
  it('groups rules under their user-agent', () => {
    const robots = parseRobots(`
      User-agent: *
      Disallow: /private

      User-agent: Atsume
      Disallow: /nope
      Crawl-delay: 2
    `);

    expect(robots.groups).toHaveLength(2);
    expect(robots.groups[1]?.agents).toEqual(['atsume']);
    expect(robots.groups[1]?.crawlDelayMs).toBe(2_000);
  });

  it('treats consecutive user-agent lines as one group', () => {
    const robots = parseRobots(`
      User-agent: alpha
      User-agent: beta
      Disallow: /x
    `);

    expect(robots.groups).toHaveLength(1);
    expect(robots.groups[0]?.agents).toEqual(['alpha', 'beta']);
  });

  it('starts a new group when an agent line follows a rule', () => {
    const robots = parseRobots(`
      User-agent: alpha
      Disallow: /x
      User-agent: beta
      Disallow: /y
    `);

    expect(robots.groups).toHaveLength(2);
  });

  it('collects sitemaps regardless of position', () => {
    const robots = parseRobots(`
      Sitemap: https://a.test/sitemap.xml
      User-agent: *
      Disallow:
      Sitemap: https://a.test/news.xml
    `);

    expect(robots.sitemaps).toEqual(['https://a.test/sitemap.xml', 'https://a.test/news.xml']);
  });

  it('strips comments and ignores junk lines', () => {
    const robots = parseRobots(`
      # a comment
      User-agent: *   # trailing comment
      Disallow: /admin # keep out
      this line is not a directive
    `);

    expect(robots.groups[0]?.rules).toEqual([{ allow: false, pattern: '/admin' }]);
  });

  it('drops an empty Disallow instead of matching everything', () => {
    const robots = parseRobots('User-agent: *\nDisallow:');
    expect(robots.groups[0]?.rules).toEqual([]);
    expect(allowed('User-agent: *\nDisallow:', '/anything')).toBe(true);
  });

  it('accepts a fractional crawl-delay', () => {
    expect(parseRobots('User-agent: *\nCrawl-delay: 0.5').groups[0]?.crawlDelayMs).toBe(500);
  });

  it('ignores a nonsense crawl-delay', () => {
    expect(parseRobots('User-agent: *\nCrawl-delay: soon').groups[0]?.crawlDelayMs).toBeNull();
  });
});

describe('selectGroup', () => {
  const robots = parseRobots(`
    User-agent: *
    Disallow: /everyone

    User-agent: media
    Disallow: /short

    User-agent: atsume
    Disallow: /exact
  `);

  it('prefers the longest matching agent prefix', () => {
    expect(selectGroup(robots, 'Atsume/0.1')?.rules[0]?.pattern).toBe('/exact');
  });

  it('falls back to the wildcard group for an unrelated agent', () => {
    expect(selectGroup(robots, 'SomeoneElse/2.0')?.rules[0]?.pattern).toBe('/everyone');
  });

  it('returns null when there is no applicable group at all', () => {
    const narrow = parseRobots('User-agent: googlebot\nDisallow: /');
    expect(selectGroup(narrow, 'Atsume/0.1')).toBeNull();
  });

  it('reduces a full user-agent string to its product token', () => {
    expect(productToken('Atsume/0.1 (local tool; obeys robots.txt)')).toBe('atsume');
  });
});

describe('isPathAllowed', () => {
  it('allows everything when no group applies', () => {
    expect(isPathAllowed(null, '/anything').kind).toBe('allowed');
  });

  it('applies the longest match, not the first', () => {
    const robots = 'User-agent: *\nDisallow: /\nAllow: /public';
    expect(allowed(robots, '/public/a.jpg')).toBe(true);
    expect(allowed(robots, '/private/a.jpg')).toBe(false);
  });

  it('breaks a length tie in favour of Allow', () => {
    const robots = 'User-agent: *\nDisallow: /media\nAllow: /media';
    expect(allowed(robots, '/media/a.jpg')).toBe(true);
  });

  it('expands * as a wildcard', () => {
    const robots = 'User-agent: *\nDisallow: /*/private';
    expect(allowed(robots, '/blog/private/x')).toBe(false);
    expect(allowed(robots, '/blog/public/x')).toBe(true);
  });

  it('anchors a trailing $', () => {
    const robots = 'User-agent: *\nDisallow: /*.pdf$';
    expect(allowed(robots, '/docs/report.pdf')).toBe(false);
    expect(allowed(robots, '/docs/report.pdf?download=1')).toBe(true);
  });

  it('treats regex metacharacters in a pattern as literals', () => {
    const robots = 'User-agent: *\nDisallow: /a+b(c)';
    expect(allowed(robots, '/a+b(c)/x')).toBe(false);
    expect(allowed(robots, '/aab')).toBe(true);
  });

  it('matches against the query string as well as the path', () => {
    const robots = 'User-agent: *\nDisallow: /search?q=';
    expect(allowed(robots, '/search?q=cats')).toBe(false);
    expect(allowed(robots, '/search')).toBe(true);
  });

  it('reports which pattern did the blocking', () => {
    const group = selectGroup(parseRobots('User-agent: *\nDisallow: /admin'), 'Atsume');
    const decision = isPathAllowed(group, '/admin/users');
    expect(decision).toEqual({ kind: 'disallowed', pattern: '/admin' });
  });
});

describe('pathAndQuery', () => {
  it('keeps the query and drops the origin', () => {
    expect(pathAndQuery('https://a.test/p/x?y=1#frag')).toBe('/p/x?y=1');
  });

  it('degrades to root for an unparseable input', () => {
    expect(pathAndQuery('nonsense')).toBe('/');
  });
});
