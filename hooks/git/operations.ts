import type { ReadHost } from '../host.ts';
import type { Repository } from './repository.ts';
import { complete, type GitReader } from './read.ts';
import { objectId, readRefs } from './history.ts';
import { readCommit } from './details.ts';
import { readWorktrees } from './worktrees.ts';
import { readStashes } from './stashes.ts';
import { readRemotes } from './remotes.ts';
import { readStatus } from './status.ts';

export const actions = [
  ['branch-create', 'Create branch', ['name']], ['branch-switch', 'Switch branch', ['branch']],
  ['branch-rename', 'Rename branch', ['branch', 'name']], ['branch-delete', 'Delete merged branch', ['branch']],
  ['branch-force-delete', 'Force-delete branch', ['branch']], ['merge', 'Merge selected commit', []],
  ['rebase', 'Rebase onto selected commit', []], ['checkout-detached', 'Checkout detached', []],
  ['cherry-pick', 'Cherry-pick selected commit', ['parent']], ['revert', 'Revert selected commit', ['parent']],
  ['reset', 'Reset current branch', ['mode']], ['tag-create', 'Create lightweight tag', ['name']],
  ['tag-annotate', 'Create annotated tag', ['name', 'message']], ['tag-delete', 'Delete local tag', ['tag']],
  ['tag-push', 'Push selected tag', ['tag', 'remote']], ['stash-create', 'Create stash', ['message', 'includeUntracked']],
  ['stash-apply', 'Apply stash', ['stash']], ['stash-pop', 'Pop stash', ['stash']], ['stash-drop', 'Drop stash', ['stash']],
  ['stash-branch', 'Create branch from stash', ['stash', 'name']], ['fetch', 'Fetch remote', ['remote']],
  ['pull', 'Pull with explicit strategy', ['remote', 'remoteBranch', 'strategy']],
  ['push', 'Push branch', ['branch', 'remote', 'remoteBranch']], ['remote-add', 'Add remote', ['name', 'url']],
  ['remote-edit', 'Change remote URL', ['remote', 'url']], ['remote-remove', 'Remove remote', ['remote']],
  ['discard', 'Discard selected tracked changes', ['discardScope']], ['clean', 'Delete selected untracked files', []],
  ['continue', 'Continue current Git operation', []], ['abort', 'Abort current Git operation', []],
] as const;

export type ActionId = typeof actions[number][0];
export type ActionValues = Record<string, string>;
export interface ActionState {
  version: number; root: string; gitDir: string; head: string | null; branch: string | null; bare: boolean;
  dirtyCount: number; conflicts: string[]; operation: string | null; digest: string; end: string;
}
export interface ActionIntent {
  id: ActionId; repository: Repository; values: ActionValues; target?: string; paths: string[];
  scope: 'all' | 'refs' | 'paths'; expected: ActionState; argv: string[]; summary: string[]; nonce: string;
}
export interface ActionOptions { branches: string[]; tags: string[]; remotes: Awaited<ReturnType<typeof readRemotes>>; stashes: Awaited<ReturnType<typeof readStashes>>; }
export interface WriteResult { deny?: string; isError?: boolean; text?: string; result?: unknown; }
export interface ActionOutcome { status: 'succeeded' | 'failed' | 'conflict' | 'unknown' | 'denied' | 'stale'; message: string; state?: ActionState; backgroundTaskId?: string; }

const worktreeActions = new Set<string>(['branch-switch', 'merge', 'rebase', 'checkout-detached', 'cherry-pick', 'revert', 'reset', 'stash-create', 'stash-apply', 'stash-pop', 'stash-branch', 'pull', 'discard', 'clean', 'continue', 'abort']);
const cleanActions = new Set<string>(['merge', 'rebase', 'checkout-detached', 'cherry-pick', 'revert', 'pull', 'stash-branch']);

