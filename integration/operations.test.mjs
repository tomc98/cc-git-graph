import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { host as baseHost } from './host.mjs';
import { discoverRepository } from '../hooks/git/repository.ts';
import { createGitReader } from '../hooks/git/read.ts';
import { prepareAction, executeAction, actionCommand, actionOptions } from '../hooks/git/operations.ts';

const exec = promisify(execFile);
const pluginRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const host = { ...baseHost, run: (args, options = {}) => baseHost.run(args, { ...options, env: { ...options.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }) };
const read = createGitReader(host, pluginRoot);
let sequence = 0;

async function fixture(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'cc-git-graph-action-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', ['-C', path, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, maxBuffer: 4 * 1024 * 1024 })).stdout.trimEnd();
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'commit.gpgSign', 'false');
  await writeFile(join(path, 'file.txt'), 'root\n'); await git('add', 'file.txt'); await git('commit', '-m', 'Root');
  const repo = await discoverRepository(host, path);
  const write = async command => { const result = await host.run(['/bin/sh', '-c', command], { cwd: path, timeoutMs: 30000 }); return { text: result.stdout, isError: result.exitCode !== 0 }; };
  const prepare = async (id, values = {}, target, paths = []) => prepareAction(host, read, pluginRoot, repo, id, values, target ?? await git('rev-parse', 'HEAD'), paths, 't' + (++sequence));
  const perform = async (id, values = {}, target, paths = []) => { const intent = await prepare(id, values, target, paths); const result = await executeAction(host, pluginRoot, intent, write); assert.equal(result.status, 'succeeded', result.message); return result; };
  return { path, git, repo, write, prepare, perform };
}

test('branch creation, switch hooks, rename and deletion use the reviewed target', async t => {
  const f = await fixture(t);
  const hook = join(f.path, '.git/hooks/post-checkout'); await writeFile(hook, '#!/bin/sh\nprintf hook > .git/hook-marker\n'); await chmod(hook, 0o755);
  await f.perform('branch-create', { name: "feature/quote'and$(literal)" });
  await f.perform('branch-switch', { branch: "feature/quote'and$(literal)" });
  assert.equal(await readFile(join(f.path, '.git/hook-marker'), 'utf8'), 'hook');
  assert.equal(await f.git('branch', '--show-current'), "feature/quote'and$(literal)");
  await f.perform('branch-rename', { branch: "feature/quote'and$(literal)", name: 'renamed' });
  await f.perform('branch-switch', { branch: 'main' }); await f.perform('branch-delete', { branch: 'renamed' });
  assert.equal((await f.git('branch', '--list', 'renamed')), '');
});

test('stale approvals are rejected in the command, after preview and permission waiting', async t => {
  const f = await fixture(t);
  const intent = await f.prepare('branch-create', { name: 'must-not-exist' });
  await f.git('branch', 'concurrent');
  const result = await executeAction(host, pluginRoot, intent, f.write);
  assert.equal(result.status, 'stale'); assert.equal(await f.git('branch', '--list', 'must-not-exist'), '');
  const denied = await executeAction(host, pluginRoot, await f.prepare('branch-create', { name: 'denied' }), async () => ({ deny: 'Fixture policy' }));
  assert.equal(denied.status, 'denied'); assert.equal(await f.git('branch', '--list', 'denied'), '');
});

test('a branch occupied by another worktree cannot be switched, renamed or deleted', async t => {
  const f = await fixture(t); const path = f.path + '-linked'; t.after(() => rm(path, { recursive: true, force: true }));
  await f.git('worktree', 'add', '-b', 'occupied', path);
  for (const id of ['branch-switch', 'branch-rename', 'branch-delete', 'branch-force-delete']) await assert.rejects(f.prepare(id, { branch: 'occupied', name: 'different' }), /checked out/);
});

