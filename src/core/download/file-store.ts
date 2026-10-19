import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { err, ok, type Result, unit } from '../result';

export type FsError =
  | { readonly kind: 'not-found'; readonly path: string }
  | { readonly kind: 'permission'; readonly path: string }
  | { readonly kind: 'io'; readonly path: string; readonly message: string };

export interface WriteHandle {
  write(chunk: Uint8Array): Promise<Result<null, FsError>>;
  close(): Promise<void>;
}

/**
 * A port, so the downloader's tests never touch a real disk and a partial
 * write can be simulated exactly.
 */
export interface FileStore {
  sizeOf(path: string): Promise<number | null>;
  read(path: string): AsyncIterable<Uint8Array>;
  openWrite(path: string, mode: 'create' | 'append'): Promise<Result<WriteHandle, FsError>>;
  move(from: string, to: string): Promise<Result<null, FsError>>;
  remove(path: string): Promise<void>;
}

const toFsError = (path: string, cause: unknown): FsError => {
  const code = (cause as { code?: string } | null)?.code;
  if (code === 'ENOENT') return { kind: 'not-found', path };
  if (code === 'EACCES' || code === 'EPERM') return { kind: 'permission', path };
  return { kind: 'io', path, message: cause instanceof Error ? cause.message : 'unknown' };
};

export class NodeFileStore implements FileStore {
  async sizeOf(path: string): Promise<number | null> {
    try {
      const info = await stat(path);
      return info.isFile() ? info.size : null;
    } catch {
      return null;
    }
  }

  read(path: string): AsyncIterable<Uint8Array> {
    return createReadStream(path);
  }

  async openWrite(path: string, mode: 'create' | 'append'): Promise<Result<WriteHandle, FsError>> {
    try {
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(path, mode === 'append' ? 'a' : 'w');

      return ok({
        async write(chunk) {
          try {
            await handle.write(chunk);
            return unit;
          } catch (cause) {
            return err(toFsError(path, cause));
          }
        },
        async close() {
          await handle.close().catch(() => undefined);
        },
      });
    } catch (cause) {
      return err(toFsError(path, cause));
    }
  }

  async move(from: string, to: string): Promise<Result<null, FsError>> {
    try {
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      return unit;
    } catch (cause) {
      return err(toFsError(to, cause));
    }
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

/** Downloads land here first, so a killed process never leaves a truncated file. */
export const partialPathFor = (finalPath: string): string => `${finalPath}.part`;