export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('A command argument contains a NUL byte.');
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export async function actionState(host: ReadHost, pluginRoot: string, repo: Repository, scope: ActionIntent['scope'], paths: string[] = []): Promise<ActionState> {
  const result = await host.run(['/usr/bin/python3', pluginRoot + '/scripts/git-state.py', 'snapshot', JSON.stringify({ cwd: repo.root, scope, paths })], { cwd: repo.root, timeoutMs: 30000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'Cannot inspect repository state.');
  let state: ActionState;
  try { state = JSON.parse(result.stdout); } catch { throw new Error('Incomplete action-state response.'); }
  if (state.version !== 1 || state.end !== 'cc-git-graph-state-v1' || !/^[0-9a-f]{64}$/.test(state.digest)
    || state.root !== repo.root || state.gitDir !== repo.gitDir) throw new Error('The selected checkout is no longer the same repository. Reopen the graph.');
  return state;
}

export async function actionOptions(read: GitReader, repo: Repository): Promise<ActionOptions> {
  const [refs, remotes, stashes] = await Promise.all([readRefs(read, repo), readRemotes(read, repo), repo.bare ? [] : readStashes(read, repo)]);
  return { branches: refs.refs.filter(ref => ref.kind === 'branch').map(ref => ref.name.slice(11)), tags: refs.refs.filter(ref => ref.kind === 'tag').map(ref => ref.name.slice(10)), remotes, stashes };
}

export async function prepareAction(host: ReadHost, read: GitReader, pluginRoot: string, repo: Repository,
  id: ActionId, values: ActionValues, target: string | undefined, selectedPaths: readonly string[], nonce: string): Promise<ActionIntent> {
  if (!actions.some(action => action[0] === id)) throw new Error('Choose a supported Git action.');
  if (!/^[a-zA-Z0-9_]+$/.test(nonce)) throw new Error('Invalid action request identifier.');
  if (repo.bare && worktreeActions.has(id)) throw new Error('This action requires a working tree.');
  const paths = [...new Set(selectedPaths)];
  const scope = id === 'discard' || id === 'clean' ? 'paths' : worktreeActions.has(id) ? 'all' : 'refs';
  const [expected, options, worktrees] = await Promise.all([actionState(host, pluginRoot, repo, scope, paths), actionOptions(read, repo), readWorktrees(read, repo)]);
  if (expected.operation && !['continue', 'abort'].includes(id) && worktreeActions.has(id)) throw new Error(`Finish or abort the current ${expected.operation} before starting this action.`);
  if (cleanActions.has(id) && expected.dirtyCount) throw new Error('This action requires a clean working tree. Commit or stash the existing changes first.');
  const value = (key: string) => {
    const result = values[key];
    if (!result || result.includes('\0')) throw new Error(`Enter ${key}.`);
    return result;
  };
  const validateName = async (name: string, namespace = 'heads') => {
    if (name.startsWith('-') || name === 'HEAD' || name.includes('@{')) throw new Error('Enter a literal Git ref name.');
    complete(await read(repo.root, ['check-ref-format', `refs/${namespace}/${name}`]), 'Validate ref name'); return name;
  };
  const branch = () => { const name = value('branch'); if (!options.branches.includes(name)) throw new Error('The selected branch no longer exists.'); return name; };
  const tag = () => { const name = value('tag'); if (!options.tags.includes(name)) throw new Error('The selected tag no longer exists.'); return name; };
  const remote = () => { const name = value('remote'); const found = options.remotes.find(r => r.name === name); if (!found) throw new Error('The selected remote no longer exists.'); return found; };
  const commit = () => { if (!target || !objectId(target, repo.objectFormat)) throw new Error('Select a commit first.'); return target; };
  const unusedBranch = (name: string, currentAllowed = false) => {
    const occupied = worktrees.find(w => w.branch === `refs/heads/${name}` && (!currentAllowed || w.path !== repo.root));
    if (occupied) throw new Error(`Branch ${name} is checked out at ${occupied.path}.`);
  };
  const newName = async (namespace = 'heads') => {
    const name = await validateName(value('name'), namespace);
    if ((namespace === 'heads' ? options.branches : options.tags).includes(name)) throw new Error(`${name} already exists.`);
    return name;
  };
  const summary = [`Checkout: ${repo.root}`, `Current HEAD: ${expected.head ?? 'unborn'}${expected.branch ? ' (' + expected.branch + ')' : ' (detached)'}`];
  let argv: string[] = [];
  if (id === 'branch-create') { const name = await newName(); argv = ['branch', name, commit()]; summary.push(`Create ${name} at ${target}; keep the current checkout.`); }
  else if (id === 'branch-switch') { const name = branch(); unusedBranch(name, true); argv = ['switch', '--no-guess', name]; summary.push(`Switch to ${name}. Git will refuse changes that would overwrite existing edits.`); }
  else if (id === 'branch-rename') { const name = branch(), to = await newName(); unusedBranch(name, true); argv = ['branch', '-m', name, to]; summary.push(`Rename ${name} to ${to}.`); }
  else if (id === 'branch-delete' || id === 'branch-force-delete') { const name = branch(); unusedBranch(name); argv = ['branch', id === 'branch-delete' ? '-d' : '-D', name]; summary.push(`Delete local branch ${name}${id === 'branch-force-delete' ? ', including if it is unmerged' : ' only if Git considers it merged'}.`); }
  else if (id === 'merge') { argv = ['merge', '--no-edit', '--no-autostash', commit()]; summary.push(`Merge ${target} into the current branch using Git's normal merge behavior.`); }
  else if (id === 'rebase') { argv = ['rebase', '--no-autostash', commit()]; summary.push(`Rebase the current branch onto ${target}. This rewrites its affected commits.`); }
  else if (id === 'checkout-detached') { argv = ['switch', '--detach', commit()]; summary.push(`Checkout ${target} with a detached HEAD.`); }
  else if (id === 'cherry-pick' || id === 'revert') {
    const selected = await readCommit(read, repo, commit());
    const mainline: string[] = [];
    if (selected.parents.length > 1) { const parent = Number(value('parent')); if (!Number.isInteger(parent) || parent < 1 || parent > selected.parents.length) throw new Error('Choose an existing mainline parent, numbered from 1.'); mainline.push('-m', String(parent)); }
    argv = [id, '--no-edit', ...mainline, selected.oid]; summary.push(`${id === 'revert' ? 'Create a new commit reversing' : 'Apply and commit'} ${selected.oid}${mainline.length ? ', using parent ' + mainline[1] : ''}.`);
  } else if (id === 'reset') {
    const mode = value('mode'); if (!['soft', 'mixed', 'hard'].includes(mode)) throw new Error('Choose soft, mixed or hard reset.');
    argv = ['reset', '--' + mode, commit()]; summary.push(`Reset ${expected.branch || 'detached HEAD'} to ${target}. ${mode === 'soft' ? 'Keep index and working files.' : mode === 'mixed' ? 'Reset the index; keep working files.' : 'Discard tracked index/worktree changes; untracked paths obstructing the target can also be removed.'}`);
  } else if (id === 'tag-create' || id === 'tag-annotate') {
    const name = await newName('tags'); argv = ['tag', ...(id === 'tag-annotate' ? ['-a', '-m', value('message')] : []), name, commit()]; summary.push(`Create ${id === 'tag-annotate' ? 'annotated' : 'lightweight'} tag ${name} at ${target}. Configured signing remains in effect.`);
  } else if (id === 'tag-delete') { const name = tag(); argv = ['tag', '-d', name]; summary.push(`Delete local tag ${name}. Remote tags are unchanged.`); }
  else if (id === 'tag-push') { const name = tag(), destination = remote(); argv = ['push', '--porcelain', '--no-follow-tags', '--no-mirror', destination.name, `refs/tags/${name}:refs/tags/${name}`]; summary.push(`Push only tag ${name} to ${destination.name}: ${(destination.pushUrls.length ? destination.pushUrls : destination.urls).join(', ')}.`); }
  else if (id === 'stash-create') { argv = ['stash', 'push', '-m', value('message'), ...(values.includeUntracked === 'yes' ? ['--include-untracked'] : [])]; summary.push(`Stash tracked changes${values.includeUntracked === 'yes' ? ' and untracked files' : ''}; remove those changes from this worktree.`); }
  else if (id.startsWith('stash-')) {
    const stash = options.stashes.find(s => s.oid === value('stash')); if (!stash) throw new Error('The selected stash no longer exists.');
    if (id === 'stash-branch') { const name = await newName(); argv = ['stash', 'branch', name, stash.selector]; summary.push(`Create and switch to ${name} at the original base of stash ${stash.oid}; restore its saved working-tree and index changes, then drop its stash entry on success.`); }
    else { const verb = id.slice(6); argv = ['stash', verb, verb === 'apply' ? stash.oid : stash.selector]; summary.push(`${verb === 'drop' ? 'Drop' : 'Apply'} ${stash.selector}, resolved to ${stash.oid}; ${verb === 'apply' ? 'keep its saved stash entry' : verb === 'pop' ? 'remove its stash entry only if application succeeds' : 'remove its saved entry without applying changes'}.`); }
  } else if (id === 'fetch') { const source = remote(); argv = ['fetch', '--no-recurse-submodules', source.name]; summary.push(`Fetch ${source.name}: ${source.urls.join(', ')}. Local ref mappings: ${source.fetchSpecs.join(', ') || 'remote defaults'}. Git fetch/prune configuration applies.`); }
  else if (id === 'pull') { const source = remote(), name = await validateName(value('remoteBranch')), strategy = value('strategy'); if (!['ff-only', 'merge', 'rebase'].includes(strategy)) throw new Error('Choose a pull strategy.'); argv = ['pull', strategy === 'merge' ? '--no-rebase' : '--' + strategy, '--no-edit', '--no-autostash', source.name, `refs/heads/${name}`]; summary.push(`Pull ${source.name}/refs/heads/${name} into ${expected.branch || 'detached HEAD'} using ${strategy}: ${source.urls.join(', ')}.`); }
  else if (id === 'push') { const name = branch(), destination = remote(), to = await validateName(value('remoteBranch')); argv = ['push', '--porcelain', '--no-follow-tags', '--no-mirror', destination.name, `refs/heads/${name}:refs/heads/${to}`]; summary.push(`Push refs/heads/${name} → ${destination.name}:refs/heads/${to}, without force. Destinations: ${(destination.pushUrls.length ? destination.pushUrls : destination.urls).join(', ')}.`); }
  else if (id === 'remote-add' || id === 'remote-edit') {
    const name = id === 'remote-add' ? await validateName(value('name'), 'remotes') : remote().name;
    if (id === 'remote-add' && options.remotes.some(r => r.name === name)) throw new Error('This remote name already exists.');
    const url = value('url'); if (/[\x00-\x1f\x7f]/.test(url) || url.startsWith('-') || url.includes('::')) throw new Error('Enter a Git URL or local path without controls or a remote-helper command.');
    argv = ['remote', id === 'remote-add' ? 'add' : 'set-url', name, url]; summary.push(`${id === 'remote-add' ? 'Add' : 'Set the fetch URL of'} remote ${name}: ${url}.`);
  } else if (id === 'remote-remove') { const name = remote().name; argv = ['remote', 'remove', name]; summary.push(`Remove remote ${name} and its local remote-tracking branches/configuration.`); }
  else if (id === 'discard' || id === 'clean') {
    if (!paths.length || paths.some(path => path.startsWith('/') || path.split('/').includes('..') || path.endsWith('/'))) throw new Error('Select explicit individual file paths first.');
    const status = await readStatus(read, repo);
    for (const path of paths) { const file = status.find(f => f.path === path || f.oldPath === path); if (!file || (id === 'clean' ? file.kind !== 'untracked' : file.kind === 'untracked' || file.kind === 'conflict')) throw new Error('Selected file state changed. Review the working state again.'); }
    if (id === 'clean') argv = ['clean', '-f', '--', ...paths];
    else { const both = values.discardScope === 'both'; if (!['worktree', 'both'].includes(value('discardScope'))) throw new Error('Choose what to discard.'); if (both && !expected.head) throw new Error('Discarding staged changes to HEAD requires an existing commit.'); argv = ['restore', ...(both ? ['--source=HEAD', '--staged', '--worktree'] : ['--worktree']), '--', ...paths]; }
    summary.push(id === 'clean' ? 'Permanently delete these untracked files:' : values.discardScope === 'both' ? 'Discard staged and unstaged changes in these files, restoring HEAD:' : 'Discard unstaged changes in these files, restoring the index:', ...paths);
  } else if (id === 'continue' || id === 'abort') {
    const operation = expected.operation; if (!operation || operation === 'sequencer') throw new Error('No supported in-progress operation was detected. Inspect Git status for a next command.');
    if (id === 'continue' && expected.conflicts.length) throw new Error('Resolve and stage the conflicts before continuing.');
    argv = [...(id === 'continue' ? ['-c', 'core.editor=true'] : []), operation, '--' + id]; summary.push(`${id === 'continue' ? 'Continue with the existing commit message' : 'Ask Git to abort'} the current ${operation}.`);
  }
  if (!argv.length) throw new Error('This action is not implemented.');
  // Re-read after form construction: selections must still belong to the snapshot being reviewed.
  const verified = await actionState(host, pluginRoot, repo, scope, paths);
  if (verified.digest !== expected.digest) throw new Error('Repository state changed while preparing the preview. Preview again.');
  return { id, repository: repo, values: { ...values }, target, paths, scope, expected, argv, summary, nonce };
}

export function actionCommand(pluginRoot: string, intent: ActionIntent): string {
  const request = JSON.stringify({ cwd: intent.repository.root, scope: intent.scope, paths: intent.paths, expected: intent.expected });
  const verify = ['/usr/bin/python3', pluginRoot + '/scripts/git-state.py', 'verify', request].map(shellQuote).join(' ');
  const git = ['git', '--no-pager', '--literal-pathspecs', '-C', intent.repository.root, ...intent.argv].map(shellQuote).join(' ');
  return `( ${verify} && ${git} ) 2>&1; cc_graph_exit=$?; printf '\\nCCGG_RESULT_${intent.nonce}:%s\\n' "$cc_graph_exit"; exit "$cc_graph_exit"`;
}

export async function executeAction(host: ReadHost, pluginRoot: string, intent: ActionIntent, write: (command: string, description: string) => Promise<WriteResult>): Promise<ActionOutcome> {
  let result: WriteResult;
  try { result = await write(actionCommand(pluginRoot, intent), `Git Graph: ${actions.find(action => action[0] === intent.id)?.[1]} in ${intent.repository.root}`); }
  catch (error) { return { status: 'unknown', message: `Execution could not be confirmed. Reconcile the repository before any retry. ${String(error)}` }; }
  if (result.deny) return { status: 'denied', message: result.deny };
  const detail = result.result && typeof result.result === 'object' ? result.result as Record<string, unknown> : {};
  if (detail.interrupted || detail.backgroundTaskId || detail.timedOutAfterMs) return {
    status: 'unknown', message: 'Git was interrupted or moved to a background task. Its outcome is not confirmed. Check the existing task; do not retry it.',
    backgroundTaskId: typeof detail.backgroundTaskId === 'string' ? detail.backgroundTaskId : undefined,
  };
  const text = result.text ?? '';
  const ending = new RegExp(`(?:^|\\n)CCGG_RESULT_${intent.nonce}:(\\d+)\\s*$`).exec(text);
  let state: ActionState | undefined;
  try { state = await actionState(host, pluginRoot, intent.repository, intent.scope, intent.paths); } catch { /* An unavailable post-state cannot prove the operation failed. */ }
  if (!ending) return { status: 'unknown', message: 'The tool did not return a complete execution result. It may still be running or may have changed the repository. No retry was attempted.\n' + text.slice(-8000), state };
  const code = Number(ending[1]);
  if (code === 72 || code === 73) return { status: 'stale', message: 'The checkout or its state changed after preview. The Git operation was not run. Preview the action again.', state };
  if (state?.conflicts.length) {
    const recovery = state.operation && state.operation !== 'sequencer'
      ? 'Resolve the conflicts, then use Continue or Abort.'
      : 'Resolve and stage the conflicted files, then inspect Git status for the next step. No supported Continue or Abort operation is active.';
    return { status: 'conflict', message: `Git stopped in ${state.operation || 'an unresolved state'}. ${recovery}\n${text.slice(-8000)}`, state };
  }
  if (code !== 0 || result.isError) return { status: 'failed', message: text.slice(-8000) || `Git exited ${code}.`, state };
  if (!state) return { status: 'unknown', message: 'Git reported success, but the selected checkout could not be reconciled. Inspect it before retrying.', state };
  return { status: 'succeeded', message: text.replace(ending[0], '').replace(/^CCGG_PRECHECK_OK\n?/, '').trim() || 'Git operation completed.', state };
}