test('selected tracked/untracked paths are literal and edits after preview stop discard', async t => {
  const f = await fixture(t);
  await writeFile(join(f.path, 'file.txt'), 'first edit\n');
  const intent = await f.prepare('discard', { discardScope: 'worktree' }, undefined, ['file.txt']);
  await writeFile(join(f.path, 'file.txt'), 'different edit\n');
  assert.equal((await executeAction(host, pluginRoot, intent, f.write)).status, 'stale');
  assert.equal(await readFile(join(f.path, 'file.txt'), 'utf8'), 'different edit\n');
  await f.perform('discard', { discardScope: 'worktree' }, undefined, ['file.txt']);
  assert.equal(await readFile(join(f.path, 'file.txt'), 'utf8'), 'root\n');
  const name = 'literal\nquote\'$(no-run).txt'; await writeFile(join(f.path, name), 'untracked'); await writeFile(join(f.path, 'keep.txt'), 'keep');
  await f.perform('clean', {}, undefined, [name]);
  await assert.rejects(readFile(join(f.path, name)), /ENOENT/); assert.equal(await readFile(join(f.path, 'keep.txt'), 'utf8'), 'keep');
});

test('stash identity survives selection and a changed stash list invalidates pop/drop', async t => {
  const f = await fixture(t);
  await writeFile(join(f.path, 'file.txt'), 'stashed\n'); await f.perform('stash-create', { message: 'Selected stash', includeUntracked: 'no' });
  const stash = (await actionOptions(read, f.repo)).stashes[0];
  const stale = await f.prepare('stash-drop', { stash: stash.oid });
  await writeFile(join(f.path, 'file.txt'), 'newer\n'); await f.git('stash', 'push', '-m', 'Newer stash');
  assert.equal((await executeAction(host, pluginRoot, stale, f.write)).status, 'stale');
  await f.perform('stash-apply', { stash: stash.oid }); assert.equal(await readFile(join(f.path, 'file.txt'), 'utf8'), 'stashed\n');
  await f.perform('discard', { discardScope: 'worktree' }, undefined, ['file.txt']);
  await f.perform('stash-pop', { stash: stash.oid });
  assert.equal((await actionOptions(read, f.repo)).stashes.length, 1);
});

test('interrupted and missing execution results never trigger an automatic retry', async t => {
  const f = await fixture(t); const intent = await f.prepare('branch-create', { name: 'unknown' }); let writes = 0;
  const unknown = await executeAction(host, pluginRoot, intent, async () => { writes++; return { result: { backgroundTaskId: 'existing-task', interrupted: false }, text: 'Still running' }; });
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.backgroundTaskId, 'existing-task'); assert.equal(writes, 1);
  assert.equal(await f.git('branch', '--list', 'unknown'), '');
});

test('normal deletion refuses an unmerged branch; force deletion is a separate preview', async t => {
  const f = await fixture(t); await f.git('switch', '-c', 'unmerged');
  await writeFile(join(f.path, 'topic'), 'topic'); await f.git('add', 'topic'); await f.git('commit', '-m', 'Unmerged work'); await f.git('switch', 'main');
  const normal = await executeAction(host, pluginRoot, await f.prepare('branch-delete', { branch: 'unmerged' }), f.write);
  assert.equal(normal.status, 'failed'); assert.match(await f.git('branch', '--list', 'unmerged'), /unmerged/);
  await f.perform('branch-force-delete', { branch: 'unmerged' }); assert.equal(await f.git('branch', '--list', 'unmerged'), '');
});

test('cherry-pick, revert, detached checkout and explicit reset modes have distinct effects', async t => {
  const f = await fixture(t); const root = await f.git('rev-parse', 'HEAD'); await f.git('switch', '-c', 'topic');
  await writeFile(join(f.path, 'file.txt'), 'topic\n'); await f.git('add', 'file.txt'); await f.git('commit', '-m', 'Topic'); const topic = await f.git('rev-parse', 'HEAD');
  await f.git('switch', 'main'); await f.perform('cherry-pick', {}, topic); assert.equal(await readFile(join(f.path, 'file.txt'), 'utf8'), 'topic\n');
  await f.perform('revert', {}, topic); assert.equal(await readFile(join(f.path, 'file.txt'), 'utf8'), 'root\n');
  await f.perform('checkout-detached', {}, topic); assert.equal(await f.git('branch', '--show-current'), '');
  await f.perform('reset', { mode: 'soft' }, root); assert.equal(await readFile(join(f.path, 'file.txt'), 'utf8'), 'topic\n'); assert.equal(await f.git('diff', '--cached', '--name-only'), 'file.txt');
  await f.perform('reset', { mode: 'mixed' }, root); assert.equal(await f.git('diff', '--cached', '--name-only'), ''); assert.equal(await readFile(join(f.path, 'file.txt'), 'utf8'), 'topic\n');
  await f.perform('reset', { mode: 'hard' }, root); assert.equal(await readFile(join(f.path, 'file.txt'), 'utf8'), 'root\n');
});

