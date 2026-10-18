/**
 * Pulls URLs out of CSS declarations. Used for inline `style` attributes,
 * `<style>` blocks, fetched stylesheets, and the computed styles a rendered
 * page reports back.
 */

const URL_FUNCTION = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/g;

export const extractCssUrls = (css: string): string[] => {
  const found: string[] = [];
  for (const match of css.matchAll(URL_FUNCTION)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (value === '' || value.startsWith('#')) continue;
    found.push(value);
  }
  return found;
};

const BACKGROUND_DECLARATION = /(?:^|[;{])\s*(background|background-image)\s*:\s*([^;}]*)/gi;

/**
 * Only background declarations, so a `list-style-image` or a font `src` does
 * not get mistaken for page media.
 */
export const extractBackgroundUrls = (css: string): string[] => {
  const found: string[] = [];
  for (const match of css.matchAll(BACKGROUND_DECLARATION)) {
    const value = match[2];
    if (value === undefined) continue;
    found.push(...extractCssUrls(value));
  }
  return found;
};

/** A computed `background-image` value is already just the declaration value. */
export const extractComputedBackgroundUrls = (value: string): string[] => {
  if (value.trim() === '' || value.trim() === 'none') return [];
  return extractCssUrls(value);
};

import { extensionOf } from '../url';
import type { MediaKind } from '../media';

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'avif',
  'bmp',
  'tif',
  'tiff',
  'svg',
  'ico',
  'heic',
  'heif',
  'jfif',
]);

const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'm4v',
  'webm',
  'mov',
  'avi',
  'mkv',
  'ogv',
  'mpg',
  'mpeg',
  'm3u8',
  'mpd',
  'ts',
  'flv',
  'wmv',
]);

/**
 * MIME type beats extension: a CDN serving `/image/1234` as `image/gif` is
 * common, and a `.php` endpoint returning a JPEG is not rare either.
 */
export const classifyKind = (url: string, mimeType: string | null): MediaKind | null => {
  const mime = mimeType?.split(';')[0]?.trim().toLowerCase() ?? null;
  if (mime === 'image/gif') return 'gif';
  if (mime !== null && mime.startsWith('image/')) return 'image';
  if (mime !== null && (mime.startsWith('video/') || mime.includes('mpegurl'))) return 'video';

  const extension = extensionOf(url);
  if (extension === 'gif') return 'gif';
  if (extension !== null && IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (extension !== null && VIDEO_EXTENSIONS.has(extension)) return 'video';

  return null;
};

/** Extensionless CDN URLs are common enough that dropping them loses real assets. */
export const classifyKindOrDefault = (
  url: string,
  mimeType: string | null,
  fallback: MediaKind,
): MediaKind => classifyKind(url, mimeType) ?? fallback;

export const isHlsUrl = (url: string): boolean => extensionOf(url) === 'm3u8';
