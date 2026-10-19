import { createHash } from 'node:crypto';
import type { FileStore } from './file-store';

export interface FileDigest {
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * Streams the file rather than reading it whole: yt-dlp output can be
 * gigabytes, and the only thing needed from it is a digest and a byte count.
 */
export const hashFile = async (files: FileStore, path: string): Promise<FileDigest | null> => {
  if ((await files.sizeOf(path)) === null) return null;

  const hash = createHash('sha256');
  let bytes = 0;

  try {
    for await (const chunk of files.read(path)) {
      hash.update(chunk);
      bytes += chunk.byteLength;
    }
  } catch {
    return null;
  }

  return { sha256: hash.digest('hex'), bytes };
};