test('merge and rebase use selected commits and retain the current branch', async t => {
  const f = await fixture(t); await f.git('branch', 'topic');
  await writeFile(join(f.path, 'main.txt'), 'main'); await f.git('add', 'main.txt'); await f.git('commit', '-m', 'Main change'); const main = await f.git('rev-parse', 'HEAD');
  await f.git('switch', 'topic'); await writeFile(join(f.path, 'topic.txt'), 'topic'); await f.git('add', 'topic.txt'); await f.git('commit', '-m', 'Topic change');
  await f.perform('rebase', {}, main); assert.equal(await f.git('rev-parse', 'HEAD^'), main); assert.equal(await f.git('branch', '--show-current'), 'topic');
  const rebased = await f.git('rev-parse', 'HEAD'); await f.git('switch', 'main'); await f.perform('merge', {}, rebased);
  assert.equal(await f.git('rev-parse', 'HEAD'), rebased); assert.equal(await f.git('branch', '--show-current'), 'main');
});

test('conflicts support abort and resolved continuation without pretending they succeeded', async t => {
  const f = await fixture(t); await f.git('branch', 'topic');
  await writeFile(join(f.path, 'file.txt'), 'main\n'); await f.git('add', 'file.txt'); await f.git('commit', '-m', 'Main');
  await f.git('switch', 'topic'); await writeFile(join(f.path, 'file.txt'), 'topic\n'); await f.git('add', 'file.txt'); await f.git('commit', '-m', 'Topic'); const topic = await f.git('rev-parse', 'HEAD'); await f.git('switch', 'main');
  let result = await executeAction(host, pluginRoot, await f.prepare('merge', {}, topic), f.write);
  assert.equal(result.status, 'conflict'); assert.equal(result.state.operation, 'merge');
  await assert.rejects(f.prepare('continue'), /Resolve and stage/);
  await f.perform('abort'); assert.equal(await readFile(join(f.path, 'file.txt'), 'utf8'), 'main\n');
  result = await executeAction(host, pluginRoot, await f.prepare('merge', {}, topic), f.write); assert.equal(result.status, 'conflict');
  await writeFile(join(f.path, 'file.txt'), 'resolved\n'); await f.git('add', 'file.txt'); await f.perform('continue');
  assert.equal((await f.git('rev-list', '--parents', '-n', '1', 'HEAD')).split(' ').length, 3);
});

test('tags and remote operations use local bare remotes, and rejected pushes never force', async t => {
  const f = await fixture(t); const remote = f.path + '-remote'; t.after(() => rm(remote, { recursive: true, force: true }));
  await exec('git', ['init', '--bare', '-b', 'main', remote]);
  await f.perform('remote-add', { name: 'origin', url: remote }); await f.perform('push', { branch: 'main', remote: 'origin', remoteBranch: 'main' });
  await f.perform('tag-create', { name: 'light' }); await f.perform('tag-annotate', { name: 'annotated', message: "Release ' $(literal)" });
  await f.perform('tag-push', { tag: 'annotated', remote: 'origin' });
  assert.equal((await exec('git', ['--git-dir=' + remote, 'cat-file', '-t', 'refs/tags/annotated'])).stdout.trim(), 'tag');
  await assert.rejects(exec('git', ['--git-dir=' + remote, 'rev-parse', '--verify', 'refs/tags/light']));
  await f.perform('tag-delete', { tag: 'light' });
  const other = f.path + '-other'; t.after(() => rm(other, { recursive: true, force: true })); await exec('git', ['clone', remote, other]);
  const otherGit = (...args) => exec('git', ['-C', other, '-c', 'commit.gpgSign=false', '-c', 'user.name=Other', '-c', 'user.email=other@example.invalid', ...args]);
  await writeFile(join(other, 'other.txt'), 'remote advance'); await otherGit('add', 'other.txt'); await otherGit('commit', '-m', 'Remote advance'); await otherGit('push', 'origin', 'main');
  const rejected = await executeAction(host, pluginRoot, await f.prepare('push', { branch: 'main', remote: 'origin', remoteBranch: 'main' }), f.write);
  assert.equal(rejected.status, 'failed'); assert.match(rejected.message, /rejected|fetch first/);
  await f.perform('fetch', { remote: 'origin' }); await f.perform('pull', { remote: 'origin', remoteBranch: 'main', strategy: 'ff-only' });
  assert.equal(await readFile(join(f.path, 'other.txt'), 'utf8'), 'remote advance');
  await f.perform('remote-edit', { remote: 'origin', url: remote + '/' }); assert.equal((await actionOptions(read, f.repo)).remotes[0].urls[0], remote + '/');
  await f.perform('remote-remove', { remote: 'origin' }); assert.equal((await actionOptions(read, f.repo)).remotes.length, 0);
});

