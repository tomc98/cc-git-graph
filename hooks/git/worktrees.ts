import { complete, type GitReader } from './read.ts';
import type { Repository } from './repository.ts';

export interface Worktree { path: string; head?: string; branch?: string; bare: boolean; locked?: string; prunable?: string; }

export async function readWorktrees(read: GitReader, repo: Repository): Promise<Worktree[]> {
  const output = complete(await read(repo.root, ['worktree', 'list', '--porcelain', '-z']), 'Read worktrees');
  if (output && !output.endsWith('\0\0')) throw new Error('Incomplete worktree list.');
  return output.split('\0\0').filter(Boolean).map(record => {
    const fields = record.split('\0');
    if (!fields[0]?.startsWith('worktree ')) throw new Error('Malformed worktree record.');
    const result: Worktree = { path: fields[0].slice(9), bare: false };
    for (const field of fields.slice(1)) {
      if (field.startsWith('HEAD ')) result.head = field.slice(5);
      else if (field.startsWith('branch ')) result.branch = field.slice(7);
      else if (field === 'bare') result.bare = true;
      else if (field.startsWith('locked')) result.locked = field.slice(7) || 'Locked';
      else if (field.startsWith('prunable')) result.prunable = field.slice(9) || 'Prunable';
    }
    return result;
  });
}
