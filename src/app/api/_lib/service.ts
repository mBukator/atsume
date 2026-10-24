import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { systemClock } from '@/core/clock';
import { openDatabase } from '@/core/db/open';
import { NodeFileStore } from '@/core/download/file-store';
import { NodeSubprocessRunner } from '@/core/media-tool/subprocess';
import { fetchHttpClient } from '@/core/net/http';
import { JobService } from '@/core/orchestrator/job-service';
import { PlaywrightRenderer } from '@/core/render/playwright';

const DEFAULT_DB_PATH = resolve(process.cwd(), '.atsume/jobs.db');

/**
 * Next.js reloads modules in development, which would otherwise mean a fresh
 * database handle, a fresh event bus, and orphaned background work on every
 * edit. The instance is parked on `globalThis` so it survives that.
 */
const GLOBAL_KEY = Symbol.for('atsume.job-service');

interface GlobalWithService {
  [GLOBAL_KEY]?: JobService;
}

const createService = (): JobService => {
  const path = process.env['ATSUME_DB'] ?? DEFAULT_DB_PATH;
  mkdirSync(dirname(path), { recursive: true });

  const service = new JobService({
    db: openDatabase(path),
    http: fetchHttpClient,
    clock: systemClock,
    files: new NodeFileStore(),
    renderer: new PlaywrightRenderer(),
    subprocess: new NodeSubprocessRunner(),
  });

  // Anything the database still believes is running belongs to a process that
  // is gone. Park it as paused so the user decides whether to continue.
  const recovered = service.recoverInterrupted();
  if (recovered.length > 0) {
    console.info(`[atsume] parked ${recovered.length} interrupted job(s) as paused`);
  }

  return service;
};

export const getJobService = (): JobService => {
  const container = globalThis as GlobalWithService;
  container[GLOBAL_KEY] ??= createService();
  return container[GLOBAL_KEY];
};
