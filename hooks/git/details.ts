import { objectId } from './history.ts';
import { complete, type GitReader } from './read.ts';
import type { Repository } from './repository.ts';
import { rawParents } from './ancestry.ts';

export interface CommitDetail {
  oid: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authoredAt: string;
  committer: string;
  committerEmail: string;
  committedAt: string;
  message: string;
  messageComplete: boolean;
  shallowBoundary?: boolean;
}

export type Comparison =
  | { kind: 'commit'; oid: string; parent: number }
  | { kind: 'trees'; from: string; to: string }
  | { kind: 'staged' }
  | { kind: 'unstaged' }
  | { kind: 'worktree'; from: string };

export interface DiffEndpoints { label: string; args: string[]; immutable: boolean; }
export interface ChangedFile { status: string; path: string; oldPath?: string; }
export interface PatchPreview { text: string; complete: boolean; binary: boolean; totalBytes: number; }

export async function readCommit(read: GitReader, repo: Repository, oid: string): Promise<CommitDetail> {
  if (!objectId(oid, repo.objectFormat)) throw new Error('Select a full commit identifier.');
  const response = await read(repo.root, ['log', '--no-walk', '-z', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B', oid, '--'], { limit: 65536 });
  if (response.exitCode !== 0) throw new Error('Read commit: ' + response.stderr);
  const fields = response.stdout.split('\0');
  if (response.stdoutComplete && fields.pop() !== '') throw new Error('Incomplete commit record.');
  if (fields.length !== 9 || fields[0] !== oid) throw new Error('Commit metadata is too large or malformed.');
  let parents = fields[1] ? fields[1].split(' ') : [];
  let shallowBoundary = false;
  if (repo.shallow && !parents.length) { parents = await rawParents(read, repo, oid); shallowBoundary = parents.length > 0; }
  if (!parents.every(parent => objectId(parent, repo.objectFormat))) throw new Error('Invalid commit ancestry.');
  return { oid, parents, author: fields[2]!, authorEmail: fields[3]!, authoredAt: fields[4]!, committer: fields[5]!, committerEmail: fields[6]!, committedAt: fields[7]!, message: fields[8]!, messageComplete: response.stdoutComplete && response.stdoutValidUtf8, shallowBoundary };
}

export async function endpoints(read: GitReader, repo: Repository, comparison: Comparison, detail?: CommitDetail): Promise<DiffEndpoints> {
  const checked = (oid: string) => { if (!objectId(oid, repo.objectFormat)) throw new Error('Invalid comparison object.'); return oid; };
  if (comparison.kind === 'staged') {
    const head = await read(repo.root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (head.exitCode !== 0 && head.exitCode !== 1) throw new Error('Read staged base: ' + head.stderr);
    return { label: head.exitCode === 0 ? 'HEAD → index (staged)' : 'Empty tree → index (staged; no commits yet)', args: ['--cached'], immutable: false };
  }
  if (comparison.kind === 'unstaged') return { label: 'Index → working tree (unstaged)', args: [], immutable: false };
  if (comparison.kind === 'worktree') return { label: `${comparison.from.slice(0, 12)} → tracked working tree`, args: [checked(comparison.from)], immutable: false };
  if (comparison.kind === 'trees') return { label: `${comparison.from.slice(0, 12)} → ${comparison.to.slice(0, 12)}`, args: [checked(comparison.from), checked(comparison.to)], immutable: true };
  const commit = detail?.oid === comparison.oid ? detail : await readCommit(read, repo, checked(comparison.oid));
  if (!Number.isInteger(comparison.parent) || comparison.parent < 0 || (commit.parents.length && comparison.parent >= commit.parents.length)) throw new Error('Select an existing merge parent.');
  const from = commit.parents[comparison.parent] ?? complete(await read(repo.root, ['hash-object', '-t', 'tree', '--stdin'], { stdin: '' }), 'Read empty tree').trim();
  checked(from);
  return { label: `${commit.parents.length ? from.slice(0, 12) + ' (parent ' + (comparison.parent + 1) + ')' : 'Empty tree (root commit)'} → ${commit.oid.slice(0, 12)}`, args: [from, commit.oid], immutable: true };
}

export function parseChangedFiles(output: string): ChangedFile[] {
  if (!output) return [];
  const fields = output.split('\0');
  if (fields.pop() !== '') throw new Error('Incomplete changed-file list.');
  const result: ChangedFile[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++]!;
    if (!/^(?:[ADMTUXB]|[RC][0-9]{1,3})$/.test(status)) throw new Error('Unknown file change status.');
    const first = fields[i++];
    const renamed = /^[RC]/.test(status);
    const path = renamed ? fields[i++] : first;
    if (!path || !first) throw new Error('Missing path in changed-file record.');
    result.push({ status, path, ...(renamed ? { oldPath: first } : {}) });
  }
  return result;
}

export async function readChangedFiles(read: GitReader, repo: Repository, diff: DiffEndpoints): Promise<ChangedFile[]> {
  const output = complete(await read(repo.root, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', ...diff.args, '--']), 'Read changed files');
  return parseChangedFiles(output);
}

export async function readPatch(read: GitReader, repo: Repository, diff: DiffEndpoints, file: ChangedFile): Promise<PatchPreview> {
  const paths = file.oldPath && file.oldPath !== file.path ? [file.oldPath, file.path] : [file.path];
  const response = await read(repo.root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--unified=3', ...diff.args, '--', ...paths], { limit: 262144 });
  if (response.exitCode !== 0) throw new Error('Read patch: ' + response.stderr);
  const lines = response.stdout.split('\n');
  return { text: lines.slice(0, 2000).join('\n'), complete: response.stdoutComplete && response.stdoutValidUtf8 && lines.length <= 2000,
    totalBytes: response.stdoutTotalBytes, binary: /^Binary files .* differ$/m.test(response.stdout) || response.stdout.includes('GIT binary patch') };
}
