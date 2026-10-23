import type { JobConfig } from '../config';
import type { FileStore } from '../download/file-store';
import { safeJoin } from '../download/paths';
import type { JobId } from '../ids';
import type { Asset } from '../media';
import { knownBytes, knownDimensions } from '../media';
import { err, ok, type Result } from '../result';

export interface ManifestEntry {
  readonly assetUrl: string;
  /** Every page it was found on, not just the first. */
  readonly sourcePages: readonly string[];
  readonly extractors: readonly string[];
  readonly altText: string | null;
  readonly kind: string;
  readonly acquisition: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly bytes: number | null;
  readonly contentHash: string | null;
  readonly localPath: string | null;
  readonly status: string;
  readonly detail: string | null;
}

export interface Manifest {
  readonly version: 1;
  readonly jobId: JobId;
  readonly seedUrl: string;
  readonly generatedAt: string;
  readonly counts: {
    readonly total: number;
    readonly downloaded: number;
    readonly skippedDuplicate: number;
    readonly filteredOut: number;
    readonly failed: number;
    readonly pending: number;
  };
  readonly entries: readonly ManifestEntry[];
}

const describeStatus = (asset: Asset): { status: string; detail: string | null } => {
  if (asset.filter.verdict === 'excluded') {
    return { status: 'filtered-out', detail: asset.filter.reason };
  }
  switch (asset.download.status) {
    case 'complete':
      return { status: 'downloaded', detail: null };
    case 'skipped-duplicate':
      return { status: 'skipped-duplicate', detail: `same content as ${asset.download.duplicateOf}` };
    case 'failed':
      return { status: 'failed', detail: describeDownloadError(asset.download.error) };
    case 'in-progress':
      return { status: 'interrupted', detail: `${asset.download.bytesDownloaded} bytes written` };
    case 'pending':
      return { status: asset.selected ? 'pending' : 'not-selected', detail: null };
  }
};

const describeDownloadError = (error: Asset['download'] extends never ? never : DownloadErrorLike): string => {
  switch (error.kind) {
    case 'http':
      return `HTTP ${error.status}`;
    case 'network':
      return error.message;
    case 'timeout':
      return `timed out after ${error.afterMs}ms`;
    case 'too-large':
      return `exceeded ${error.limitBytes} bytes`;
    case 'filesystem':
      return error.message;
    case 'subprocess':
      return `${error.tool}: ${error.stderr}`;
    case 'cancelled':
      return 'cancelled';
  }
};

type DownloadErrorLike = Extract<Asset['download'], { status: 'failed' }>['error'];

export const buildManifest = (
  jobId: JobId,
  config: JobConfig,
  assets: readonly Asset[],
  generatedAt: Date,
): Manifest => {
  const entries: ManifestEntry[] = [];
  const counts = {
    total: assets.length,
    downloaded: 0,
    skippedDuplicate: 0,
    filteredOut: 0,
    failed: 0,
    pending: 0,
  };

  for (const asset of assets) {
    const { status, detail } = describeStatus(asset);
    if (status === 'downloaded') counts.downloaded += 1;
    else if (status === 'skipped-duplicate') counts.skippedDuplicate += 1;
    else if (status === 'filtered-out') counts.filteredOut += 1;
    else if (status === 'failed') counts.failed += 1;
    else counts.pending += 1;

    const { width, height } = knownDimensions(asset);

    entries.push({
      assetUrl: asset.url,
      sourcePages: [...new Set(asset.sources.map((source) => source.pageUrl))],
      extractors: [...new Set(asset.sources.map((source) => source.extractor))],
      altText: asset.hints.alt,
      kind: asset.kind,
      acquisition: asset.acquisition.strategy,
      width,
      height,
      bytes: knownBytes(asset),
      contentHash:
        asset.download.status === 'complete' || asset.download.status === 'skipped-duplicate'
          ? asset.download.sha256
          : null,
      localPath:
        asset.download.status === 'complete' || asset.download.status === 'skipped-duplicate'
          ? asset.download.localPath
          : null,
      status,
      detail,
    });
  }

  return {
    version: 1,
    jobId,
    seedUrl: config.seedUrl,
    generatedAt: generatedAt.toISOString(),
    counts,
    entries,
  };
};

export type ManifestError =
  | { readonly kind: 'unsafe-path'; readonly filename: string }
  | { readonly kind: 'write-failed'; readonly message: string };

export const writeManifest = async (
  files: FileStore,
  config: JobConfig,
  manifest: Manifest,
): Promise<Result<string, ManifestError>> => {
  const target = safeJoin(config.output.directory, config.output.manifestFilename);
  if (!target.ok) return err({ kind: 'unsafe-path', filename: config.output.manifestFilename });

  const handle = await files.openWrite(target.value, 'create');
  if (!handle.ok) return err({ kind: 'write-failed', message: handle.error.kind });

  const written = await handle.value.write(
    new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  );
  await handle.value.close();

  if (!written.ok) return err({ kind: 'write-failed', message: written.error.kind });
  return ok(target.value);
};
