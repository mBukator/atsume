import { z } from 'zod';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type JobId = Brand<string, 'JobId'>;
export type PageId = Brand<string, 'PageId'>;
export type AssetId = Brand<string, 'AssetId'>;

const JOB_PREFIX = 'job_';
const PAGE_PREFIX = 'pg_';
const ASSET_PREFIX = 'as_';

const brandedId = <T extends string>(prefix: string, label: string): z.ZodType<T> =>
  z.custom<T>(
    (value) => typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length,
    `expected a ${label}`,
  );

export const jobIdSchema = brandedId<JobId>(JOB_PREFIX, 'JobId');
export const pageIdSchema = brandedId<PageId>(PAGE_PREFIX, 'PageId');
export const assetIdSchema = brandedId<AssetId>(ASSET_PREFIX, 'AssetId');

export const ID_PREFIXES = {
  job: JOB_PREFIX,
  page: PAGE_PREFIX,
  asset: ASSET_PREFIX,
} as const;
