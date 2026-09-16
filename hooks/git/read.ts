import type { ReadHost } from '../host.ts';

export interface GitResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutComplete: boolean;
  stdoutTotalBytes: number;
  stdoutValidUtf8: boolean;
}

export type GitReader = (cwd: string, args: readonly string[], options?: { limit?: number; stdin?: string; timeout?: number }) => Promise<GitResponse>;

export function createGitReader(host: ReadHost, pluginRoot: string): GitReader {
  let sequence = 0;
  return async (cwd, args, options = {}) => {
    const request = String(++sequence);
    const result = await host.run(['/usr/bin/python3', pluginRoot + '/scripts/git-read.py'], {
      cwd, timeoutMs: ((options.timeout ?? 15) + 2) * 1000,
      stdin: JSON.stringify({ request, cwd, args, ...options }),
    });
    if (result.exitCode !== 0) throw new Error(`Git read helper failed: ${result.stderr || 'Python 3 is required on this macOS release.'}`);
    let value;
    try { value = JSON.parse(result.stdout); } catch { throw new Error('Incomplete read envelope from the Claude host. No result was accepted.'); }
    if (value.version !== 1 || value.request !== request || value.end !== 'cc-git-graph-read-v1'
      || typeof value.stdout !== 'string' || typeof value.stderr !== 'string' || !Number.isInteger(value.exitCode)
      || typeof value.stdoutComplete !== 'boolean' || typeof value.stdoutValidUtf8 !== 'boolean'
      || !Number.isInteger(value.stdoutBytes) || !Number.isInteger(value.stdoutTotalBytes)
      || value.stdoutBytes > value.stdoutTotalBytes || (value.stdoutComplete && value.stdoutBytes !== value.stdoutTotalBytes)) {
      throw new Error('Invalid Git read envelope. Refresh to retry.');
    }
    if (value.timedOut) throw new Error('Git read timed out. Refresh to retry.');
    return value as GitResponse;
  };
}

export function complete(response: GitResponse, operation: string): string {
  if (response.exitCode !== 0) throw new Error(`${operation}: ${response.stderr || `Git exited ${response.exitCode}`}`);
  if (!response.stdoutComplete || !response.stdoutValidUtf8) throw new Error(`${operation}: the result exceeds the read limit or contains unsupported non-UTF-8 text. Refine the selection.`);
  return response.stdout;
}