test('stash branch/drop and staged discard apply to the selected saved state', async t => {
  const f = await fixture(t); await writeFile(join(f.path, 'file.txt'), 'saved\n');
  await f.perform('stash-create', { message: 'Saved', includeUntracked: 'no' }); let stash = (await actionOptions(read, f.repo)).stashes[0];
  const base = await f.git('rev-parse', 'HEAD');
  await writeFile(join(f.path, 'file.txt'), 'later main change\n'); await f.git('add', 'file.txt'); await f.git('commit', '-m', 'Advance after stashing');
  const advanced = await f.git('rev-parse', 'HEAD');
  await f.perform('stash-branch', { stash: stash.oid, name: 'from-stash' });
  assert.equal(await f.git('branch', '--show-current'), 'from-stash');
  assert.equal(await f.git('rev-parse', 'HEAD'), base);
  assert.equal(await f.git('rev-parse', 'main'), advanced);
  assert.equal(await readFile(join(f.path, 'file.txt'), 'utf8'), 'saved\n');
  assert.equal((await actionOptions(read, f.repo)).stashes.length, 0);
  await f.git('add', 'file.txt'); await f.perform('discard', { discardScope: 'both' }, undefined, ['file.txt']); assert.equal(await f.git('status', '--porcelain'), '');
  await writeFile(join(f.path, 'untracked.txt'), 'saved untracked'); await f.perform('stash-create', { message: 'Untracked', includeUntracked: 'yes' }); stash = (await actionOptions(read, f.repo)).stashes[0];
  await f.perform('stash-drop', { stash: stash.oid }); assert.equal((await actionOptions(read, f.repo)).stashes.length, 0);
});

