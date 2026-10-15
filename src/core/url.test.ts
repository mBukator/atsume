import { describe, expect, it } from 'vitest';
import { extensionOf, isSameOrigin, normalizeUrl } from './url';

const normalized = (input: string, base?: string): string => {
  const result = normalizeUrl(input, base);
  if (!result.ok) throw new Error(`expected a normalized URL, got ${JSON.stringify(result.error)}`);
  return result.value;
};

describe('normalizeUrl', () => {
  it('strips the fragment', () => {
    expect(normalized('https://a.test/p#section')).toBe('https://a.test/p');
  });

  it('lowercases the host but not the path', () => {
    expect(normalized('https://EXAMPLE.Test/Path/File.JPG')).toBe(
      'https://example.test/Path/File.JPG',
    );
  });

  it('drops the default port only', () => {
    expect(normalized('https://a.test:443/p')).toBe('https://a.test/p');
    expect(normalized('http://a.test:80/p')).toBe('http://a.test/p');
    expect(normalized('https://a.test:8443/p')).toBe('https://a.test:8443/p');
  });

  it('sorts query parameters so orderings collapse to one record', () => {
    expect(normalized('https://a.test/p?b=2&a=1')).toBe(normalized('https://a.test/p?a=1&b=2'));
  });

  it('sorts repeated keys by value', () => {
    expect(normalized('https://a.test/p?t=z&t=a')).toBe('https://a.test/p?t=a&t=z');
  });

  it('resolves against a base', () => {
    expect(normalized('../img/a.png', 'https://a.test/pages/deep/index.html')).toBe(
      'https://a.test/pages/img/a.png',
    );
    expect(normalized('//cdn.test/a.png', 'https://a.test/')).toBe('https://cdn.test/a.png');
  });

  it('keeps trailing slashes distinct, because servers may treat them differently', () => {
    expect(normalized('https://a.test/dir')).not.toBe(normalized('https://a.test/dir/'));
  });

  it('rejects non-http schemes and junk', () => {
    expect(normalizeUrl('data:image/png;base64,AAAA').ok).toBe(false);
    expect(normalizeUrl('javascript:alert(1)').ok).toBe(false);
    expect(normalizeUrl('not a url').ok).toBe(false);
  });
});

describe('isSameOrigin', () => {
  it('separates scheme, host and port', () => {
    expect(isSameOrigin('https://a.test/x', 'https://a.test/y')).toBe(true);
    expect(isSameOrigin('https://a.test/x', 'http://a.test/x')).toBe(false);
    expect(isSameOrigin('https://a.test/x', 'https://cdn.a.test/x')).toBe(false);
  });
});

describe('extensionOf', () => {
  it('reads the extension from the path, ignoring the query', () => {
    expect(extensionOf('https://a.test/img/photo.JPG?v=2')).toBe('jpg');
    expect(extensionOf('https://a.test/video.m3u8')).toBe('m3u8');
  });

  it('sees past a trailing slash', () => {
    // Tokenised gallery endpoints spell the file this way, and reading the
    // empty segment after the slash used to lose the whole asset.
    expect(extensionOf('https://a.test/get_image/2/abc/21663.jpg/')).toBe('jpg');
    expect(extensionOf('https://a.test/get_image/2/abc/21663.jpg/?1-acctoken=xyz')).toBe(
      'jpg',
    );
  });

  it('only skips empty segments, not real ones', () => {
    // `large` is genuinely the last segment here, so there is no extension.
    expect(extensionOf('https://a.test/photo.jpg/large/')).toBeNull();
  });

  it('returns null when there is nothing usable', () => {
    expect(extensionOf('https://a.test/img/photo')).toBeNull();
    expect(extensionOf('https://a.test/.hidden')).toBeNull();
    expect(extensionOf('https://a.test/photo.')).toBeNull();
    expect(extensionOf('https://a.test/archive.tar.verylongextension')).toBeNull();
    expect(extensionOf('https://a.test/gallery/')).toBeNull();
    expect(extensionOf('https://a.test/')).toBeNull();
  });
});
