import { spawn } from 'node:child_process';
import { err, ok, type Result } from '../result';

export type SubprocessError =
  | { readonly kind: 'not-found'; readonly command: string }
  | { readonly kind: 'spawn-failed'; readonly command: string; readonly message: string }
  | { readonly kind: 'timeout'; readonly afterMs: number }
  | { readonly kind: 'cancelled' };

export interface SubprocessResult {
  /** Null when the process was killed by a signal rather than exiting. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  /** Called per line as output arrives, which is how progress streams live. */
  readonly onStdoutLine?: ((line: string) => void) | undefined;
  readonly onStderrLine?: ((line: string) => void) | undefined;
  readonly cwd?: string | undefined;
}

/**
 * A port. Arguments are always passed as an array and never through a shell,
 * so a URL containing shell metacharacters is an argument and nothing more.
 */
export interface SubprocessRunner {
  run(
    command: string,
    args: readonly string[],
    options: RunOptions,
  ): Promise<Result<SubprocessResult, SubprocessError>>;
}

/** Splits a byte stream into lines, holding an incomplete tail between chunks. */
class LineBuffer {
  private pending = '';

  constructor(private readonly emit: ((line: string) => void) | undefined) {}

  push(text: string): void {
    if (this.emit === undefined) return;
    this.pending += text;
    const lines = this.pending.split(/\r?\n|\r/);
    this.pending = lines.pop() ?? '';
    for (const line of lines) if (line !== '') this.emit(line);
  }

  flush(): void {
    if (this.emit !== undefined && this.pending !== '') this.emit(this.pending);
    this.pending = '';
  }
}

export class NodeSubprocessRunner implements SubprocessRunner {
  async run(
    command: string,
    args: readonly string[],
    options: RunOptions,
  ): Promise<Result<SubprocessResult, SubprocessError>> {
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, [...args], {
          // Never `shell: true`. Arguments include remote URLs.
          shell: false,
          cwd: options.cwd ?? process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (cause) {
        resolve(
          err({
            kind: 'spawn-failed',
            command,
            message: cause instanceof Error ? cause.message : 'could not spawn',
          }),
        );
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      const outLines = new LineBuffer(options.onStdoutLine);
      const errLines = new LineBuffer(options.onStderrLine);

      const finish = (result: Result<SubprocessResult, SubprocessError>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        outLines.flush();
        errLines.flush();
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(err({ kind: 'timeout', afterMs: options.timeoutMs }));
      }, options.timeoutMs);

      const onAbort = (): void => {
        child.kill('SIGTERM');
        finish(err({ kind: 'cancelled' }));
      };
      if (options.signal?.aborted === true) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
        outLines.push(chunk);
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
        errLines.push(chunk);
      });

      child.on('error', (cause: NodeJS.ErrnoException) => {
        finish(
          cause.code === 'ENOENT'
            ? err({ kind: 'not-found', command })
            : err({ kind: 'spawn-failed', command, message: cause.message }),
        );
      });

      child.on('close', (code, signal) => {
        finish(ok({ exitCode: code, signal, stdout, stderr }));
      });
    });
  }
}
