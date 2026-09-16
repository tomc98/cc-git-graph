import type { ReadHost } from '../host.ts';
import type { ChangedFile, DiffEndpoints } from './details.ts';
import type { Repository } from './repository.ts';

export interface FileCursor { offset: number; prefix?: string; }
export interface FilePage { files: ChangedFile[]; offset: number; nextOffset: number; hasMore: boolean; prefix: string; }

export async function readFilePage(host: ReadHost, pluginRoot: string, repo: Repository, diff: DiffEndpoints, cursor: FileCursor = { offset: 0 }): Promise<FilePage> {
  const response = await host.run(['/usr/bin/python3', pluginRoot + '/scripts/git-files.py'], { cwd: repo.root, timeoutMs: 17000, stdin: JSON.stringify({ cwd: repo.root, args: diff.args, ...cursor }) });
  if (response.exitCode !== 0) throw new Error('Read changed files: ' + response.stderr);
  let result;
  try { result = JSON.parse(response.stdout); } catch { throw new Error('Incomplete changed-file page envelope.'); }
  if (result.version !== 1 || result.end !== 'cc-git-graph-files-v1' || !Array.isArray(result.files) || result.files.length > 200 || result.offset !== cursor.offset || result.nextOffset !== cursor.offset + result.files.length || typeof result.hasMore !== 'boolean' || !/^[0-9a-f]{64}$/.test(result.prefix)) throw new Error('Invalid changed-file page envelope.');
  if (!result.files.every((file: ChangedFile) => file && typeof file.status === 'string' && /^(?:[ADMTUXB]|[RC][0-9]{1,3})$/.test(file.status) && typeof file.path === 'string' && file.path.length > 0 && (file.oldPath === undefined || typeof file.oldPath === 'string'))) throw new Error('Invalid changed-file page record.');
  if (result.hasMore && !result.files.length) throw new Error('Changed-file page made no progress.');
  return result;
}
