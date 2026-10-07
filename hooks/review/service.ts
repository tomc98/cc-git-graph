import type { PanelHost } from '../controller.ts';
import { canonicalPath } from '../config/paths.ts';
import { resolveRepositoryContext } from '../config/repository-maps.ts';
import { discoverRepository, type Repository } from '../git/repository.ts';
import { readRemotes } from '../git/remotes.ts';
import { readWorktrees } from '../git/worktrees.ts';
import { readStatus, type WorkingFile } from '../git/status.ts';
import { createGitReader, complete } from '../git/read.ts';
import { endpoints, readCommit, readPatch, type Comparison, type DiffEndpoints, type ChangedFile, type PatchPreview } from '../git/details.ts';
import { readFilePage, type FileCursor } from '../git/files.ts';
import { startSnapshot, nextPage, type Commit, type HistorySnapshot } from '../git/history.ts';
import { parseTarget, remoteRepository, repositoryKey, repositoryUrl, encodePath, safePath, lineSelection, type GitHubRepository, type ReviewTarget } from './target.ts';

interface RemoteCommit { sha: string; parents: { sha: string }[]; commit: { message: string; author: { name: string; date: string } | null }; }
export interface PullRequest {
  number: number; title: string; body: string | null; html_url: string; state: string;
  base: { sha: string; ref: string; repo: { full_name: string } };
  head: { sha: string; ref: string; repo: { full_name: string } | null };
}
export interface ReviewContext {
  id: string; target: string; title: string; initialView?: 'files' | 'commits'; repository: Repository; github?: GitHubRepository; url?: string;
  kind: 'pr' | 'commit' | 'compare' | 'blob' | 'tree' | 'repository' | 'worktree' | 'stack';
  base: string; head: string; comparison: Comparison; diff: DiffEndpoints;
  pr?: PullRequest; stack?: PullRequest[]; notices: string[]; path?: string; lines?: { start: number; end: number };
  snapshot: HistorySnapshot; commitsPage: number; commitsMore: boolean;
  local?: { mode: 'branch' | 'worktree' | 'uncommitted'; working: WorkingFile[]; published?: string };
}
export interface OpenOptions { repository?: string; mode?: 'branch' | 'worktree' | 'uncommitted'; base?: string; file?: string; }
const commitQuery = '{sha,parents:[.parents[]|{sha}],commit:{message:.commit.message,author:.commit.author}}';
const prQuery = '{number,title,body,html_url,state,base:{sha:.base.sha,ref:.base.ref,repo:{full_name:.base.repo.full_name}},head:{sha:.head.sha,ref:.head.ref,repo:(if .head.repo then {full_name:.head.repo.full_name} else null end)}}';
function oid(value: string): string {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)) throw new Error('Invalid commit identifier in review response.');
  return value;
}
export function commit(value: RemoteCommit): Commit {
  return { oid: oid(value.sha), parents: value.parents.map(p => oid(p.sha)), author: value.commit.author?.name ?? '', timestamp: Date.parse(value.commit.author?.date ?? '') / 1000 || 0, subject: value.commit.message.split('\n')[0]!.slice(0, 512) };
}
export function topologicalCommits(commits: Commit[]): Commit[] {
  const byId = new Map(commits.map(c => [c.oid, c]));
  const children = new Map(commits.map(c => [c.oid, 0]));
  for (const c of commits) for (const parent of c.parents) if (children.has(parent)) children.set(parent, children.get(parent)! + 1);
  const ready = commits.filter(c => children.get(c.oid) === 0).sort((a, b) => b.timestamp - a.timestamp);
  const result: Commit[] = [];
  while (ready.length) {
    const c = ready.shift()!; result.push(c);
    for (const parent of c.parents) if (children.has(parent)) {
      const remaining = children.get(parent)! - 1; children.set(parent, remaining);
      if (!remaining) ready.push(byId.get(parent)!);
    }
  }
  if (result.length !== commits.length) throw new Error('Invalid cyclic commit ancestry.');
  return result;
}

