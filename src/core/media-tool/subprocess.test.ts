import { describe, expect, it } from 'vitest';
import { NodeSubprocessRunner } from './subprocess';

const runner = new NodeSubprocessRunner();
const node = process.execPath;

/** Runs real processes, but only ones already on this machine. */
const script = (source: string): string[] => ['-e', source];

describe('NodeSubprocessRunner', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const result = await runner.run(
      node,
      script('console.log("out"); console.error("err"); process.exit(3)'),
      { timeoutMs: 10_000 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exitCode).toBe(3);
    expect(result.value.stdout.trim()).toBe('out');
    expect(result.value.stderr.trim()).toBe('err');
  });

  it('streams stdout one line at a time as it arrives', async () => {
    const lines: string[] = [];
    await runner.run(node, script('for (let i = 0; i < 4; i++) console.log("line " + i)'), {
      timeoutMs: 10_000,
      onStdoutLine: (line) => lines.push(line),
    });

    expect(lines).toEqual(['line 0', 'line 1', 'line 2', 'line 3']);
  });

  it('reassembles a line split across two chunks', async () => {
    const lines: string[] = [];
    await runner.run(
      node,
      script('process.stdout.write("half"); setTimeout(() => process.stdout.write("-whole\\n"), 30)'),
      { timeoutMs: 10_000, onStdoutLine: (line) => lines.push(line) },
    );

    expect(lines).toEqual(['half-whole']);
  });

  it('emits a trailing line that never got a newline', async () => {
    const lines: string[] = [];
    await runner.run(node, script('process.stdout.write("no newline here")'), {
      timeoutMs: 10_000,
      onStdoutLine: (line) => lines.push(line),
    });

    expect(lines).toEqual(['no newline here']);
  });

  it('reports a missing binary as not-found rather than throwing', async () => {
    const result = await runner.run('definitely-not-a-real-binary-9182', [], { timeoutMs: 5_000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
  });

  it('kills a process that outruns its timeout', async () => {
    const result = await runner.run(node, script('setTimeout(() => {}, 60000)'), {
      timeoutMs: 150,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: 'timeout', afterMs: 150 });
  });

  it('stops a running process when the signal aborts', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await runner.run(node, script('setTimeout(() => {}, 60000)'), {
      timeoutMs: 30_000,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('cancelled');
  });

  it('returns immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runner.run(node, script('console.log("should not matter")'), {
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
  });

  it('passes arguments without a shell, so metacharacters stay literal', async () => {
    const result = await runner.run(node, ['-e', 'console.log(process.argv[1])', '; rm -rf /'], {
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stdout.trim()).toBe('; rm -rf /');
  });
});
