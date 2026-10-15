import { createHash, randomUUID } from 'node:crypto';
import { type AssetId, ID_PREFIXES, type JobId, type PageId } from './ids';

/**
 * Id *generation* needs `node:crypto`, so it lives apart from the id *types*.
 * The browser imports the types and the zod schemas; pulling this file into a
 * client bundle would drag a Node built-in in with it.
 */

export const newJobId = (): JobId => `${ID_PREFIXES.job}${randomUUID()}` as JobId;

const digest = (jobId: string, normalizedUrl: string): string =>
  createHash('sha256').update(jobId).update('\u0000').update(normalizedUrl).digest('hex').slice(0, 24);

/**
 * Page and asset ids are derived, not random: the same (job, normalized URL)
 * always yields the same id. Rediscovering an asset on a second page is then a
 * primary-key conflict rather than a duplicate row, and discovery can be
 * re-run over a partially crawled job without inventing new records.
 */
export const derivePageId = (jobId: JobId, normalizedUrl: string): PageId =>
  `${ID_PREFIXES.page}${digest(jobId, normalizedUrl)}` as PageId;

export const deriveAssetId = (jobId: JobId, normalizedUrl: string): AssetId =>
  `${ID_PREFIXES.asset}${digest(jobId, normalizedUrl)}` as AssetId;
