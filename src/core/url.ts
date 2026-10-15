import { err, ok, type Result } from './result';

export type UrlError =
  | { readonly kind: 'unparseable'; readonly input: string }
  | { readonly kind: 'unsupported-scheme'; readonly scheme: string };

const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' };

export const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Resolve `input` against `base` and reduce it to a canonical form so that two
 * spellings of the same resource dedupe to one record.
 *
 * Deliberately conservative: it strips the fragment, lowercases scheme and
 * host, drops the default port, and sorts the query. It does NOT strip
 * tracking parameters or trailing slashes, because either can change what a
 * server returns. Milestone 2 layers an opt-in tracking-param list on top.
 */
export const normalizeUrl = (input: string, base?: string): Result<string, UrlError> => {
  let url: URL;
  try {
    url = base === undefined ? new URL(input) : new URL(input, base);
  } catch {
    return err({ kind: 'unparseable', input });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return err({ kind: 'unsupported-scheme', scheme: url.protocol });
  }

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (url.port === DEFAULT_PORTS[url.protocol]) url.port = '';

  const params = [...url.searchParams.entries()].sort(([aKey, aVal], [bKey, bVal]) =>
    aKey === bKey ? aVal.localeCompare(bVal) : aKey.localeCompare(bKey),
  );
  url.search = params.length === 0 ? '' : new URLSearchParams(params).toString();

  return ok(url.toString());
};

export const hostOf = (url: string): Result<string, UrlError> => {
  try {
    return ok(new URL(url).host.toLowerCase());
  } catch {
    return err({ kind: 'unparseable', input: url });
  }
};

/** Same registrable origin check used by the crawler's default scope rule. */
export const isSameOrigin = (a: string, b: string): boolean => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

/** Lowercased extension without the dot, or null when the path has none. */
export const extensionOf = (url: string): string | null => {
  try {
    const { pathname } = new URL(url);
    // A trailing slash is decoration on tokenised CDN paths: `/img/photo.jpg/`
    // names the same file as `/img/photo.jpg`. Walk back to the last segment
    // that has content rather than reading the empty string after the slash.
    const last = pathname.split('/').filter((segment) => segment !== '').pop() ?? '';
    const dot = last.lastIndexOf('.');
    if (dot <= 0 || dot === last.length - 1) return null;
    const ext = last.slice(dot + 1).toLowerCase();
    return /^[a-z0-9]{1,8}$/.test(ext) ? ext : null;
  } catch {
    return null;
  }
};
