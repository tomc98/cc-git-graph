export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface ReadHost {
  run(argv: readonly string[], options?: ProcessOptions): Promise<ProcessResult>;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

export class ReadQueue {
  private active = 0;
  private pending: (() => void)[] = [];

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= 2) await new Promise<void>(resolve => this.pending.push(resolve));
    else this.active++;
    try {
      return await work();
    } finally {
      const next = this.pending.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export function queuedHost(host: ReadHost, queue = new ReadQueue()): ReadHost {
  return { ...host, run: (argv, options) => queue.run(() => host.run(argv, options)) };
}

export const readEnvironment = {
  GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
  GIT_PAGER: 'cat', LC_ALL: 'C',
};

export async function git(host: ReadHost, cwd: string, args: readonly string[], timeoutMs = 5000, stdin?: string) {
  return host.run(['git', '--no-pager', '-c', 'core.fsmonitor=false', '--literal-pathspecs', ...args],
    { cwd, env: readEnvironment, timeoutMs, ...(stdin === undefined ? {} : { stdin }) });
}

export function requireSuccess(result: ProcessResult, operation: string): string {
  if (result.exitCode !== 0) throw new Error(`${operation}: ${result.stderr || result.stdout || `Git exited ${result.exitCode}`}`);
  return result.stdout;
}

export function lineValue(text: string): string {
  if (!text.endsWith('\n')) throw new Error('Incomplete Git response. Refresh to retry.');
  return text.slice(0, -1);
}