test('configured SSH signing is preserved by the actual Git write command', async t => {
  const f = await fixture(t); await writeFile(join(f.path, 'file.txt'), 'signed change\n'); await f.git('add', 'file.txt'); await f.git('commit', '-m', 'Change to revert'); const target = await f.git('rev-parse', 'HEAD');
  const key = join(f.path, '.git/signing-key'); await exec('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const publicKey = await readFile(key + '.pub', 'utf8'); await writeFile(join(f.path, '.git/allowed-signers'), 'fixture@example.invalid ' + publicKey);
  await f.git('config', 'gpg.format', 'ssh'); await f.git('config', 'user.signingkey', key); await f.git('config', 'gpg.ssh.allowedSignersFile', join(f.path, '.git/allowed-signers')); await f.git('config', 'commit.gpgSign', 'true');
  await f.perform('revert', {}, target); await f.git('verify-commit', 'HEAD');
  assert.match(await f.git('cat-file', '-p', 'HEAD'), /gpgsig -----BEGIN SSH SIGNATURE-----/);
});

test('index locks and hook failure remain failures and their files are retained', async t => {
  const f = await fixture(t); await f.git('branch', 'topic');
  await writeFile(join(f.path, '.git/index.lock'), 'fixture lock');
  const locked = await executeAction(host, pluginRoot, await f.prepare('branch-switch', { branch: 'topic' }), f.write);
  assert.equal(locked.status, 'failed'); assert.match(locked.message, /index.lock/); assert.equal(await readFile(join(f.path, '.git/index.lock'), 'utf8'), 'fixture lock'); await rm(join(f.path, '.git/index.lock'));
  await writeFile(join(f.path, 'main.txt'), 'main'); await f.git('add', '.'); await f.git('commit', '-m', 'Main');
  await f.git('switch', 'topic'); await writeFile(join(f.path, 'topic.txt'), 'topic'); await f.git('add', '.'); await f.git('commit', '-m', 'Topic'); const topic = await f.git('rev-parse', 'HEAD'); await f.git('switch', 'main');
  const hook = join(f.path, '.git/hooks/pre-merge-commit'); await writeFile(hook, '#!/bin/sh\necho FIXTURE_HOOK_REJECTED >&2\nexit 1\n'); await chmod(hook, 0o755);
  const rejected = await executeAction(host, pluginRoot, await f.prepare('merge', {}, topic), f.write);
  assert.equal(rejected.status, 'failed'); assert.match(rejected.message, /FIXTURE_HOOK_REJECTED/); assert.equal(rejected.state.operation, 'merge'); assert.equal(rejected.state.conflicts.length, 0);
});

test('explicit pull strategies resolve divergence without inheriting a conflicting default', async t => {
  for (const strategy of ['ff-only', 'merge', 'rebase']) await t.test(strategy, async t => {
    const f = await fixture(t), remote = f.path + '-remote';
    t.after(() => rm(remote, { recursive: true, force: true }));
    await exec('git', ['init', '--bare', '-b', 'main', remote]);
    await f.git('remote', 'add', 'origin', remote); await f.git('push', 'origin', 'main');
    await f.git('switch', '-c', 'remote-next');
    await writeFile(join(f.path, 'remote.txt'), 'remote\n'); await f.git('add', 'remote.txt'); await f.git('commit', '-m', 'Remote change');
    const remoteHead = await f.git('rev-parse', 'HEAD'); await f.git('push', 'origin', 'HEAD:main');
    await f.git('switch', 'main');
    await writeFile(join(f.path, 'local.txt'), 'local\n'); await f.git('add', 'local.txt'); await f.git('commit', '-m', 'Local change');
    const localHead = await f.git('rev-parse', 'HEAD');
    await f.git('config', 'pull.ff', 'only'); await f.git('config', 'pull.rebase', strategy === 'rebase' ? 'false' : 'true');
    let writes = 0;
    const intent = await f.prepare('pull', { remote: 'origin', remoteBranch: 'main', strategy });
    const outcome = await executeAction(host, pluginRoot, intent, async command => { writes++; return f.write(command); });
    assert.equal(writes, 1);
    if (strategy === 'ff-only') {
      assert.equal(outcome.status, 'failed', outcome.message);
      assert.equal(await f.git('rev-parse', 'HEAD'), localHead);
      assert.equal(await f.git('status', '--porcelain'), '');
    } else {
      assert.equal(outcome.status, 'succeeded', outcome.message);
      const parents = (await f.git('show', '-s', '--format=%P', 'HEAD')).split(' ');
      assert.deepEqual(parents, strategy === 'merge' ? [localHead, remoteHead] : [remoteHead]);
      assert.equal(await readFile(join(f.path, 'local.txt'), 'utf8'), 'local\n');
      assert.equal(await readFile(join(f.path, 'remote.txt'), 'utf8'), 'remote\n');
      assert.equal(await f.git('status', '--porcelain'), '');
    }
  });
});

test('merge cherry-pick and revert require and honor the selected mainline parent', async t => {
  const f = await fixture(t);
  await f.git('switch', '-c', 'side'); await writeFile(join(f.path, 'side.txt'), 'side\n'); await f.git('add', 'side.txt'); await f.git('commit', '-m', 'Side');
  const second = await f.git('rev-parse', 'HEAD');
  await f.git('switch', 'main'); await writeFile(join(f.path, 'main.txt'), 'main\n'); await f.git('add', 'main.txt'); await f.git('commit', '-m', 'Main');
  const first = await f.git('rev-parse', 'HEAD');
  await f.git('merge', '--no-ff', '--no-edit', 'side'); const merge = await f.git('rev-parse', 'HEAD');
  for (const action of ['cherry-pick', 'revert']) {
    for (const parent of ['', '0', '3', '1.5']) await assert.rejects(f.prepare(action, { parent }, merge), /Enter parent|mainline parent/);
    for (const [index, base] of [first, second].entries()) {
      const parent = String(index + 1);
      await f.git('switch', '-c', action + '-' + parent, action === 'revert' ? merge : base);
      const intent = await f.prepare(action, { parent }, merge);
      assert.match(intent.summary.join('\n'), new RegExp('using parent ' + parent));
      const outcome = await executeAction(host, pluginRoot, intent, f.write);
      assert.equal(outcome.status, 'succeeded', outcome.message);
      assert.equal(await f.git('rev-parse', 'HEAD^{tree}'), await f.git('rev-parse', (action === 'revert' ? base : merge) + '^{tree}'));
    }
  }
});

test('signing failure reports failure and retains the pending Git state without another write', async t => {
  const f = await fixture(t);
  await writeFile(join(f.path, 'file.txt'), 'change\n'); await f.git('add', 'file.txt'); await f.git('commit', '-m', 'Change');
  const target = await f.git('rev-parse', 'HEAD');
  await f.git('config', 'gpg.format', 'ssh'); await f.git('config', 'user.signingkey', join(f.path, '.git/nonexistent-signing-key')); await f.git('config', 'commit.gpgSign', 'true');
  let writes = 0;
  const outcome = await executeAction(host, pluginRoot, await f.prepare('revert', {}, target), async command => { writes++; return f.write(command); });
  assert.equal(outcome.status, 'failed', outcome.message); assert.equal(writes, 1);
  assert.match(outcome.message, /sign|key/i); assert.equal(await f.git('rev-parse', 'HEAD'), target);
  assert.notEqual(await f.git('status', '--porcelain'), '');
  assert.equal(await readFile(join(f.path, 'file.txt'), 'utf8'), 'root\n');
  assert.equal(outcome.state.operation, null);
  await assert.rejects(f.prepare('continue'), /No supported in-progress operation/);
  assert.match(await f.git('diff', '--cached', '--', 'file.txt'), /\+root/);
});

test('SSH transport authentication refusal remains a single failed fetch with no repository retry', async t => {
  const f = await fixture(t), transport = join(f.path, '.git/ssh-refusal');
  await writeFile(transport, '#!/bin/sh\nprintf "attempt\\n" >> "' + f.path + '/.git/auth-attempts"\nprintf "Permission denied (publickey).\\n" >&2\nexit 255\n'); await chmod(transport, 0o755);
  await f.git('config', 'core.sshCommand', transport); await f.git('config', 'ssh.variant', 'ssh');
  await f.git('remote', 'add', 'origin', 'ssh://fixture.invalid/repo.git');
  const before = await f.git('rev-parse', 'HEAD'); let writes = 0;
  const outcome = await executeAction(host, pluginRoot, await f.prepare('fetch', { remote: 'origin' }), async command => { writes++; return f.write(command); });
  assert.equal(outcome.status, 'failed', outcome.message); assert.match(outcome.message, /Permission denied/); assert.equal(writes, 1);
  assert.equal(await readFile(join(f.path, '.git/auth-attempts'), 'utf8'), 'attempt\n');
  assert.equal(await f.git('rev-parse', 'HEAD'), before); assert.equal(await f.git('status', '--porcelain'), '');
});

test('multi-commit rebase conflict recovery preserves abort and repeated Continue semantics', async t => {
  const f = await fixture(t);
  await f.git('switch', '-c', 'topic');
  for (const [content, message] of [['topic one\n', 'Topic one'], ['topic two\n', 'Topic two']]) {
    await writeFile(join(f.path, 'file.txt'), content); await f.git('add', 'file.txt'); await f.git('commit', '-m', message);
  }
  const original = await f.git('rev-parse', 'HEAD');
  await f.git('switch', 'main'); await writeFile(join(f.path, 'file.txt'), 'main change\n');
  await f.git('add', 'file.txt'); await f.git('commit', '-m', 'Main advance');
  const main = await f.git('rev-parse', 'HEAD'); await f.git('switch', 'topic');
  const start = async () => executeAction(host, pluginRoot, await f.prepare('rebase', {}, main), f.write);
  let result = await start();
  assert.equal(result.status, 'conflict'); assert.equal(result.state.operation, 'rebase');
  await assert.rejects(f.prepare('continue'), /Resolve and stage/);
  await f.perform('abort');
  assert.equal(await f.git('rev-parse', 'HEAD'), original);
  assert.equal(await f.git('branch', '--show-current'), 'topic');
  assert.equal(await f.git('status', '--porcelain'), '');
  result = await start(); assert.equal(result.status, 'conflict');
  await writeFile(join(f.path, 'file.txt'), 'resolved first\n'); await f.git('add', 'file.txt');
  result = await executeAction(host, pluginRoot, await f.prepare('continue'), f.write);
  assert.equal(result.status, 'conflict'); assert.equal(result.state.operation, 'rebase');
  await assert.rejects(f.prepare('continue'), /Resolve and stage/);
  await writeFile(join(f.path, 'file.txt'), 'resolved second\n'); await f.git('add', 'file.txt');
  await f.perform('continue');
  assert.equal(await f.git('branch', '--show-current'), 'topic');
  assert.equal(await f.git('rev-parse', 'HEAD~2'), main);
  assert.equal(await f.git('log', '-2', '--format=%s'), 'Topic two\nTopic one');
  assert.equal(await readFile(join(f.path, 'file.txt'), 'utf8'), 'resolved second\n');
  assert.equal(await f.git('status', '--porcelain'), '');
  await assert.rejects(f.prepare('continue'), /No supported in-progress operation/);
});

for (const operation of ['cherry-pick', 'revert']) {
  test(`${operation} conflict Abort and Continue preserve the intended branch and commit`, async t => {
    const f = await fixture(t);
    await f.git('switch', '-c', 'topic');
    await writeFile(join(f.path, 'file.txt'), 'topic change\n'); await f.git('add', 'file.txt'); await f.git('commit', '-m', 'Selected topic change');
    const selected = await f.git('rev-parse', 'HEAD');
    if (operation === 'cherry-pick') await f.git('switch', 'main');
    await writeFile(join(f.path, 'file.txt'), 'conflicting later change\n'); await f.git('add', 'file.txt'); await f.git('commit', '-m', 'Later change');
    const before = await f.git('rev-parse', 'HEAD'), branch = await f.git('branch', '--show-current');
    const start = async () => executeAction(host, pluginRoot, await f.prepare(operation, {}, selected), f.write);
    let result = await start();
    assert.equal(result.status, 'conflict'); assert.equal(result.state.operation, operation);
    await assert.rejects(f.prepare('continue'), /Resolve and stage/);
    await f.perform('abort');
    assert.equal(await f.git('rev-parse', 'HEAD'), before);
    assert.equal(await f.git('branch', '--show-current'), branch);
    assert.equal(await readFile(join(f.path, 'file.txt'), 'utf8'), 'conflicting later change\n');
    assert.equal(await f.git('status', '--porcelain'), '');
    result = await start(); assert.equal(result.status, 'conflict');
    await writeFile(join(f.path, 'file.txt'), 'explicit resolution\n'); await f.git('add', 'file.txt');
    await f.perform('continue');
    assert.equal(await f.git('rev-parse', 'HEAD^'), before);
    assert.equal(await f.git('branch', '--show-current'), branch);
    assert.equal(await f.git('log', '-1', '--format=%s'), operation === 'revert' ? 'Revert "Selected topic change"' : 'Selected topic change');
    assert.equal(await readFile(join(f.path, 'file.txt'), 'utf8'), 'explicit resolution\n');
    assert.equal(await f.git('status', '--porcelain'), '');
    await assert.rejects(f.prepare('continue'), /No supported in-progress operation/);
  });
}

for (const operation of ['stash-apply', 'stash-pop']) {
  test(`${operation} conflicts retain the stash without advertising sequencer recovery`, async t => {
    const f = await fixture(t);
    await writeFile(join(f.path, 'file.txt'), 'saved change\n');
    await f.perform('stash-create', { message: 'Conflicting saved change', includeUntracked: 'no' });
    const stash = (await actionOptions(read, f.repo)).stashes[0];
    await writeFile(join(f.path, 'file.txt'), 'later committed change\n'); await f.git('add', 'file.txt'); await f.git('commit', '-m', 'Advance before restoring stash');
    const result = await executeAction(host, pluginRoot, await f.prepare(operation, { stash: stash.oid }), f.write);
    assert.equal(result.status, 'conflict');
    assert.equal(result.state.operation, null);
    assert.deepEqual(result.state.conflicts, ['file.txt']);
    assert.equal((await actionOptions(read, f.repo)).stashes[0].oid, stash.oid);
    assert.doesNotMatch(result.message, /then use Continue or Abort/);
    assert.match(result.message, /Resolve and stage/);
    await assert.rejects(f.prepare('continue'), /No supported in-progress operation/);
    await assert.rejects(f.prepare('abort'), /No supported in-progress operation/);
  });
}
