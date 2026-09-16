import { complete, type GitReader } from './read.ts';
import type { Repository } from './repository.ts';

export interface Remote { name: string; urls: string[]; pushUrls: string[]; fetchSpecs: string[]; }

export async function readRemotes(read: GitReader, repo: Repository): Promise<Remote[]> {
  const response = await read(repo.root, ['config', '--get-regexp', '-z', '^remote\\..*\\.(url|pushurl|fetch)$']);
  if (response.exitCode === 1) return [];
  const output = complete(response, 'Read remotes');
  const records = output.split('\0');
  if (records.pop() !== '') throw new Error('Incomplete remote configuration.');
  const remotes = new Map<string, Remote>();
  for (const record of records) {
    const newline = record.indexOf('\n');
    const key = record.slice(0, newline), value = record.slice(newline + 1);
    const match = /^remote\.(.+)\.(url|pushurl|fetch)$/.exec(key);
    if (newline < 0 || !match) throw new Error('Invalid remote configuration record.');
    const name = match[1]!;
    const remote = remotes.get(name) ?? { name, urls: [], pushUrls: [], fetchSpecs: [] };
    if (match[2] === 'url') remote.urls.push(value);
    else if (match[2] === 'pushurl') remote.pushUrls.push(value);
    else remote.fetchSpecs.push(value);
    remotes.set(name, remote);
  }
  return [...remotes.values()];
}
