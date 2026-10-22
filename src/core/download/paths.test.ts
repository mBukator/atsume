import { describe, expect, it } from 'vitest';
import {
  extensionFor,
  nameOf,
  pagePathOf,
  renderTemplate,
  resolveOutputPath,
  safeJoin,
  sanitizeSegment,
} from './paths';

const DEFAULT_TEMPLATE = '{host}/{pagePath}/{type}/{name}-{hash8}.{ext}';

describe('sanitizeSegment', () => {
  it('replaces path separators so a segment cannot become a directory', () => {
    expect(sanitizeSegment('a/b\\c')).toBe('a-b-c');
  });

  it('strips characters that are illegal on Windows', () => {
    expect(sanitizeSegment('re:port<1>?"|*.jpg')).toBe('re-port-1-----.jpg');
  });

  it('strips control characters', () => {
    expect(sanitizeSegment('name\u0000\u001fhere')).toBe('name--here');
  });

  it('removes leading dots so files do not become hidden', () => {
    expect(sanitizeSegment('...hidden')).toBe('hidden');
  });

  it('removes trailing dots and spaces, which Windows drops silently', () => {
    expect(sanitizeSegment('report. . ')).toBe('report');
  });

  it('escapes reserved device names', () => {
    expect(sanitizeSegment('CON')).toBe('_CON');
    expect(sanitizeSegment('nul.jpg')).toBe('_nul.jpg');
    expect(sanitizeSegment('com4')).toBe('_com4');
    expect(sanitizeSegment('console')).toBe('console');
  });

  it('never returns an empty segment', () => {
    expect(sanitizeSegment('')).toBe('_');
    expect(sanitizeSegment('...')).toBe('_');
  });

  it('truncates a long name but keeps its extension', () => {
    const long = `${'x'.repeat(200)}.jpeg`;
    const result = sanitizeSegment(long);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.endsWith('.jpeg')).toBe(true);
  });
});

describe('pagePathOf', () => {
  it('keeps the directory structure of the page', () => {
    expect(pagePathOf('https://a.test/gallery/2026/spring/')).toBe('gallery/2026/spring');
  });

  it('drops a document filename, which describes the directory not a subdirectory', () => {
    expect(pagePathOf('https://a.test/gallery/index.html')).toBe('gallery');
    expect(pagePathOf('https://a.test/shop/item.php')).toBe('shop');
  });

  it('returns empty for a site root', () => {
    expect(pagePathOf('https://a.test/')).toBe('');
  });

  it('decodes percent-encoding and then sanitises it', () => {
    expect(pagePathOf('https://a.test/foto%20alba/')).toBe('foto alba');
  });

  it('cannot be talked into a traversal by an encoded separator', () => {
    expect(pagePathOf('https://a.test/a/%2e%2e%2f%2e%2e/etc/')).not.toContain('..');
  });
});

describe('nameOf', () => {
  it('takes the filename stem', () => {
    expect(nameOf('https://cdn.test/img/sunset-01.jpg')).toBe('sunset-01');
  });

  it('ignores the query string', () => {
    expect(nameOf('https://cdn.test/img/a.jpg?w=800&sig=xyz')).toBe('a');
  });

  it('handles an extensionless URL', () => {
    expect(nameOf('https://cdn.test/asset/99182')).toBe('99182');
  });

  it('falls back for a bare origin', () => {
    expect(nameOf('https://cdn.test/')).toBe('asset');
  });
});

describe('extensionFor', () => {
  it('reads the URL extension when there is one', () => {
    expect(extensionFor('https://cdn.test/a.WEBP', null)).toBe('webp');
  });

  it('falls back to the content type', () => {
    expect(extensionFor('https://cdn.test/asset/1', 'image/jpeg')).toBe('jpg');
    expect(extensionFor('https://cdn.test/asset/1', 'video/mp4; codecs=avc1')).toBe('mp4');
  });

  it('uses bin when it genuinely cannot tell', () => {
    expect(extensionFor('https://cdn.test/asset/1', null)).toBe('bin');
    expect(extensionFor('https://cdn.test/asset/1', 'application/octet-stream')).toBe('bin');
  });
});

