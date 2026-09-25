import { spawn } from 'node:child_process';

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface CommandOptions {
  cwd: string;
  input?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

// Thin promise wrapper around spawn - never throws for a non-zero exit code, so callers
// decide whether a failure is an assertion failure or an expected outcome.
export function runCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const startedAt = Date.now();
  const printable = [command, ...args].join(' ');

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      stderr += error.message;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        command: printable,
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });

    if (child.stdin) {
      // A child that exits before reading its input must not crash the runner.
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.input);
    }
  });
}

// Terminal colour codes from npm/jest output would clutter reports.
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function tailLines(text: string, count: number): string[] {
  const lines = text
    .replace(ANSI_ESCAPE, '')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  return lines.slice(-count);
}