export class ReviewService {
  readonly read;
  private sequence = 0;
  readonly contexts = new Map<string, ReviewContext>();
  readonly host: PanelHost;
  constructor(host: PanelHost) { this.host = host; this.read = createGitReader(host, host.root); }

  async helper<T>(input: Record<string, unknown>): Promise<T> {
    const result = await this.host.run(['/usr/bin/python3', this.host.root + '/scripts/github-read.py'], { stdin: JSON.stringify(input), timeoutMs: input.mode === 'objects' ? 300000 : 65000 });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'GitHub read failed. Install gh and run gh auth login.');
    let data;
    try { data = JSON.parse(result.stdout); } catch { throw new Error('Incomplete GitHub response. Narrow the selection or retry.'); }
    if (data.version !== 1 || data.end !== 'cc-git-graph-github-v1') throw new Error('Invalid GitHub response.');
    return data.value as T;
  }
  api<T>(repo: GitHubRepository, path: string, query = '.') { return this.helper<T>({ mode: 'api', endpoint: `repos/${repo.owner}/${repo.name}${path}`, query }); }
  async repositories(): Promise<Repository[]> {
    const cwd = await this.host.cwd(), home = await this.host.home();
    if (!home) throw new Error('Home directory unavailable.');
    const configPath = (await this.host.configDirectory() || home + '/.claude') + '/cc-git-graph.json';
    const context = await resolveRepositoryContext({ cwd, home, config: await this.host.exists(configPath) ? await this.host.read(configPath) : undefined }, { canonical: p => canonicalPath(this.host, p), discover: p => discoverRepository(this.host, p) });
    const repos = context.choices.flatMap(c => c.repository ? [c.repository] : []);
    try { const current = await discoverRepository(this.host, cwd); if (!repos.some(r => r.identity === current.identity)) repos.unshift(current); } catch { /* Remote reviews work outside a checkout. */ }
    return repos;
  }
  async matching(repo: GitHubRepository, preferred?: string): Promise<Repository[]> {
    const candidates = preferred ? [await discoverRepository(this.host, preferred)] : await this.repositories();
    const result: Repository[] = [];
    for (const candidate of candidates) {
      const remotes = await readRemotes(this.read, candidate);
      if (!remotes.some(r => r.urls.some(u => { const remote = remoteRepository(u); return remote && repositoryKey(remote) === repositoryKey(repo); }))) continue;
      result.push(candidate);
      for (const worktree of await readWorktrees(this.read, candidate)) {
        if (result.some(r => r.root === worktree.path)) continue;
        try { result.push(await discoverRepository(this.host, worktree.path)); } catch { /* Stale worktree registrations are not usable checkouts. */ }
      }
    }
    return result;
  }
  async objects(repo: GitHubRepository, shas: string[], preferred?: string): Promise<Repository> {
    for (const candidate of await this.matching(repo, preferred)) {
      let available = true;
      for (const sha of shas) if ((await this.read(candidate.root, ['cat-file', '-e', oid(sha) + '^{commit}'])).exitCode !== 0) { available = false; break; }
      if (available) return candidate;
    }
    const home = await this.host.home();
    if (!home) throw new Error('Home directory unavailable.');
    const cache = (await this.host.configDirectory() || home + '/.claude') + '/cc-git-graph-cache';
    const path = await this.helper<string>({ mode: 'objects', cache, owner: repo.owner, name: repo.name, shas: shas.map(oid) });
    return discoverRepository(this.host, path);
  }
  async mergeBase(repo: GitHubRepository, base: string, head: string): Promise<string> {
    return oid(await this.api<string>(repo, `/compare/${oid(base)}...${oid(head)}?per_page=1`, '.merge_base_commit.sha'));
  }
  async resolve(target: string, options: OpenOptions = {}): Promise<ReviewContext> {
    if (target === 'worktree') return this.local(options);
    if (target.startsWith('stack ')) return this.stack(target.slice(6).trim().split(/\s+/), options);
    const parsed = parseTarget(target), remote = parsed.repository;
    let head = '', base = '', pr: PullRequest | undefined, path: string | undefined, title = `${remote.owner}/${remote.name}`;
    if (parsed.kind === 'pr') {
      pr = await this.api<PullRequest>(remote, `/pulls/${parsed.number}`, prQuery);
      head = oid(pr.head.sha); base = await this.mergeBase(remote, pr.base.sha, head); title += ` #${pr.number} · ${pr.title}`;
    } else if (parsed.kind === 'compare') {
      const a = await this.api<string>(remote, '/commits/' + encodeURIComponent(parsed.base!), '.sha');
      head = oid(await this.api<string>(remote, '/commits/' + encodeURIComponent(parsed.ref!), '.sha'));
      base = parsed.threeDot ? await this.mergeBase(remote, a, head) : oid(a);
      title += ` · ${parsed.base}${parsed.threeDot ? '...' : '..'}${parsed.ref}`;
    } else if (parsed.kind === 'blob' || parsed.kind === 'tree') {
      const pieces = parsed.ref!.split('/');
      for (let i = Math.min(pieces.length - (parsed.kind === 'blob' ? 1 : 0), 12); i > 0; i--) {
        try { head = oid(await this.api<string>(remote, '/commits/' + encodeURIComponent(pieces.slice(0, i).join('/')), '.sha')); path = pieces.slice(i).join('/') || undefined; break; } catch (error) { if (i === 1) throw error; }
      }
      base = head; title += ` · ${path ?? parsed.ref}`;
    } else if (parsed.kind === 'repository') {
      const branch = await this.api<string>(remote, '', '.default_branch');
      head = oid(await this.api<string>(remote, '/commits/' + encodeURIComponent(branch), '.sha')); base = head;
    } else {
      const detail = await this.api<RemoteCommit>(remote, '/commits/' + parsed.ref, commitQuery);
      head = oid(detail.sha); base = detail.parents[0]?.sha ?? head; title += ' · ' + head.slice(0, 8);
    }
    const repository = await this.objects(remote, [base, head], options.repository);
    const comparison: Comparison = parsed.kind === 'commit' ? { kind: 'commit', oid: head, parent: 0 } : { kind: 'trees', from: base, to: head };
    const result: ReviewContext = {
      id: '', target, title, initialView: parsed.tab, repository, github: remote, url: parsed.kind === 'blob' && path ? `${repositoryUrl(remote)}/blob/${head}/${encodePath(path)}` : parsed.url,
      kind: parsed.kind, base, head, comparison, diff: await endpoints(this.read, repository, comparison), pr, path: options.file ?? path,
      lines: lineSelection(parsed.fragment), notices: [], snapshot: { roots: [head], refs: [], head, commits: [], hasMore: false }, commitsPage: 0, commitsMore: true,
    };
    if (pr) result.snapshot.refs = [{ name: `refs/heads/${pr.head.ref}`, oid: head, commit: head, kind: 'branch' }, { name: `refs/heads/${pr.base.ref} (merge base)`, oid: base, commit: base, kind: 'branch' }];
    if (parsed.fragment && !result.lines) await this.anchor(result, parsed);
    await this.moreCommits(result);
    return this.remember(result);
  }
  remember(context: ReviewContext): ReviewContext {
    context.id = `review-${++this.sequence}`;
    this.contexts.set(context.id, context);
    while (this.contexts.size > 6) this.contexts.delete(this.contexts.keys().next().value!);
    return context;
  }
  async anchor(context: ReviewContext, target: ReviewTarget): Promise<void> {
    const diff = /^diff-([0-9a-f]{64})(?:[LR]\d+(?:[LR]\d+)?)?$/.exec(target.fragment ?? '');
    if (diff && context.pr) {
      let cursor: FileCursor | undefined;
      for (let page = 0; page < 25; page++) {
        const files = await this.files(context, cursor);
        const path = await this.helper<string | null>({ mode: 'anchor', paths: files.files.map(f => f.path), anchor: 'diff-' + diff[1] });
        if (path) { context.path = path; context.notices.push('Linked diff file selected; GitHub diff-line anchors are not mapped to numbered preview lines.'); return; }
        if (!files.hasMore) break;
        cursor = { offset: files.nextOffset, prefix: files.prefix };
      }
    }
    if (target.fragment?.startsWith('discussion_r')) {
      const id = target.fragment.slice(12);
      if (/^\d+$/.test(id)) {
        const comment = await this.api<{ path: string; commit_id: string; line: number | null; side: string }>(target.repository, `/pulls/comments/${id}`, '{path,commit_id,line,side}');
        context.path = safePath(comment.path);
        context.notices.push(comment.commit_id === context.head ? 'Review comment file selected.' : 'This comment refers to an older commit; showing the file in the selected PR snapshot.');
        return;
      }
    }
    context.notices.push('The URL anchor could not be resolved exactly; the containing review is open.');
  }
  async moreCommits(context: ReviewContext): Promise<void> {
    if (!context.commitsMore || context.snapshot.commits.length >= 5000) return;
    if (context.local) {
      context.snapshot = await nextPage(this.read, context.repository, context.snapshot);
      context.commitsMore = context.snapshot.hasMore;
      return;
    }
    const page = context.commitsPage + 1;
    const range = ['pr', 'compare', 'stack'].includes(context.kind) && context.base !== context.head;
    const path = range ? `/compare/${context.base}...${context.head}?per_page=100&page=${page}` : `/commits?sha=${context.head}&per_page=100&page=${page}`;
    const data = await this.api<RemoteCommit[]>(context.github!, path, range ? `[.commits[]|${commitQuery}]` : `[.[]|${commitQuery}]`);
    const all = [...context.snapshot.commits, ...data.map(commit)];
    const unique = [...new Map(all.map(c => [c.oid, c])).values()];
    context.snapshot = { ...context.snapshot, commits: topologicalCommits(unique), hasMore: false };
    context.commitsPage = page; context.commitsMore = data.length === 100 && unique.length < 5000;
    if (range && !context.commitsMore && !unique.some(c => c.oid === context.base) && unique.length < 5000) {
      const baseCommit = commit(await this.api<RemoteCommit>(context.github!, '/commits/' + context.base, commitQuery));
      context.snapshot = { ...context.snapshot, commits: topologicalCommits([...new Map([...unique, baseCommit].map(c => [c.oid, c])).values()]) };
    }
    if (unique.length >= 5000) context.notices.push('5,000-commit display limit reached.');
  }
  async local(options: OpenOptions): Promise<ReviewContext> {
    const repository = await discoverRepository(this.host, options.repository || await this.host.cwd());
    if (repository.bare) throw new Error('Choose a worktree directory for a local review.');
    const head = oid(complete(await this.read(repository.root, ['rev-parse', '--verify', 'HEAD']), 'Read HEAD').trim());
    const remotes = await readRemotes(this.read, repository);
    const github = remotes.flatMap(r => r.urls.map(remoteRepository)).find(Boolean);
    const branch = complete(await this.read(repository.root, ['rev-parse', '--abbrev-ref', 'HEAD']), 'Read branch').trim();
    let published: string | undefined, baseRef = options.base;
    if (github && !baseRef && branch !== 'HEAD') {
      try {
        const prs = await this.api<PullRequest[]>(github, `/pulls?state=open&head=${encodeURIComponent(github.owner + ':' + branch)}&per_page=100`, `[.[]|${prQuery}]`);
        if (prs.length === 1) { published = prs[0]!.html_url; baseRef = prs[0]!.base.sha; }
        if (prs.length > 1) throw new Error('Several PRs match this branch. Specify a base or open the PR URL.');
      } catch (error) { if (String(error).includes('Several PRs')) throw error; }
    }
    const mode = options.mode ?? 'worktree';
    let base = head;
    if (mode !== 'uncommitted') {
      if (!baseRef) {
        const defaultRef = await this.read(repository.root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
        if (defaultRef.exitCode === 0) baseRef = complete(defaultRef, 'Read default branch').trim();
      }
      if (!baseRef) throw new Error('Choose a comparison base: /gg worktree main (or pass base to graph_open).');
      if (baseRef.startsWith('-') || /[\x00-\x20]/.test(baseRef)) throw new Error('Invalid comparison base.');
      const resolved = oid(complete(await this.read(repository.root, ['rev-parse', '--verify', '--end-of-options', baseRef + '^{commit}']), 'Resolve local base').trim());
      base = oid(complete(await this.read(repository.root, ['merge-base', resolved, head]), 'Find local merge base').trim());
    }
    const comparison: Comparison = mode === 'branch' ? { kind: 'trees', from: base, to: head } : { kind: 'worktree', from: base };
    const snapshot = await startSnapshot(this.read, repository); snapshot.roots = [head];
    const context: ReviewContext = { id: '', target: 'worktree', title: `${branch} · ${mode === 'branch' ? 'Local branch' : mode === 'uncommitted' ? 'Uncommitted changes' : 'All local changes against base'}`, kind: 'worktree', repository, github, url: published, base, head, comparison, diff: await endpoints(this.read, repository, comparison), notices: ['Local changes may differ from the published PR. Untracked files are listed separately.'], snapshot, commitsPage: 0, commitsMore: true, local: { mode, working: await readStatus(this.read, repository), published }, path: options.file };
    await this.moreCommits(context);
    return this.remember(context);
  }
  async stack(urls: string[], options: OpenOptions): Promise<ReviewContext> {
    if (!urls.length || urls.length > 20) throw new Error('A stack must contain 1–20 PR URLs in base-to-tip order.');
    let contexts = [];
    for (const url of urls) {
      const parsed = parseTarget(url);
      if (parsed.kind !== 'pr') throw new Error('Stacks require PR URLs.');
      contexts.push(await this.resolve(url, options));
    }
    if (contexts.length === 1) {
      let current = contexts[0]!;
      while (contexts.length < 20) {
        const pr = current.pr!;
        const parentCandidates = await this.api<PullRequest[]>(current.github!, `/pulls?state=open&head=${encodeURIComponent(pr.base.repo.full_name.split('/')[0] + ':' + pr.base.ref)}&per_page=100`, `[.[]|${prQuery}]`);
        const candidates = parentCandidates.filter(p => p.number !== pr.number && p.head.repo?.full_name.toLowerCase() === pr.base.repo.full_name.toLowerCase() && p.head.ref === pr.base.ref);
        if (!candidates.length) break;
        if (candidates.length > 1) throw new Error('Several parent PRs match. Use /gg stack <base PR URL> <next PR URL> …');
        if (contexts.some(c => c.pr!.number === candidates[0]!.number)) throw new Error('Cyclic PR base relationships. Specify a linear stack.');
        current = await this.resolve(`${repositoryUrl(current.github!)}/pull/${candidates[0]!.number}`, options);
        contexts.unshift(current);
      }
    }
    for (let i = 1; i < contexts.length; i++) {
      const prev = contexts[i - 1]!, next = contexts[i]!;
      if (repositoryKey(prev.github!) !== repositoryKey(next.github!) || prev.pr!.head.repo?.full_name.toLowerCase() !== next.pr!.base.repo.full_name.toLowerCase() || prev.pr!.head.ref !== next.pr!.base.ref) throw new Error('These PRs do not form a verified base-to-head stack.');
      if (await this.mergeBase(next.github!, prev.head, next.head) !== prev.head) throw new Error('The child PR does not include the current parent head. Restack it or review the PRs separately.');
    }
    const first = contexts[0]!, tip = contexts.at(-1)!;
    const repository = await this.objects(tip.github!, [first.base, tip.head], options.repository);
    const comparison: Comparison = { kind: 'trees', from: first.base, to: tip.head };
    const context: ReviewContext = { ...tip, id: '', target: 'stack ' + contexts.map(c => c.url).join(' '), title: `Stack · ${contexts.map(c => '#' + c.pr!.number).join(' → ')}`, kind: 'stack', pr: undefined, stack: contexts.map(c => c.pr!), base: first.base, repository, comparison, diff: await endpoints(this.read, repository, comparison), snapshot: { ...tip.snapshot, commits: [] }, commitsPage: 0, commitsMore: true, notices: ['Stack order verified using PR base/head branches and commit ancestry.'] };
    await this.moreCommits(context);
    return this.remember(context);
  }
  async files(context: ReviewContext, cursor?: FileCursor) {
    if (context.kind === 'tree' || context.kind === 'repository') {
      const output = complete(await this.read(context.repository.root, ['ls-tree', '-r', '-z', '--name-only', context.head, '--', ...(context.path ? [safePath(context.path)] : [])]), 'Read repository files');
      const paths = output.split('\0').filter(Boolean), offset = cursor?.offset ?? 0;
      const files = paths.slice(offset, offset + 200).map(path => ({ status: 'blob', path }));
      return { files, offset, nextOffset: offset + files.length, hasMore: offset + files.length < paths.length, prefix: context.head.padEnd(64, '0') };
    }
    return readFilePage(this.host, this.host.root, context.repository, context.diff, cursor);
  }
  async patch(context: ReviewContext, file: ChangedFile): Promise<PatchPreview> {
    const patch = await readPatch(this.read, context.repository, context.diff, file);
    if (!patch.text) throw new Error('This file has no changes in the selected comparison. Open its blob URL to read unchanged content.');
    return patch;
  }
  async blob(context: ReviewContext, path: string): Promise<PatchPreview> {
    const result = await this.read(context.repository.root, ['show', `${context.head}:${safePath(path)}`], { limit: 65536 });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'File unavailable at this commit.');
    return { text: result.stdout, complete: result.stdoutComplete && result.stdoutValidUtf8, binary: result.stdout.includes('\0'), totalBytes: result.stdoutTotalBytes };
  }
  async commitContext(context: ReviewContext, sha: string): Promise<ReviewContext> {
    if (context.github) return this.resolve(`${repositoryUrl(context.github)}/commit/${oid(sha)}`, { repository: context.repository.root });
    const detail = await readCommit(this.read, context.repository, oid(sha));
    const comparison: Comparison = { kind: 'commit', oid: sha, parent: 0 };
    return this.remember({ ...context, id: '', kind: 'commit', title: detail.message.split('\n')[0]!, head: sha, base: detail.parents[0] ?? sha, comparison, diff: await endpoints(this.read, context.repository, comparison, detail), local: undefined, path: undefined });
  }
  async link(context: ReviewContext, path?: string): Promise<string | undefined> {
    if (!context.github) return;
    if (context.local && context.local.mode !== 'branch') return context.local.published;
    if (!path) return context.url ?? `${repositoryUrl(context.github)}/commit/${context.head}`;
    if (context.pr) return `${repositoryUrl(context.github)}/pull/${context.pr.number}/files#${await this.helper<string>({ mode: 'anchor', path })}`;
    return `${repositoryUrl(context.github)}/blob/${context.head}/${encodePath(path)}${context.lines ? `#L${context.lines.start}-L${context.lines.end}` : ''}`;
  }
}
