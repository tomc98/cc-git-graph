import { complete, type GitReader } from './read.ts';
import type { Repository } from './repository.ts';
import { rawParents } from './ancestry.ts';

export interface Ref { name: string; oid: string; commit?: string; kind: 'branch' | 'remote' | 'tag'; }
export interface Commit { oid: string; parents: string[]; author: string; timestamp: number; subject: string; shallowBoundary?: boolean; }
export interface HistorySnapshot { roots: string[]; refs: Ref[]; head?: string; branch?: string; commits: Commit[]; hasMore: boolean; }

export function objectId(value: string, format: Repository['objectFormat']): boolean {
  return new RegExp(`^[0-9a-f]{${format === 'sha256' ? 64 : 40}}$`).test(value);
}

export async function readRefs(read: GitReader, repo: Repository): Promise<{ refs: Ref[]; head?: string; branch?: string }> {
  const [refResponse, headResponse, branchResponse] = await Promise.all([
    read(repo.root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)', 'refs/heads', 'refs/remotes', 'refs/tags']),
    read(repo.root, ['rev-parse', '--verify', 'HEAD']),
    read(repo.root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
  ]);
  const output = complete(refResponse, 'Read references');
  const refs: Ref[] = [];
  if (output && !output.endsWith('\n')) throw new Error('Incomplete reference list.');
  for (const row of output ? output.slice(0, -1).split('\n') : []) {
    const fields = row.split('\0');
    const [name, oid, peeled, kind, peeledKind] = fields;
    if (fields.length !== 5 || !name || !oid || !objectId(oid, repo.objectFormat)) throw new Error('Invalid reference record.');
    refs.push({ name, oid, commit: kind === 'commit' ? oid : peeledKind === 'commit' && peeled && objectId(peeled, repo.objectFormat) ? peeled : undefined,
      kind: name.startsWith('refs/heads/') ? 'branch' : name.startsWith('refs/remotes/') ? 'remote' : 'tag' });
  }
  let head: string | undefined;
  if (headResponse.exitCode === 0) {
    head = complete(headResponse, 'Read HEAD').trim();
    if (!objectId(head, repo.objectFormat)) throw new Error('Invalid HEAD response.');
  } else if (headResponse.exitCode !== 128) throw new Error('Cannot read HEAD: ' + headResponse.stderr);
  const branch = branchResponse.exitCode === 0 ? complete(branchResponse, 'Read branch').replace(/\n$/, '') : undefined;
  return { refs, head, branch };
}

export async function startSnapshot(read: GitReader, repo: Repository, filter?: string): Promise<HistorySnapshot> {
  const state = await readRefs(read, repo);
  const roots = [...new Set((filter ? state.refs.filter(ref => ref.name === filter) : state.refs).flatMap(ref => ref.commit ? [ref.commit] : []))];
  if (!filter && state.head && !roots.includes(state.head)) roots.push(state.head);
  return { ...state, roots, commits: [], hasMore: roots.length > 0 };
}

export async function nextPage(read: GitReader, repo: Repository, snapshot: HistorySnapshot): Promise<HistorySnapshot> {
  if (!snapshot.hasMore || snapshot.commits.length >= 5000) return { ...snapshot, hasMore: false };
  const count = Math.min(200, 5000 - snapshot.commits.length);
  const output = complete(await read(repo.root, ['rev-list', '--topo-order', '--parents', `--skip=${snapshot.commits.length}`, `--max-count=${count + 1}`, ...snapshot.roots, '--']), 'Read history');
  const rows = output ? output.replace(/\n$/, '').split('\n') : [];
  const ancestry = rows.slice(0, count).map(row => {
    const ids = row.split(' ');
    if (!ids.every(id => objectId(id, repo.objectFormat))) throw new Error('Invalid ancestry record.');
    return { oid: ids[0]!, parents: ids.slice(1) };
  });
  if (!ancestry.length) return { ...snapshot, hasMore: false };
  const metadata = complete(await read(repo.root, ['log', '--no-walk=unsorted', '-z', '--format=%H%x00%P%x00%<(120,trunc)%an%x00%at%x00%<(512,trunc)%s', ...ancestry.map(c => c.oid), '--']), 'Read commit metadata');
  const fields = metadata.split('\0');
  if (fields.pop() !== '' || fields.length !== ancestry.length * 5) throw new Error('Incomplete commit metadata records.');
  const byId = new Map<string, Commit>();
  for (let i = 0; i < fields.length; i += 5) {
    const oid = fields[i]!;
    const parents = fields[i + 1] ? fields[i + 1]!.split(' ') : [];
    const timestamp = Number(fields[i + 3]);
    if (!objectId(oid, repo.objectFormat) || !parents.every(p => objectId(p, repo.objectFormat)) || !Number.isFinite(timestamp) || byId.has(oid)) throw new Error('Invalid commit metadata.');
    byId.set(oid, { oid, parents, author: fields[i + 2]!.trimEnd(), timestamp, subject: fields[i + 4]!.trimEnd() });
  }
  const seen = new Set(snapshot.commits.map(c => c.oid));
  const commits = ancestry.map(item => {
    const commit = byId.get(item.oid);
    if (!commit || seen.has(item.oid) || commit.parents.join(' ') !== item.parents.join(' ')) throw new Error('History changed or a metadata record is missing. Refresh the snapshot.');
    return commit;
  });
  if (repo.shallow) {
    for (const commit of commits.filter(commit => !commit.parents.length)) {
      const parents = await rawParents(read, repo, commit.oid);
      if (parents.length) { commit.parents = parents; commit.shallowBoundary = true; }
    }
  }
  return { ...snapshot, commits: [...snapshot.commits, ...commits], hasMore: rows.length > count && snapshot.commits.length + count < 5000 };
}
