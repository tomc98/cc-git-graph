import { complete, type GitReader } from './read.ts';
import type { Repository } from './repository.ts';

export interface WorkingFile { path: string; oldPath?: string; index: string; worktree: string; kind: 'tracked' | 'untracked' | 'conflict'; submodule?: string; }

function fieldsAndPath(row: string, spaces: number): string[] {
  const fields: string[] = [];
  let offset = 0;
  for (let i = 0; i < spaces; i++) {
    const next = row.indexOf(' ', offset);
    if (next < 0) throw new Error('Malformed Git status record.');
    fields.push(row.slice(offset, next)); offset = next + 1;
  }
  fields.push(row.slice(offset));
  return fields;
}

export function parseStatus(output: string): WorkingFile[] {
  if (!output) return [];
  const rows = output.split('\0');
  if (rows.pop() !== '') throw new Error('Incomplete Git status records.');
  const files: WorkingFile[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.startsWith('? ')) { files.push({ kind: 'untracked', path: row.slice(2), index: '?', worktree: '?' }); continue; }
    if (row.startsWith('! ') || row.startsWith('# ')) continue;
    const type = row[0];
    if (!['1', '2', 'u'].includes(type!)) throw new Error('Unknown Git status record.');
    const fields = fieldsAndPath(row, type === '1' ? 8 : type === '2' ? 9 : 10);
    const xy = fields[1]!;
    if (xy.length !== 2 || !fields.at(-1)) throw new Error('Invalid Git status path or state.');
    let oldPath: string | undefined;
    if (type === '2') { oldPath = rows[++i]; if (!oldPath) throw new Error('Missing rename source in Git status.'); }
    files.push({ kind: type === 'u' ? 'conflict' : 'tracked', path: fields.at(-1)!, oldPath, index: xy[0]!, worktree: xy[1]!, submodule: fields[2] });
  }
  return files;
}

export async function readStatus(read: GitReader, repo: Repository): Promise<WorkingFile[]> {
  if (repo.bare) return [];
  return parseStatus(complete(await read(repo.root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']), 'Read working state'));
}
