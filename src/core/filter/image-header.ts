/**
 * Reads intrinsic dimensions out of an image's header. Pure, and deliberately
 * bounded: the probe fetches a few kilobytes with a Range request rather than
 * the whole file, so a 40 MB photo costs the same as a thumbnail to measure.
 */

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
  readonly format: string;
}

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean => {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
};

const ascii = (bytes: Uint8Array, offset: number, length: number): string => {
  if (bytes.length < offset + length) return '';
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const readPng = (bytes: Uint8Array): ImageDimensions | null => {
  if (!startsWith(bytes, PNG_SIGNATURE) || bytes.length < 24) return null;
  if (ascii(bytes, 12, 4) !== 'IHDR') return null;
  const data = view(bytes);
  return { width: data.getUint32(16), height: data.getUint32(20), format: 'png' };
};

const readGif = (bytes: Uint8Array): ImageDimensions | null => {
  if (ascii(bytes, 0, 4) !== 'GIF8' || bytes.length < 10) return null;
  const data = view(bytes);
  return { width: data.getUint16(6, true), height: data.getUint16(8, true), format: 'gif' };
};

const readBmp = (bytes: Uint8Array): ImageDimensions | null => {
  if (ascii(bytes, 0, 2) !== 'BM' || bytes.length < 26) return null;
  const data = view(bytes);
  return {
    width: Math.abs(data.getInt32(18, true)),
    // A negative height means a top-down bitmap, not a negative size.
    height: Math.abs(data.getInt32(22, true)),
    format: 'bmp',
  };
};

// Frame markers that carry dimensions. DHT, DAC, RST and friends do not.
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

const readJpeg = (bytes: Uint8Array): ImageDimensions | null => {
  if (!startsWith(bytes, [0xff, 0xd8])) return null;
  const data = view(bytes);
  let offset = 2;

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === undefined) return null;

    // Padding and standalone markers carry no length field.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }

    const segmentLength = data.getUint16(offset + 2);
    if (JPEG_SOF_MARKERS.has(marker)) {
      return {
        height: data.getUint16(offset + 5),
        width: data.getUint16(offset + 7),
        format: 'jpeg',
      };
    }
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }

  return null;
};

const readWebp = (bytes: Uint8Array): ImageDimensions | null => {
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(bytes, 12, 4);
  const data = view(bytes);

  if (chunk === 'VP8 ' && bytes.length >= 30) {
    // 14-bit dimensions live behind the start code in the lossy bitstream.
    return {
      width: data.getUint16(26, true) & 0x3fff,
      height: data.getUint16(28, true) & 0x3fff,
      format: 'webp',
    };
  }

  if (chunk === 'VP8L' && bytes.length >= 25) {
    const b0 = bytes[21] ?? 0;
    const b1 = bytes[22] ?? 0;
    const b2 = bytes[23] ?? 0;
    const b3 = bytes[24] ?? 0;
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      format: 'webp',
    };
  }

  if (chunk === 'VP8X' && bytes.length >= 30) {
    const readUint24 = (offset: number): number =>
      (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
    return { width: readUint24(24) + 1, height: readUint24(27) + 1, format: 'webp' };
  }

  return null;
};

/**
 * AVIF and HEIC are ISOBMFF containers. Rather than walk the box tree, scan for
 * the `ispe` (image spatial extents) box, which is what actually holds the
 * dimensions and sits within the first few hundred bytes in practice.
 */
const readIsobmff = (bytes: Uint8Array): ImageDimensions | null => {
  if (ascii(bytes, 4, 4) !== 'ftyp') return null;
  const brand = ascii(bytes, 8, 4).toLowerCase();
  const format = brand.startsWith('avi') ? 'avif' : brand.startsWith('hei') ? 'heic' : 'isobmff';

  const data = view(bytes);
  for (let offset = 0; offset + 20 <= bytes.length; offset += 1) {
    if (ascii(bytes, offset, 4) !== 'ispe') continue;
    // 4 bytes of box version and flags precede the dimensions.
    const width = data.getUint32(offset + 8);
    const height = data.getUint32(offset + 12);
    if (width > 0 && height > 0) return { width, height, format };
  }
  return null;
};

const SVG_WIDTH = /\bwidth\s*=\s*["']?\s*([\d.]+)/i;
const SVG_HEIGHT = /\bheight\s*=\s*["']?\s*([\d.]+)/i;
const SVG_VIEWBOX = /\bviewBox\s*=\s*["']\s*[-\d.]+[,\s]+[-\d.]+[,\s]+([\d.]+)[,\s]+([\d.]+)/i;

const readSvg = (bytes: Uint8Array): ImageDimensions | null => {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4_096));
  const openTag = /<svg[^>]*>/i.exec(text);
  if (openTag === null) return null;
  const tag = openTag[0];

  const width = SVG_WIDTH.exec(tag)?.[1];
  const height = SVG_HEIGHT.exec(tag)?.[1];
  if (width !== undefined && height !== undefined) {
    return { width: Math.round(Number(width)), height: Math.round(Number(height)), format: 'svg' };
  }

  const viewBox = SVG_VIEWBOX.exec(tag);
  if (viewBox?.[1] !== undefined && viewBox[2] !== undefined) {
    return {
      width: Math.round(Number(viewBox[1])),
      height: Math.round(Number(viewBox[2])),
      format: 'svg',
    };
  }
  return null;
};

const READERS = [readPng, readGif, readJpeg, readWebp, readBmp, readIsobmff, readSvg] as const;

export const readImageDimensions = (bytes: Uint8Array): ImageDimensions | null => {
  if (bytes.length < 8) return null;
  for (const reader of READERS) {
    const result = reader(bytes);
    if (result !== null && result.width > 0 && result.height > 0) return result;
  }
  return null;
};

/** Enough for every format above, including a long ISOBMFF box prefix. */
export const HEADER_PROBE_BYTES = 64 * 1024;
