import type { GitReader } from './read.ts';
import type { Repository } from './repository.ts';

export async function rawParents(read: GitReader, repo: Repository, oid: string): Promise<string[]> {
  const result = await read(repo.root, ['cat-file', 'commit', oid], { limit: 65536 });
  if (result.exitCode !== 0) throw new Error('Read commit ancestry: ' + result.stderr);
  const end = result.stdout.indexOf('\n\n');
  if (end < 0) throw new Error('Commit headers exceed the ancestry preview limit.');
  const length = repo.objectFormat === 'sha256' ? 64 : 40;
  return result.stdout.slice(0, end).split('\n').filter(line => line.startsWith('parent ')).map(line => {
    const parent = line.slice(7);
    if (!new RegExp(`^[0-9a-f]{${length}}$`).test(parent)) throw new Error('Invalid raw commit parent.');
    return parent;
  });
}
