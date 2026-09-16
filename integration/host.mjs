import { execFile } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { queuedHost } from '../hooks/host.ts';
export const host = queuedHost({
  run: async (argv, options = {}) => {
    try {
      const child = execFile(argv[0], argv.slice(1), { cwd: options.cwd, env: { ...process.env, ...options.env }, timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, () => {});
      let inputError;
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') inputError = error; });
      const result = new Promise(resolve => {
        let stdout = '', stderr = '';
        child.stdout.on('data', c => stdout += c);
        child.stderr.on('data', c => stderr += c);
        child.on('error', e => resolve({ exitCode: 1, stdout, stderr: stderr + e.message }));
        child.on('close', code => resolve({ exitCode: inputError ? 1 : code ?? 1, stdout, stderr: stderr + (inputError?.message ?? '') }));
      });
      child.stdin.end(options.stdin);
      return await result;
    } catch (e) { return { exitCode: 1, stdout: '', stderr: e.message }; }
  },
  read: path => readFile(path, 'utf8'),
  exists: async path => { try { await access(path); return true; } catch { return false; } },
});
