import { describe, expect, it } from 'vitest';
import {
  classifyKind,
  extractBackgroundUrls,
  extractComputedBackgroundUrls,
  extractCssUrls,
  isHlsUrl,
} from './css-urls';
import { parseSrcset, pickLargestVariant } from './srcset';

describe('parseSrcset', () => {
  it('reads width descriptors', () => {
    expect(parseSrcset('a.jpg 400w, b.jpg 800w')).toEqual([
      { url: 'a.jpg', descriptor: '400w', width: 400, density: null },
      { url: 'b.jpg', descriptor: '800w', width: 800, density: null },
    ]);
  });

  it('reads density descriptors, including fractional ones', () => {
    expect(parseSrcset('a.jpg 1x, b.jpg 1.5x, c.jpg 2x').map((entry) => entry.density)).toEqual([
      1, 1.5, 2,
    ]);
  });

  it('handles entries with no descriptor', () => {
    expect(parseSrcset('only.jpg')).toEqual([
      { url: 'only.jpg', descriptor: null, width: null, density: null },
    ]);
  });

  it('handles a comma directly after a URL with no descriptor', () => {
    expect(parseSrcset('a.jpg, b.jpg 2x').map((entry) => entry.url)).toEqual(['a.jpg', 'b.jpg']);
  });

  it('does not split on commas inside a URL', () => {
    const parsed = parseSrcset('https://cdn.test/w_400,h_300/img.jpg 400w, https://cdn.test/w_800,h_600/img.jpg 800w');
    expect(parsed.map((entry) => entry.url)).toEqual([
      'https://cdn.test/w_400,h_300/img.jpg',
      'https://cdn.test/w_800,h_600/img.jpg',
    ]);
  });

  it('tolerates newlines and runs of whitespace', () => {
    const parsed = parseSrcset('\n  a.jpg   400w ,\n  b.jpg   800w\n');
    expect(parsed.map((entry) => entry.width)).toEqual([400, 800]);
  });

  it('keeps an unrecognised descriptor as text without inventing a number', () => {
    expect(parseSrcset('a.jpg 400vw')).toEqual([
      { url: 'a.jpg', descriptor: '400vw', width: null, density: null },
    ]);
  });

  it('returns nothing for empty input', () => {
    expect(parseSrcset('')).toEqual([]);
    expect(parseSrcset('   ,  , ')).toEqual([]);
  });
});

describe('pickLargestVariant', () => {
  it('picks the widest, not the first', () => {
    const best = pickLargestVariant(parseSrcset('a.jpg 1600w, b.jpg 400w, c.jpg 800w'));
    expect(best?.url).toBe('a.jpg');
  });

  it('picks the highest density when no widths are given', () => {
    const best = pickLargestVariant(parseSrcset('a.jpg 1x, b.jpg 3x, c.jpg 2x'));
    expect(best?.url).toBe('b.jpg');
  });

  it('prefers width over density when the list mixes both', () => {
    const best = pickLargestVariant(parseSrcset('small.jpg 2x, big.jpg 1600w'));
    expect(best?.url).toBe('big.jpg');
  });

  it('falls back to the only entry when there are no descriptors', () => {
    expect(pickLargestVariant(parseSrcset('only.jpg'))?.url).toBe('only.jpg');
  });

  it('returns null for an empty list', () => {
    expect(pickLargestVariant([])).toBeNull();
  });
});

describe('extractCssUrls', () => {
  it('handles single quotes, double quotes and bare URLs', () => {
    expect(extractCssUrls(`url('a.png') url("b.png") url(c.png)`)).toEqual([
      'a.png',
      'b.png',
      'c.png',
    ]);
  });

  it('tolerates whitespace inside the function', () => {
    expect(extractCssUrls('url(  "spaced.png"  )')).toEqual(['spaced.png']);
  });

  it('skips SVG fragment references', () => {
    expect(extractCssUrls('url(#gradient)')).toEqual([]);
  });
});

describe('extractBackgroundUrls', () => {
  it('reads background and background-image but not other properties', () => {
    const css = `
      .a { background-image: url(a.png); }
      .b { background: #fff url(b.png) no-repeat; }
      .c { list-style-image: url(c.png); }
      @font-face { src: url(d.woff2); }
    `;
    expect(extractBackgroundUrls(css)).toEqual(['a.png', 'b.png']);
  });

  it('reads every layer of a multi-layer background', () => {
    expect(extractBackgroundUrls('.x { background-image: url(one.png), url(two.png); }')).toEqual([
      'one.png',
      'two.png',
    ]);
  });

  it('ignores a background with no image', () => {
    expect(extractBackgroundUrls('.x { background: linear-gradient(red, blue); }')).toEqual([]);
  });
});

describe('extractComputedBackgroundUrls', () => {
  it('reads the value a browser reports', () => {
    expect(extractComputedBackgroundUrls('url("https://a.test/x.png")')).toEqual([
      'https://a.test/x.png',
    ]);
  });

  it('treats none and empty as nothing', () => {
    expect(extractComputedBackgroundUrls('none')).toEqual([]);
    expect(extractComputedBackgroundUrls('')).toEqual([]);
  });
});

describe('classifyKind', () => {
  it('separates gif from other images', () => {
    expect(classifyKind('https://a.test/x.gif', null)).toBe('gif');
    expect(classifyKind('https://a.test/x.png', null)).toBe('image');
  });

  it('lets the MIME type override the extension', () => {
    expect(classifyKind('https://a.test/image.php', 'image/gif')).toBe('gif');
    expect(classifyKind('https://a.test/x.jpg', 'video/mp4')).toBe('video');
  });

  it('recognises streaming manifests as video', () => {
    expect(classifyKind('https://a.test/live.m3u8', null)).toBe('video');
    expect(classifyKind('https://a.test/stream', 'application/vnd.apple.mpegurl')).toBe('video');
  });

  it('returns null when it genuinely cannot tell', () => {
    expect(classifyKind('https://a.test/asset/12345', null)).toBeNull();
    expect(classifyKind('https://a.test/page.html', 'text/html')).toBeNull();
  });

  it('ignores query strings when reading the extension', () => {
    expect(classifyKind('https://a.test/x.webp?v=2&cache=1', null)).toBe('image');
  });
});

describe('isHlsUrl', () => {
  it('detects m3u8 manifests only', () => {
    expect(isHlsUrl('https://a.test/live.m3u8')).toBe(true);
    expect(isHlsUrl('https://a.test/live.mp4')).toBe(false);
  });
});
