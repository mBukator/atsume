import { describe, expect, it } from 'vitest';
import { readImageDimensions } from './image-header';

const bytes = (...parts: readonly (number | number[] | string | Uint8Array)[]): Uint8Array => {
  const flat: number[] = [];
  for (const part of parts) {
    if (typeof part === 'number') flat.push(part);
    else if (typeof part === 'string') flat.push(...[...part].map((char) => char.charCodeAt(0)));
    else flat.push(...part);
  }
  return new Uint8Array(flat);
};

const be32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const be16 = (value: number): number[] => [(value >>> 8) & 0xff, value & 0xff];
const le16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
const le32 = (value: number): number[] => [...le16(value), ...le16(value >>> 16)];
const le24 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
const pad = (count: number): number[] => new Array<number>(count).fill(0);

describe('PNG', () => {
  const png = (width: number, height: number): Uint8Array =>
    bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), 'IHDR', be32(width), be32(height));

  it('reads dimensions from IHDR', () => {
    expect(readImageDimensions(png(1920, 1080))).toEqual({
      width: 1920,
      height: 1080,
      format: 'png',
    });
  });

  it('rejects a PNG signature with no IHDR', () => {
    const broken = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), 'IEND', pad(8));
    expect(readImageDimensions(broken)).toBeNull();
  });
});

describe('GIF', () => {
  it('reads little-endian dimensions from both versions', () => {
    for (const version of ['GIF87a', 'GIF89a']) {
      const gif = bytes(version, le16(400), le16(300), pad(8));
      expect(readImageDimensions(gif)).toEqual({ width: 400, height: 300, format: 'gif' });
    }
  });
});

describe('BMP', () => {
  it('reads dimensions from the info header', () => {
    const bmp = bytes('BM', pad(16), le32(640), le32(480), pad(8));
    expect(readImageDimensions(bmp)).toEqual({ width: 640, height: 480, format: 'bmp' });
  });

  it('treats a negative height as a top-down bitmap, not a negative size', () => {
    const bmp = bytes('BM', pad(16), le32(640), le32(0xffffffff - 479), pad(8));
    expect(readImageDimensions(bmp)?.height).toBe(480);
  });
});

describe('JPEG', () => {
  const sof = (marker: number, width: number, height: number): number[] => [
    0xff,
    marker,
    ...be16(17),
    8,
    ...be16(height),
    ...be16(width),
    ...pad(10),
  ];

  it('skips intermediate segments to reach the frame header', () => {
    const jpeg = bytes(
      [0xff, 0xd8],
      [0xff, 0xe0, ...be16(16), ...pad(14)], // APP0
      [0xff, 0xdb, ...be16(67), ...pad(65)], // DQT
      sof(0xc0, 2400, 1600),
    );
    expect(readImageDimensions(jpeg)).toEqual({ width: 2400, height: 1600, format: 'jpeg' });
  });

  it('handles a progressive frame header', () => {
    const jpeg = bytes([0xff, 0xd8], sof(0xc2, 800, 600));
    expect(readImageDimensions(jpeg)).toEqual({ width: 800, height: 600, format: 'jpeg' });
  });

  it('does not mistake a Huffman table for a frame header', () => {
    const jpeg = bytes(
      [0xff, 0xd8],
      [0xff, 0xc4, ...be16(30), ...pad(28)], // DHT: 0xC4 sits inside the SOF range
      sof(0xc1, 100, 50),
    );
    expect(readImageDimensions(jpeg)).toEqual({ width: 100, height: 50, format: 'jpeg' });
  });

  it('returns null for a JPEG that is all metadata', () => {
    const jpeg = bytes([0xff, 0xd8], [0xff, 0xe0, ...be16(16), ...pad(14)]);
    expect(readImageDimensions(jpeg)).toBeNull();
  });
});

describe('WebP', () => {
  it('reads a lossy VP8 frame', () => {
    const webp = bytes(
      'RIFF',
      le32(100),
      'WEBP',
      'VP8 ',
      le32(80),
      pad(3), // 3-byte frame tag
      [0x9d, 0x01, 0x2a], // start code
      le16(1024),
      le16(768),
      pad(8),
    );
    expect(readImageDimensions(webp)).toEqual({ width: 1024, height: 768, format: 'webp' });
  });

  it('reads an extended VP8X canvas', () => {
    const webp = bytes(
      'RIFF',
      le32(100),
      'WEBP',
      'VP8X',
      le32(10),
      pad(4),
      le24(1919),
      le24(1079),
      pad(8),
    );
    expect(readImageDimensions(webp)).toEqual({ width: 1920, height: 1080, format: 'webp' });
  });
});

describe('AVIF and HEIC', () => {
  const isobmff = (brand: string, width: number, height: number): Uint8Array =>
    bytes(
      be32(24),
      'ftyp',
      brand,
      pad(12),
      be32(20),
      'ispe',
      pad(4),
      be32(width),
      be32(height),
      pad(8),
    );

  it('finds the spatial extents box in an AVIF', () => {
    expect(readImageDimensions(isobmff('avif', 3000, 2000))).toEqual({
      width: 3000,
      height: 2000,
      format: 'avif',
    });
  });

  it('finds it in a HEIC too', () => {
    expect(readImageDimensions(isobmff('heic', 4032, 3024))?.format).toBe('heic');
  });
});

describe('SVG', () => {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('prefers explicit width and height', () => {
    const svg = encode('<?xml version="1.0"?><svg width="120" height="80" viewBox="0 0 24 24"></svg>');
    expect(readImageDimensions(svg)).toEqual({ width: 120, height: 80, format: 'svg' });
  });

  it('falls back to the viewBox', () => {
    const svg = encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"></svg>');
    expect(readImageDimensions(svg)).toEqual({ width: 640, height: 480, format: 'svg' });
  });

  it('rounds fractional viewBox values', () => {
    const svg = encode('<svg viewBox="0 0 100.6 50.2"></svg>');
    expect(readImageDimensions(svg)).toEqual({ width: 101, height: 50, format: 'svg' });
  });
});

describe('unrecognised input', () => {
  it('returns null rather than guessing', () => {
    expect(readImageDimensions(new Uint8Array(0))).toBeNull();
    expect(readImageDimensions(bytes('not an image at all'))).toBeNull();
    expect(readImageDimensions(bytes([0x00, 0x01, 0x02]))).toBeNull();
  });

  it('survives a header truncated mid-structure', () => {
    const truncated = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), 'IHD');
    expect(readImageDimensions(truncated)).toBeNull();
  });
});
