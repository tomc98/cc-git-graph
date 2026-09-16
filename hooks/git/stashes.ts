import { complete, type GitReader } from './read.ts';
import { objectId } from './history.ts';
import type { Repository } from './repository.ts';

export interface Stash { selector: string; oid: string; subject: string; }

export async function readStashes(read: GitReader, repo: Repository): Promise<Stash[]> {
  const output = complete(await read(repo.root, ['stash', 'list', '-z', '--format=%gd%x00%H%x00%gs']), 'Read stashes');
  if (!output) return [];
  const fields = output.split('\0');
  if (fields.pop() !== '' || fields.length % 3 !== 0) throw new Error('Incomplete stash list.');
  const stashes: Stash[] = [];
  for (let i = 0; i < fields.length; i += 3) {
    if (!/^stash@\{\d+\}$/.test(fields[i]!) || !objectId(fields[i + 1]!, repo.objectFormat)) throw new Error('Invalid stash identity.');
    stashes.push({ selector: fields[i]!, oid: fields[i + 1]!, subject: fields[i + 2]! });
  }
  return stashes;
}
