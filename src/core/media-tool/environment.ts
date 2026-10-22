import { existsSync } from 'node:fs';
import type { ToolOptions } from '../config';
import type { SubprocessRunner } from './subprocess';

export interface ToolReport {
  readonly available: boolean;
  readonly version: string | null;
  readonly path: string;
  readonly detail: string | null;
}

export interface EnvironmentReport {
  readonly ytDlp: ToolReport;
  readonly ffmpeg: ToolReport;
  readonly chromium: ToolReport;
}

const firstLine = (text: string): string | null => {
  const line = text.split(/\r?\n/).find((entry) => entry.trim() !== '');
  return line?.trim() ?? null;
};

/**
 * Deliberately not the cached availability check the downloader uses: this is
 * asked when someone wants to know whether their setup is right, and a stale
 * "no" from before they fixed their PATH would be worse than useless.
 */
const probeVersion = async (
  subprocess: SubprocessRunner,
  path: string,
  args: readonly string[],
  hint: string,
): Promise<ToolReport> => {
  const result = await subprocess.run(path, args, { timeoutMs: 10_000 });

  if (!result.ok) {
    return {
      available: false,
      version: null,
      path,
      detail: result.error.kind === 'not-found' ? hint : `could not run ${path}`,
    };
  }
  if (result.value.exitCode !== 0) {
    return { available: false, version: null, path, detail: firstLine(result.value.stderr) ?? hint };
  }

  return {
    available: true,
    version: firstLine(result.value.stdout),
    path,
    detail: null,
  };
};

const PATH_HINT =
  'not found on PATH — add its folder to PATH, or set tools.ytDlpPath to the full path';

const FFMPEG_HINT =
  'not found on PATH — required to remux HLS streams and merge separate audio and video';

/**
 * Chromium is checked by looking for the binary rather than launching it:
 * starting a browser to answer "is a browser installed" costs a second.
 */
const probeChromium = async (): Promise<ToolReport> => {
  try {
    const { chromium } = await import('playwright');
    const path = chromium.executablePath();
    return existsSync(path)
      ? { available: true, version: null, path, detail: null }
      : {
          available: false,
          version: null,
          path,
          detail: 'run npx playwright install chromium',
        };
  } catch (cause) {
    return {
      available: false,
      version: null,
      path: 'playwright',
      detail: cause instanceof Error ? cause.message : 'playwright is not installed',
    };
  }
};

export const probeEnvironment = async (
  subprocess: SubprocessRunner,
  tools: ToolOptions,
): Promise<EnvironmentReport> => {
  const [ytDlp, ffmpeg, chromium] = await Promise.all([
    probeVersion(subprocess, tools.ytDlpPath, ['--version'], PATH_HINT),
    probeVersion(subprocess, tools.ffmpegPath, ['-version'], FFMPEG_HINT),
    probeChromium(),
  ]);

  return { ytDlp, ffmpeg, chromium };
};

/** What each missing tool actually costs you, in the user's terms. */
export const describeGaps = (report: EnvironmentReport): string[] => {
  const gaps: string[] = [];
  if (!report.chromium.available) {
    gaps.push('Pages that build themselves with JavaScript will look empty.');
  }
  if (!report.ytDlp.available) {
    gaps.push('Streams and YouTube/Vimeo embeds cannot be fetched.');
  } else if (!report.ffmpeg.available) {
    gaps.push('HLS streams cannot be remuxed without ffmpeg.');
  }
  return gaps;
};