describe('renderTemplate', () => {
  const tokens = {
    host: 'cdn.example.test',
    pagePath: 'gallery/spring',
    type: 'image',
    name: 'sunset',
    hash8: 'a1b2c3d4',
    ext: 'jpg',
    index: 7,
    date: '2026-08-14',
  };

  it('substitutes every supported token', () => {
    expect(renderTemplate(DEFAULT_TEMPLATE, tokens)).toBe(
      'cdn.example.test/gallery/spring/image/sunset-a1b2c3d4.jpg',
    );
  });

  it('keeps pagePath multi-segment while sanitising each part', () => {
    const result = renderTemplate('{pagePath}/{name}.{ext}', { ...tokens, pagePath: 'a/../b/c' });
    expect(result).toBe('a/b/c/sunset.jpg');
  });

  it('sanitises a hostile name token into one segment', () => {
    const result = renderTemplate('{name}.{ext}', { ...tokens, name: '../../etc/passwd' });
    expect(result).not.toContain('/');
  });

  it('leaves an unknown token alone rather than emitting undefined', () => {
    expect(renderTemplate('{name}-{nope}.{ext}', tokens)).toBe('sunset-{nope}.jpg');
  });
});

describe('safeJoin', () => {
  it('resolves a relative path under the output directory', () => {
    const result = safeJoin('/out', 'host/image/a.jpg');
    expect(result.ok && result.value).toBe('/out/host/image/a.jpg');
  });

  it('refuses to escape via traversal', () => {
    const result = safeJoin('/out', '../../etc/passwd');
    expect(result.ok).toBe(false);
  });

  it('refuses an absolute path', () => {
    expect(safeJoin('/out', '/etc/passwd').ok).toBe(false);
  });

  it('refuses a path that reduces to nothing', () => {
    expect(safeJoin('/out', './././').ok).toBe(false);
  });

  it('does not let a prefix collision pass as containment', () => {
    const result = safeJoin('/out', 'a.jpg');
    expect(result.ok && result.value.startsWith('/out/')).toBe(true);
    expect(safeJoin('/out', '../outside/a.jpg').ok).toBe(false);
  });
});

describe('resolveOutputPath', () => {
  const base = {
    outputDirectory: '/downloads',
    template: DEFAULT_TEMPLATE,
    assetUrl: 'https://cdn.example.test/img/sunset.jpg',
    pageUrl: 'https://example.test/gallery/index.html',
    kind: 'image',
    sha256: 'deadbeefcafebabe'.repeat(4),
    contentType: 'image/jpeg',
    index: 0,
    now: new Date('2026-08-14T12:00:00Z'),
  };

  it('builds the full path from the template', () => {
    const result = resolveOutputPath(base);
    expect(result.ok && result.value).toBe(
      '/downloads/cdn.example.test/gallery/image/sunset-deadbeef.jpg',
    );
  });

  it('survives a URL crafted to escape the output directory', () => {
    const result = resolveOutputPath({
      ...base,
      assetUrl: 'https://cdn.example.test/..%2F..%2F..%2Fetc%2Fpasswd.jpg',
      pageUrl: 'https://example.test/../../../root/',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.startsWith('/downloads/')).toBe(true);
    expect(result.value).not.toContain('..');
  });

  it('supports a hash-only template with no filename', () => {
    const result = resolveOutputPath({ ...base, template: '{type}/{hash8}.{ext}' });
    expect(result.ok && result.value).toBe('/downloads/image/deadbeef.jpg');
  });

  it('uses the date token', () => {
    const result = resolveOutputPath({ ...base, template: '{date}/{name}-{hash8}.{ext}' });
    expect(result.ok && result.value).toBe('/downloads/2026-08-14/sunset-deadbeef.jpg');
  });

  it('handles a page at the site root, which has no pagePath', () => {
    const result = resolveOutputPath({ ...base, pageUrl: 'https://example.test/' });
    expect(result.ok && result.value).toBe('/downloads/cdn.example.test/image/sunset-deadbeef.jpg');
  });
});
