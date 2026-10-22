import { describe, expect, it } from 'vitest';
import { toolOptionsSchema } from '../config';
import { FakeSubprocessRunner } from '../testing';
import { describeGaps, probeEnvironment } from './environment';

const tools = toolOptionsSchema.parse({});

const runner = (
  route: (command: string, args: readonly string[]) => Parameters<typeof Object>[0] extends never
    ? never
    : { exitCode?: number; stdout?: readonly string[]; error?: { kind: 'not-found'; command: string } },
) => new FakeSubprocessRunner(route as never);

describe('probeEnvironment', () => {
  it('reports a working binary with its version', async () => {
    const report = await probeEnvironment(
      runner(() => ({ exitCode: 0, stdout: ['2026.07.04'] })),
      tools,
    );

    expect(report.ytDlp).toMatchObject({ available: true, version: '2026.07.04' });
  });

  it('explains a binary that is installed but not on PATH', async () => {
    const report = await probeEnvironment(
      runner((command) =>
        command === 'yt-dlp'
          ? { error: { kind: 'not-found' as const, command } }
          : { exitCode: 0, stdout: ['ok'] },
      ),
      tools,
    );

    expect(report.ytDlp.available).toBe(false);
    expect(report.ytDlp.detail).toContain('PATH');
  });

  it('honours an overridden binary path', async () => {
    const custom = toolOptionsSchema.parse({ ytDlpPath: 'C:\\tools\\yt-dlp.exe' });
    const report = await probeEnvironment(runner(() => ({ exitCode: 0, stdout: ['x'] })), custom);

    expect(report.ytDlp.path).toBe('C:\\tools\\yt-dlp.exe');
  });
});

describe('describeGaps', () => {
  const ok = { available: true, version: null, path: 'x', detail: null };
  const missing = { available: false, version: null, path: 'x', detail: null };

  it('says nothing when everything is present', () => {
    expect(describeGaps({ ytDlp: ok, ffmpeg: ok, chromium: ok })).toEqual([]);
  });

  it('names what each gap costs', () => {
    const gaps = describeGaps({ ytDlp: missing, ffmpeg: missing, chromium: missing });
    expect(gaps.join(' ')).toContain('JavaScript');
    expect(gaps.join(' ')).toContain('embeds');
  });

  it('does not nag about ffmpeg when yt-dlp is missing anyway', () => {
    const gaps = describeGaps({ ytDlp: missing, ffmpeg: missing, chromium: ok });
    expect(gaps).toHaveLength(1);
  });

  it('flags ffmpeg on its own when yt-dlp is present', () => {
    const gaps = describeGaps({ ytDlp: ok, ffmpeg: missing, chromium: ok });
    expect(gaps.join(' ')).toContain('ffmpeg');
  });
});
