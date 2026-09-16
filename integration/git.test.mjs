import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, access, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ReadQueue } from '../hooks/host.ts';
import { discoverRepository } from '../hooks/git/repository.ts';
import { createGitReader } from '../hooks/git/read.ts';
import { nextPage, startSnapshot } from '../hooks/git/history.ts';
import { readStatus } from '../hooks/git/status.ts';
import { layout } from '../hooks/graph/layout.ts';
import { readWorktrees } from '../hooks/git/worktrees.ts';

const exec = promisify(execFile);
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
import { host } from './host.mjs';

const read = createGitReader(host, root);

async function fixture(t, format = 'sha1') {
  const path = await mkdtemp(join(tmpdir(), 'cc-git-graph-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', ['-C', path, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, maxBuffer: 4 * 1024 * 1024 })).stdout.trimEnd();
  await git('init', '-b', 'main', '--object-format=' + format);
  await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'commit.gpgSign', 'false');
  await writeFile(join(path, 'hello.txt'), 'hello\n');
  await git('add', '--', 'hello.txt'); await git('commit', '-m', 'Root');
  return { path, git };
}

test('discovery distinguishes linked worktrees while retaining their common directory', async t => {
  const f = await fixture(t);
  const worktree = f.path + '-linked'; t.after(() => rm(worktree, { recursive: true, force: true }));
  await f.git('worktree', 'add', '-b', 'linked', worktree);
  const [a, b] = await Promise.all([discoverRepository(host, f.path), discoverRepository(host, worktree)]);
  assert.notEqual(a.identity, b.identity);
  assert.equal(a.commonDir, b.commonDir);
  assert.notEqual(a.gitDir, b.gitDir);
  const listed = await readWorktrees(read, a);
  assert.equal(listed.length, 2);
  assert.ok(listed.some(worktree => worktree.path === b.root && worktree.branch === 'refs/heads/linked'));
  const alias = f.path + '-alias'; t.after(() => rm(alias, { force: true })); await symlink(f.path, alias);
  assert.equal((await discoverRepository(host, alias)).identity, a.identity);
});

test('stable history pages survive branch movement and match Git object ancestry', async t => {
  const f = await fixture(t);
  const tree = await f.git('rev-parse', 'HEAD^{tree}');
  let parent = await f.git('rev-parse', 'HEAD');
  for (let i = 0; i < 205; i++) parent = await f.git('commit-tree', tree, '-p', parent, '-m', `Commit ${i}`);
  await f.git('update-ref', 'refs/heads/main', parent);
  const repo = await discoverRepository(host, f.path);
  const initial = await nextPage(read, repo, await startSnapshot(read, repo));
  assert.equal(initial.commits.length, 200); assert.equal(initial.hasMore, true);
  const boundaryCommit = initial.commits.at(-1);
  assert.deepEqual(layout(initial.commits).at(-1).boundary, boundaryCommit.parents);
  const advanced = await f.git('commit-tree', tree, '-p', parent, '-m', 'Moved after snapshot');
  await f.git('update-ref', 'refs/heads/main', advanced);
  const all = await nextPage(read, repo, initial);
  const oracle = (await f.git('rev-list', '--topo-order', '--parents', parent)).split('\n').map(line => line.split(' '));
  assert.deepEqual(all.commits.map(c => [c.oid, ...c.parents]), oracle);
  assert.equal(all.commits.length, 206); assert.equal(all.hasMore, false);
  assert.equal(new Set(all.commits.map(c => c.oid)).size, 206);
  assert.deepEqual(layout(all.commits).find(row => row.oid === boundaryCommit.oid).boundary, [], 'loading the next page reconnects the previously missing parent');
  assert.deepEqual(layout(all.commits).slice(0, 199), layout(initial.commits).slice(0, 199));
});

test('status preserves newline, tab, Unicode and rename paths', async t => {
  const f = await fixture(t);
  const strange = 'a tab\tand newline\n雪.txt';
  await f.git('mv', 'hello.txt', strange);
  await writeFile(join(f.path, strange), 'hello\nchanged\n');
  await writeFile(join(f.path, 'untracked.txt'), 'not tracked');
  const status = await readStatus(read, await discoverRepository(host, f.path));
  const renamed = status.find(item => item.path === strange);
  assert.equal(renamed.oldPath, 'hello.txt'); assert.equal(renamed.index, 'R'); assert.equal(renamed.worktree, 'M');
  assert.equal(status.find(item => item.path === 'untracked.txt').kind, 'untracked');
});

test('the bounded read envelope identifies truncation even at a complete newline', async t => {
  const f = await fixture(t);
  await writeFile(join(f.path, 'hello.txt'), 'line\n'.repeat(100000));
  const result = await read(f.path, ['diff', '--no-ext-diff', '--no-textconv', '--', 'hello.txt'], { limit: 256 });
  assert.equal(result.exitCode, 0); assert.equal(result.stdoutComplete, false);
  assert.ok(result.stdoutTotalBytes > 256);
  const clippedHost = { ...host, run: async () => ({ exitCode: 0, stdout: '{"version":1,"stdout":"complete-looking\\n"', stderr: '' }) };
  await assert.rejects(createGitReader(clippedHost, root)(f.path, ['status']), /Incomplete read envelope/);
});

test('SHA-256 histories retain full identifiers', async t => {
  const f = await fixture(t, 'sha256');
  const repo = await discoverRepository(host, f.path);
  const snapshot = await nextPage(read, repo, await startSnapshot(read, repo));
  assert.equal(snapshot.commits[0].oid.length, 64);
  assert.equal(repo.objectFormat, 'sha256');
});

test('bare repository discovery and history do not require a working tree', async t => {
  const f = await fixture(t);
  const bare = f.path + '-bare'; t.after(() => rm(bare, { recursive: true, force: true }));
  await exec('git', ['clone', '--bare', '--no-hardlinks', f.path, bare]);
  const repo = await discoverRepository(host, bare);
  assert.equal(repo.bare, true); assert.equal(repo.root, repo.gitDir);
  assert.equal((await nextPage(read, repo, await startSnapshot(read, repo))).commits.length, 1);
  assert.deepEqual(await readStatus(read, repo), []);
});

test('the read queue never exceeds two concurrent child processes', async () => {
  const queue = new ReadQueue(); let active = 0, maximum = 0;
  await Promise.all(Array.from({ length: 20 }, () => queue.run(async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
  })));
  assert.equal(maximum, 2);
});

test('graph lanes retain real parent targets, including octopus and disconnected roots', () => {
  const commits = [{ oid: 'merge', parents: ['a', 'b', 'c'] }, { oid: 'a', parents: ['root'] }, { oid: 'b', parents: ['root'] }, { oid: 'c', parents: ['root'] }, { oid: 'root', parents: [] }, { oid: 'separate', parents: ['outside'] }];
  const graph = layout(commits);
  for (const [index, row] of graph.entries()) {
    assert.deepEqual(row.edges.filter(e => e.from === row.lane).map(e => e.target), commits[index].parents);
    for (const edge of row.edges) assert.equal(row.next[edge.to], edge.target);
  }
  assert.deepEqual(graph.at(-1).boundary, ['outside']);
  assert.deepEqual(graph, layout(commits));
});
