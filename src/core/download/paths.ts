import { isAbsolute } from 'node:path';
import { err, ok, type Result } from '../result';
import { extensionOf } from '../url';

export type PathError =
  | { readonly kind: 'escapes-output-directory'; readonly attempted: string }
  | { readonly kind: 'empty-result' };

export interface PathTokens {
  readonly host: string;
  readonly pagePath: string;
  readonly type: string;
  readonly name: string;
  readonly hash8: string;
  readonly ext: string;
  readonly index: number;
  readonly date: string;
}

// Reserved on Windows with or without an extension, and a file named `CON.jpg`
// is simply uncreatable there.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex -- control characters are exactly what we strip
const ILLEGAL = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;

const MAX_SEGMENT = 80;

/**
 * Makes one path segment safe. Called on every token substitution, not on the
 * joined path, so a `/` smuggled in through a URL cannot create a directory.
 */
export const sanitizeSegment = (raw: string): string => {
  const cleaned = raw
    .replace(ILLEGAL, '-')
    .replace(/\s+/g, ' ')
    .trim()
    // Leading dots hide files on Unix; trailing dots and spaces are stripped
    // silently by Windows, which turns `a.` and `a` into a collision.
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');

  if (cleaned === '') return '_';
  if (WINDOWS_RESERVED.test(cleaned)) return `_${cleaned}`;

  if (cleaned.length <= MAX_SEGMENT) return cleaned;

  // Truncate the stem, keep the extension: `verylongname.jpg` stays a jpg.
  const dot = cleaned.lastIndexOf('.');
  if (dot > 0 && cleaned.length - dot <= 12) {
    const stem = cleaned.slice(0, dot);
    const extension = cleaned.slice(dot);
    return stem.slice(0, MAX_SEGMENT - extension.length) + extension;
  }
  return cleaned.slice(0, MAX_SEGMENT);
};

const sanitizePath = (raw: string): string =>
  raw
    .split(/[/\\]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map(sanitizeSegment)
    .join('/');

/** `https://a.test/gallery/2024/index.html` -> `gallery/2024`. */
export const pagePathOf = (pageUrl: string): string => {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(pageUrl).pathname);
  } catch {
    return '';
  }
  const segments = pathname.split('/').filter((segment) => segment !== '');
  // A trailing `index.html` describes the directory, not a subdirectory.
  const last = segments[segments.length - 1];
  if (last !== undefined && /\.(html?|php|aspx?|jsp)$/i.test(last)) segments.pop();
  return sanitizePath(segments.join('/'));
};

/** The filename stem from an asset URL, before hashing or extension handling. */
export const nameOf = (assetUrl: string): string => {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(assetUrl).pathname);
  } catch {
    return 'asset';
  }
  const last = pathname.split('/').filter((segment) => segment !== '').pop() ?? 'asset';
  const dot = last.lastIndexOf('.');
  const stem = dot > 0 ? last.slice(0, dot) : last;
  const sanitized = sanitizeSegment(stem);
  return sanitized === '_' ? 'asset' : sanitized;
};

export const extensionFor = (assetUrl: string, contentType: string | null): string => {
  const fromUrl = extensionOf(assetUrl);
  if (fromUrl !== null) return fromUrl;

  const mime = contentType?.split(';')[0]?.trim().toLowerCase() ?? null;
  return mime === null ? 'bin' : (MIME_EXTENSIONS[mime] ?? 'bin');
};

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/mpeg': 'mpeg',
  'application/vnd.apple.mpegurl': 'm3u8',
};

const TOKEN = /\{([a-zA-Z0-9]+)\}/g;

export const renderTemplate = (template: string, tokens: PathTokens): string => {
  const values: Readonly<Record<string, string>> = {
    host: sanitizeSegment(tokens.host),
    // Already a multi-segment path; sanitised per segment, not as one string.
    pagePath: sanitizePath(tokens.pagePath),
    type: sanitizeSegment(tokens.type),
    name: sanitizeSegment(tokens.name),
    hash8: sanitizeSegment(tokens.hash8),
    ext: sanitizeSegment(tokens.ext),
    index: String(tokens.index),
    date: sanitizeSegment(tokens.date),
  };

  return template.replace(TOKEN, (match, key: string) => values[key] ?? match);
};

/**
 * The second line of defence. Even with every segment sanitised, the joined
 * path is resolved and checked against the output directory, so nothing a
 * crafted URL can produce writes outside it.
 */
export const safeJoin = (outputDirectory: string, relative: string): Result<string, PathError> => {
  // Rejecting rather than stripping. Every segment is sanitised before it gets
  // here, so a `..` or a leading `/` at this point means something upstream is
  // wrong, and quietly rewriting it would hide the bug.
  if (isAbsolute(relative) || /^[a-zA-Z]:[\\/]/.test(relative)) {
    return err({ kind: 'escapes-output-directory', attempted: relative });
  }

  const segments = relative.split(/[/\\]/).map((segment) => segment.trim());
  if (segments.includes('..')) {
    return err({ kind: 'escapes-output-directory', attempted: relative });
  }

  const cleaned = segments.filter((segment) => segment !== '' && segment !== '.').join('/');
  if (cleaned === '') return err({ kind: 'empty-result' });

  // Join with forward slashes on every platform. `node:path`'s `resolve`/`join`
  // would rewrite the separator to `\` and prepend the current drive on
  // Windows, which both diverges from the URL-derived layout and defeats the
  // containment check below; Node's fs accepts forward slashes on Windows all
  // the same. The relative part is already sanitised and free of `..`, so a
  // plain prefix check is a sufficient second line of defence.
  const base = outputDirectory.replace(/\\/g, '/').replace(/\/+$/, '');
  const target = `${base}/${cleaned}`;

  if (!target.startsWith(`${base}/`)) {
    return err({ kind: 'escapes-output-directory', attempted: relative });
  }
  return ok(target);
};

export interface ResolvePathRequest {
  readonly outputDirectory: string;
  readonly template: string;
  readonly assetUrl: string;
  readonly pageUrl: string;
  readonly kind: string;
  readonly sha256: string;
  readonly contentType: string | null;
  readonly index: number;
  readonly now: Date;
}

export const resolveOutputPath = (request: ResolvePathRequest): Result<string, PathError> => {
  let host = 'unknown-host';
  try {
    host = new URL(request.assetUrl).host;
  } catch {
    // Falls through to the placeholder.
  }

  const relative = renderTemplate(request.template, {
    host,
    pagePath: pagePathOf(request.pageUrl),
    type: request.kind,
    name: nameOf(request.assetUrl),
    hash8: request.sha256.slice(0, 8),
    ext: extensionFor(request.assetUrl, request.contentType),
    index: request.index,
    date: request.now.toISOString().slice(0, 10),
  });

  return safeJoin(request.outputDirectory, relative);
};
