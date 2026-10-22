import type { ToolOptions } from '../config';

/** Marks the lines this tool asks yt-dlp to print, so they are unambiguous. */
export const PROGRESS_PREFIX = 'MPPROGRESS';
export const FILEPATH_PREFIX = 'MPFILE';

export interface YtDlpRequest {
  readonly url: string;
  /** Absolute path with no extension; yt-dlp appends the real container. */
  readonly outputBase: string;
  readonly strategy: 'hls' | 'embed';
  readonly userAgent: string;
  readonly tools: ToolOptions;
  readonly maxFilesizeBytes: number | null;
}

/**
 * Every flag here is either about correctness (which stream to take, where to
 * put it, how to report progress) or about being a lighter load on the server.
 * There is nothing for evading rate limits, bot detection, or paywalls, and
 * that is a deliberate omission rather than an oversight.
 */
export const buildYtDlpArgs = (request: YtDlpRequest): string[] => {
  const args: string[] = [
    '--no-colors',
    '--newline',
    '--no-playlist',
    '--no-warnings',
    // A partial file left behind is resumable on the next run.
    '--continue',
    '--no-overwrites',
    '--user-agent',
    request.userAgent,
    '--socket-timeout',
    String(request.tools.socketTimeoutSeconds),
    '--retries',
    String(request.tools.retries),
    '--ffmpeg-location',
    request.tools.ffmpegPath,
    '--merge-output-format',
    request.tools.mergeFormat,
    '--output',
    `${request.outputBase}.%(ext)s`,
    // Machine-readable progress on stdout, one line at a time.
    '--progress-template',
    [
      `${PROGRESS_PREFIX}`,
      '%(progress.status)s',
      '%(progress.downloaded_bytes)s',
      '%(progress.total_bytes)s',
      '%(progress.total_bytes_estimate)s',
    ].join('|'),
    // The only reliable way to learn where the file actually landed.
    '--print',
    `after_move:${FILEPATH_PREFIX}|%(filepath)s`,
    '--no-simulate',
  ];

  if (request.tools.limitRateBytesPerSecond !== null) {
    args.push('--limit-rate', String(request.tools.limitRateBytesPerSecond));
  }
  if (request.maxFilesizeBytes !== null) {
    args.push('--max-filesize', String(request.maxFilesizeBytes));
  }

  // An HLS manifest is a list of segments; hand it to the native downloader and
  // let ffmpeg remux the result rather than treating it as one file.
  if (request.strategy === 'hls') {
    args.push('--hls-use-mpegts', '--downloader', 'ffmpeg');
  }

  args.push('--', request.url);
  return args;
};

export interface YtDlpProgress {
  readonly status: string;
  readonly downloadedBytes: number | null;
  readonly totalBytes: number | null;
}

/** yt-dlp prints `NA` for fields it does not know yet. */
const numberOrNull = (raw: string | undefined): number | null => {
  if (raw === undefined || raw === '' || raw === 'NA') return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

export const parseProgressLine = (line: string): YtDlpProgress | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith(`${PROGRESS_PREFIX}|`)) return null;

  const parts = trimmed.split('|');
  const status = parts[1];
  if (status === undefined || status === '') return null;

  return {
    status,
    downloadedBytes: numberOrNull(parts[2]),
    // Fall back to the estimate: a live HLS stream never reports a real total.
    totalBytes: numberOrNull(parts[3]) ?? numberOrNull(parts[4]),
  };
};

export const parseFilepathLine = (line: string): string | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith(`${FILEPATH_PREFIX}|`)) return null;
  const path = trimmed.slice(FILEPATH_PREFIX.length + 1).trim();
  return path === '' ? null : path;
};

export interface YtDlpFailure {
  readonly reason:
    | 'not-installed'
    | 'ffmpeg-missing'
    | 'unsupported-url'
    | 'unavailable'
    | 'geo-blocked'
    | 'requires-authentication'
    | 'too-large'
    | 'unknown';
  readonly detail: string;
}

const STDERR_PATTERNS: readonly { readonly test: RegExp; readonly reason: YtDlpFailure['reason'] }[] =
  [
    { test: /ffmpeg (?:is )?not (?:installed|found)|ffprobe/i, reason: 'ffmpeg-missing' },
    { test: /unsupported url|no suitable extractor/i, reason: 'unsupported-url' },
    { test: /video unavailable|has been removed|no longer available|404/i, reason: 'unavailable' },
    { test: /not available in your country|geo.?restricted/i, reason: 'geo-blocked' },
    {
      test: /sign in|login required|private video|members[- ]only|subscribe to|paid|purchase/i,
      reason: 'requires-authentication',
    },
    { test: /file is larger than max-filesize/i, reason: 'too-large' },
  ];

/**
 * `requires-authentication` is reported and then left alone. Getting past it
 * would mean supplying someone else's credentials, which is out of scope.
 */
export const classifyFailure = (stderr: string): YtDlpFailure => {
  const detail = lastMeaningfulLine(stderr);
  for (const pattern of STDERR_PATTERNS) {
    if (pattern.test.test(stderr)) return { reason: pattern.reason, detail };
  }
  return { reason: 'unknown', detail };
};

const lastMeaningfulLine = (stderr: string): string => {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.at(-1) ?? 'no error output';
};

/** Whether a second attempt could plausibly succeed. */
export const isRetryableFailure = (failure: YtDlpFailure): boolean =>
  failure.reason === 'unknown';
