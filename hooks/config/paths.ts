import type { ReadHost } from '../host.ts';

export function normalizePath(value: string, home: string, configured = true): string {
  const path = value.startsWith('~/') ? `${home}/${value.slice(2)}` : value;
  if (!path.startsWith('/') || path.includes('\0')) throw new Error('Use an absolute directory path or a ~/ path.');
  if (configured && /\$|\*|\?|\[|\]/.test(path)) throw new Error('Environment substitutions and glob patterns are not supported in configured paths.');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return '/' + parts.join('/');
}

export function containsPath(parent: string, child: string, descendants: boolean): boolean {
  return parent === child || (descendants && child.startsWith(parent === '/' ? '/' : parent + '/'));
}

export async function canonicalPath(host: ReadHost, path: string): Promise<string> {
  let existing = path;
  const tail: string[] = [];
  while (!(await host.exists(existing)) && existing !== '/') {
    const index = existing.lastIndexOf('/');
    tail.unshift(existing.slice(index + 1));
    existing = existing.slice(0, index) || '/';
  }
  const result = await host.run(['/bin/pwd', '-P'], { cwd: existing, timeoutMs: 5000 });
  if (result.exitCode !== 0 || !result.stdout.endsWith('\n')) throw new Error(`Cannot resolve directory: ${path}`);
  const physical = result.stdout.slice(0, -1);
  return physical.replace(/\/$/, '') + (tail.length ? '/' + tail.join('/') : '') || '/';
}
