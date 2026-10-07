export interface GitHubRepository { owner: string; name: string; }
export interface ReviewTarget {
  repository: GitHubRepository;
  kind: 'pr' | 'commit' | 'compare' | 'blob' | 'tree' | 'repository';
  url: string;
  number?: number;
  ref?: string;
  base?: string;
  threeDot?: boolean;
  fragment?: string;
  tab?: 'files' | 'commits';
}
const segment = /^[A-Za-z0-9_.-]+$/;
export const repositoryKey = (repo: GitHubRepository) => `${repo.owner}/${repo.name}`.toLowerCase();
export const repositoryUrl = (repo: GitHubRepository) => `https://github.com/${repo.owner}/${repo.name}`;
export const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
export function safePath(path: string): string {
  if (!path || path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path) || path.split('/').some(p => p === '..' || p === '.')) throw new Error('Invalid file path.');
  return path;
}
export function parseTarget(value: string): ReviewTarget {
  const match = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)([^?#]*)(?:\?[^#]*)?(?:#(.*))?$/i.exec(value.trim());
  if (!match) throw new Error('Use an https://github.com/owner/repository URL, or /gg worktree.');
  const owner = match[1]!, name = match[2]!.replace(/\.git$/, '');
  if (![owner, name].every(s => segment.test(s) && s !== '.' && s !== '..')) throw new Error('Invalid GitHub repository.');
  let path: string;
  try { path = decodeURIComponent(match[3]!); } catch { throw new Error('Invalid URL encoding.'); }
  if (/[\x00-\x1f\x7f]/.test(path)) throw new Error('Invalid GitHub URL.');
  const repository = { owner, name }, url = repositoryUrl(repository);
  const result = { repository, url: value.trim(), fragment: match[4] };
  if (!path || path === '/') return { ...result, url, kind: 'repository' };
  const pr = /^\/pull\/([1-9]\d*)(?:\/(files|commits)(?:\/([0-9a-f]{7,40}))?)?\/?$/i.exec(path);
  if (pr) return pr[3] ? { ...result, kind: 'commit', ref: pr[3] } : { ...result, kind: 'pr', number: Number(pr[1]), tab: pr[2] as 'files' | 'commits' | undefined };
  const commit = /^\/commit\/([0-9a-f]{7,40})\/?$/i.exec(path);
  if (commit) return { ...result, kind: 'commit', ref: commit[1] };
  const compare = /^\/compare\/(.+?)(\.\.\.?)(.+)$/.exec(path);
  if (compare) return { ...result, kind: 'compare', base: compare[1], ref: compare[3], threeDot: compare[2] === '...' };
  const file = /^\/(blob|tree)\/(.+)$/.exec(path);
  if (file) return { ...result, kind: file[1] as 'blob' | 'tree', ref: safePath(file[2]!) };
  throw new Error('This GitHub URL does not identify a PR, commit, comparison, file or branch.');
}
export function remoteRepository(url: string): GitHubRepository | undefined {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)\/?$/.exec(url);
  return match ? { owner: match[1]!, name: match[2]!.replace(/\.git$/, '') } : undefined;
}
export function lineSelection(fragment?: string): { start: number; end: number } | undefined {
  const match = /^L([1-9]\d*)(?:-L?([1-9]\d*))?$/.exec(fragment ?? '');
  if (!match) return;
  const start = Number(match[1]), end = Number(match[2] ?? match[1]);
  if (!Number.isSafeInteger(end) || end < start) throw new Error('Invalid line selection.');
  return { start, end };
}
