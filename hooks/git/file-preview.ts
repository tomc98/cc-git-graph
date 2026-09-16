import type { ReadHost } from '../host.ts';
import type { Repository } from './repository.ts';
import type { PatchPreview } from './details.ts';

export async function filePreview(host: ReadHost, pluginRoot: string, repo: Repository, path: string): Promise<PatchPreview> {
  const response = await host.run(['/usr/bin/python3', pluginRoot + '/scripts/file-preview.py', repo.root, path], { cwd: repo.root, timeoutMs: 5000 });
  if (response.exitCode !== 0) throw new Error('File preview failed: ' + response.stderr);
  let value;
  try { value = JSON.parse(response.stdout); } catch { throw new Error('Incomplete file preview envelope.'); }
  if (value.version !== 1 || value.end !== 'cc-git-graph-file-v1' || typeof value.text !== 'string' || typeof value.complete !== 'boolean' || typeof value.binary !== 'boolean') throw new Error('Invalid file preview envelope.');
  const lines = value.text.split('\n');
  return { text: lines.slice(0, 2000).join('\n'), complete: value.complete && lines.length <= 2000, binary: value.binary, totalBytes: value.size };
}
