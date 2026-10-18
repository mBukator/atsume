/**
 * `srcset` cannot be split on commas: URLs may contain them, and descriptors
 * are separated from URLs by whitespace, not punctuation. This follows the
 * HTML spec's scan — read a URL as a run of non-whitespace, then read its
 * descriptor up to the next comma.
 */

export interface SrcsetEntry {
  readonly url: string;
  readonly descriptor: string | null;
  /** `1200w` -> 1200 */
  readonly width: number | null;
  /** `2x` -> 2 */
  readonly density: number | null;
}

const isWhitespace = (char: string): boolean => /\s/.test(char);

const readDescriptorValue = (descriptor: string | null): Pick<SrcsetEntry, 'width' | 'density'> => {
  if (descriptor === null) return { width: null, density: null };
  const trimmed = descriptor.trim();

  const widthMatch = /^(\d+)w$/.exec(trimmed);
  if (widthMatch?.[1] !== undefined) return { width: Number(widthMatch[1]), density: null };

  const densityMatch = /^(\d*\.?\d+)x$/.exec(trimmed);
  if (densityMatch?.[1] !== undefined) return { width: null, density: Number(densityMatch[1]) };

  return { width: null, density: null };
};

export const parseSrcset = (value: string): SrcsetEntry[] => {
  const entries: SrcsetEntry[] = [];
  let position = 0;

  while (position < value.length) {
    while (position < value.length) {
      const char = value[position];
      if (char === undefined) break;
      if (!isWhitespace(char) && char !== ',') break;
      position += 1;
    }
    if (position >= value.length) break;

    const urlStart = position;
    while (position < value.length) {
      const char = value[position];
      if (char === undefined || isWhitespace(char)) break;
      position += 1;
    }
    let url = value.slice(urlStart, position);

    // A URL ending in commas carries no descriptor: `a.jpg, b.jpg 2x`.
    let descriptor: string | null = null;
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      while (position < value.length) {
        const char = value[position];
        if (char === undefined || !isWhitespace(char)) break;
        position += 1;
      }
      const descriptorStart = position;
      while (position < value.length && value[position] !== ',') position += 1;
      const raw = value.slice(descriptorStart, position).trim();
      descriptor = raw === '' ? null : raw;
      position += 1;
    }

    if (url !== '') entries.push({ url, descriptor, ...readDescriptorValue(descriptor) });
  }

  return entries;
};

/**
 * Picks the largest variant, not the first. `w` beats `x` when both appear,
 * because a width descriptor states the real pixel width of the file while a
 * density descriptor only states its intended display scale.
 */
export const pickLargestVariant = (entries: readonly SrcsetEntry[]): SrcsetEntry | null => {
  if (entries.length === 0) return null;

  const byWidth = entries.filter((entry) => entry.width !== null);
  if (byWidth.length > 0) {
    return byWidth.reduce((best, entry) => ((entry.width ?? 0) > (best.width ?? 0) ? entry : best));
  }

  const byDensity = entries.filter((entry) => entry.density !== null);
  if (byDensity.length > 0) {
    return byDensity.reduce((best, entry) =>
      (entry.density ?? 0) > (best.density ?? 0) ? entry : best,
    );
  }

  return entries[0] ?? null;
};
