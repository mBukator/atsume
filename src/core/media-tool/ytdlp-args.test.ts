import { describe, expect, it } from 'vitest';
import { toolOptionsSchema } from '../config';
import {
  buildYtDlpArgs,
  classifyFailure,
  FILEPATH_PREFIX,
  isRetryableFailure,
  parseFilepathLine,
  parseProgressLine,
  PROGRESS_PREFIX,
  type YtDlpRequest,
} from './ytdlp-args';

const tools = toolOptionsSchema.parse({});

const request = (overrides: Partial<YtDlpRequest> = {}): YtDlpRequest => ({
  url: 'https://cdn.test/live/index.m3u8',
  outputBase: '/downloads/cdn.test/video/stream-a1b2c3d4',
  strategy: 'hls',
  userAgent: 'Atsume/0.1',
  tools,
  maxFilesizeBytes: null,
  ...overrides,
});

const valueAfter = (args: readonly string[], flag: string): string | undefined =>
  args[args.indexOf(flag) + 1];

describe('buildYtDlpArgs', () => {
  it('lets yt-dlp choose the container by templating the extension', () => {
    const args = buildYtDlpArgs(request());
    expect(valueAfter(args, '--output')).toBe(
      '/downloads/cdn.test/video/stream-a1b2c3d4.%(ext)s',
    );
    expect(valueAfter(args, '--merge-output-format')).toBe('mp4');
  });

  it('passes the URL after -- so a leading dash cannot become a flag', () => {
    const args = buildYtDlpArgs(request({ url: 'https://cdn.test/--weird.m3u8' }));
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe('https://cdn.test/--weird.m3u8');
  });

  it('uses ffmpeg for HLS but not for a provider embed', () => {
    expect(buildYtDlpArgs(request({ strategy: 'hls' }))).toContain('--hls-use-mpegts');
    expect(buildYtDlpArgs(request({ strategy: 'embed' }))).not.toContain('--hls-use-mpegts');
  });

  it('asks for machine-readable progress and the final filepath', () => {
    const args = buildYtDlpArgs(request());
    expect(valueAfter(args, '--progress-template')).toContain(PROGRESS_PREFIX);
    expect(valueAfter(args, '--print')).toBe(`after_move:${FILEPATH_PREFIX}|%(filepath)s`);
    expect(args).toContain('--newline');
  });

  it('forwards our own rate ceiling and size limit only when set', () => {
    expect(buildYtDlpArgs(request())).not.toContain('--limit-rate');
    expect(buildYtDlpArgs(request())).not.toContain('--max-filesize');

    const limited = buildYtDlpArgs(
      request({
        tools: toolOptionsSchema.parse({ limitRateBytesPerSecond: 500_000 }),
        maxFilesizeBytes: 1_000_000,
      }),
    );
    expect(valueAfter(limited, '--limit-rate')).toBe('500000');
    expect(valueAfter(limited, '--max-filesize')).toBe('1000000');
  });

  it('resumes rather than restarting a partial file', () => {
    expect(buildYtDlpArgs(request())).toContain('--continue');
  });

  it('carries no flags for evading rate limits, bot detection or paywalls', () => {
    const args = buildYtDlpArgs(request({ strategy: 'embed' })).join(' ');
    for (const forbidden of [
      '--cookies',
      '--cookies-from-browser',
      '--proxy',
      '--geo-bypass',
      '--username',
      '--password',
      '--netrc',
      '--impersonate',
      '--sleep-interval', // would be masking our request pattern, not slowing it
      '--extractor-args',
    ]) {
      expect(args).not.toContain(forbidden);
    }
  });
});

describe('parseProgressLine', () => {
  it('reads a full progress line', () => {
    expect(parseProgressLine(`${PROGRESS_PREFIX}|downloading|1024|4096|4096`)).toEqual({
      status: 'downloading',
      downloadedBytes: 1_024,
      totalBytes: 4_096,
    });
  });

  it('falls back to the estimate when the real total is unknown', () => {
    expect(parseProgressLine(`${PROGRESS_PREFIX}|downloading|512|NA|9000`)?.totalBytes).toBe(9_000);
  });

  it('reports a null total when neither is known, as with a live stream', () => {
    expect(parseProgressLine(`${PROGRESS_PREFIX}|downloading|512|NA|NA`)?.totalBytes).toBeNull();
  });

  it('reads the finished line', () => {
    expect(parseProgressLine(`${PROGRESS_PREFIX}|finished|4096|4096|4096`)?.status).toBe('finished');
  });

  it('ignores yt-dlp chatter that is not a progress line', () => {
    expect(parseProgressLine('[download] Destination: video.mp4')).toBeNull();
    expect(parseProgressLine('')).toBeNull();
    expect(parseProgressLine(`${PROGRESS_PREFIX}|`)).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseProgressLine(`  ${PROGRESS_PREFIX}|downloading|1|2|2  `)?.downloadedBytes).toBe(1);
  });
});

describe('parseFilepathLine', () => {
  it('reads the path yt-dlp reports after the move', () => {
    expect(parseFilepathLine(`${FILEPATH_PREFIX}|/downloads/a/b/clip.mp4`)).toBe(
      '/downloads/a/b/clip.mp4',
    );
  });

  it('handles a path containing spaces', () => {
    expect(parseFilepathLine(`${FILEPATH_PREFIX}|/downloads/my videos/clip.mp4`)).toBe(
      '/downloads/my videos/clip.mp4',
    );
  });

  it('ignores other lines and empty paths', () => {
    expect(parseFilepathLine('[download] 100%')).toBeNull();
    expect(parseFilepathLine(`${FILEPATH_PREFIX}|`)).toBeNull();
  });
});

describe('classifyFailure', () => {
  it.each([
    ['ERROR: ffmpeg is not installed', 'ffmpeg-missing'],
    ['ERROR: Unsupported URL: https://a.test/x', 'unsupported-url'],
    ['ERROR: Video unavailable', 'unavailable'],
    ['ERROR: This video is not available in your country', 'geo-blocked'],
    ['ERROR: Sign in to confirm your age', 'requires-authentication'],
    ['ERROR: Private video. Sign in if you have been granted access', 'requires-authentication'],
    ['ERROR: File is larger than max-filesize', 'too-large'],
  ] as const)('maps %s', (stderr, reason) => {
    expect(classifyFailure(stderr).reason).toBe(reason);
  });

  it('falls back to unknown and keeps the last meaningful line', () => {
    const failure = classifyFailure('warming up\n\nERROR: something odd happened\n');
    expect(failure).toEqual({ reason: 'unknown', detail: 'ERROR: something odd happened' });
  });

  it('copes with empty stderr', () => {
    expect(classifyFailure('')).toEqual({ reason: 'unknown', detail: 'no error output' });
  });

  it('only retries failures whose cause is unclear', () => {
    expect(isRetryableFailure({ reason: 'unknown', detail: '' })).toBe(true);
    // Retrying these would just repeat the same request against the same wall.
    expect(isRetryableFailure({ reason: 'requires-authentication', detail: '' })).toBe(false);
    expect(isRetryableFailure({ reason: 'geo-blocked', detail: '' })).toBe(false);
    expect(isRetryableFailure({ reason: 'unavailable', detail: '' })).toBe(false);
  });
});
