import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { host } from './host.mjs';
import { discoverRepository } from '../hooks/git/repository.ts';
import { createGitReader } from '../hooks/git/read.ts';
import { endpoints, readCommit, readChangedFiles, readPatch } from '../hooks/git/details.ts';
import { startSnapshot, nextPage } from '../hooks/git/history.ts';
import { layout } from '../hooks/graph/layout.ts';

const exec = promisify(execFile);
const read = createGitReader(host, new URL('..', import.meta.url).pathname.replace(/\/$/, ''));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cc-git-graph-diff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', ['-C', root, '-c', 'commit.gpgSign=false', ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, maxBuffer: 4 * 1024 * 1024 })).stdout.trimEnd();
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  return { root, git };
}

test('a partial clone browses local history but reports missing blobs without lazy network fetches', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'promised.txt'), 'blob deliberately omitted from the clone\n');
  await f.git('add', 'promised.txt'); await f.git('commit', '-m', 'Promised blob');
  const oid = await f.git('rev-parse', 'HEAD'), blob = await f.git('rev-parse', 'HEAD:promised.txt');
  await f.git('config', 'uploadpack.allowFilter', 'true');
  const clone = f.root + '-partial'; t.after(() => rm(clone, { recursive: true, force: true }));
  await exec('git', ['clone', '--no-checkout', '--filter=blob:none', 'file://' + f.root, clone], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  const git = (...args) => exec('git', ['-C', clone, ...args]);
  const marker = join(clone, '.git/lazy-fetch-attempt'), transport = join(clone, '.git/no-network');
  await writeFile(transport, '#!/bin/sh\nprintf attempted > "' + marker + '"\nexit 255\n'); await chmod(transport, 0o755);
  await git('config', 'core.sshCommand', transport); await git('config', 'ssh.variant', 'ssh');
  await git('remote', 'set-url', 'origin', 'ssh://fixture.invalid/promisor.git');
  const repo = await discoverRepository(host, clone);
  assert.notEqual((await read(repo.root, ['cat-file', '-e', blob])).exitCode, 0);
  const snapshot = await nextPage(read, repo, await startSnapshot(read, repo));
  assert.equal(snapshot.commits[0].oid, oid);
  const commit = await readCommit(read, repo, oid);
  assert.match(commit.message, /Promised blob/);
  const diff = await endpoints(read, repo, { kind: 'commit', oid, parent: 0 }, commit);
  const files = await readChangedFiles(read, repo, diff);
  assert.equal(files[0].path, 'promised.txt');
  await assert.rejects(readPatch(read, repo, diff, files[0]), /Read patch:/);
  await assert.rejects(access(marker), /ENOENT/);
  await assert.rejects(readCommit(read, repo, 'f'.repeat(40)), /Read commit/);
  await assert.rejects(access(marker), /ENOENT/);
});

test('root, ordinary, staged, unstaged and two-tree comparisons use their named endpoints', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'file.txt'), 'root\n'); await f.git('add', 'file.txt'); await f.git('commit', '-m', 'Root message\n\nBody');
  const rootOid = await f.git('rev-parse', 'HEAD'); const repo = await discoverRepository(host, f.root);
  const commit = await readCommit(read, repo, rootOid);
  assert.match(commit.message, /Body/); assert.equal(commit.messageComplete, true);
  const rootDiff = await endpoints(read, repo, { kind: 'commit', oid: rootOid, parent: 0 }, commit);
  const rootFiles = await readChangedFiles(read, repo, rootDiff);
  assert.equal(rootFiles[0].status, 'A');
  assert.match((await readPatch(read, repo, rootDiff, rootFiles[0])).text, /\+root/);
  await writeFile(join(f.root, 'file.txt'), 'second\n'); await f.git('add', 'file.txt'); await f.git('commit', '-m', 'Second');
  const second = await f.git('rev-parse', 'HEAD');
  await writeFile(join(f.root, 'file.txt'), 'staged\n'); await f.git('add', 'file.txt'); await writeFile(join(f.root, 'file.txt'), 'unstaged\n');
  for (const [comparison, removed, added] of [[{ kind: 'staged' }, 'second', 'staged'], [{ kind: 'unstaged' }, 'staged', 'unstaged'], [{ kind: 'trees', from: rootOid, to: second }, 'root', 'second'], [{ kind: 'trees', from: second, to: rootOid }, 'second', 'root'], [{ kind: 'worktree', from: rootOid }, 'root', 'unstaged']]) {
    const diff = await endpoints(read, repo, comparison);
    const files = await readChangedFiles(read, repo, diff);
    const patch = await readPatch(read, repo, diff, files[0]);
    assert.ok(patch.complete); assert.ok(patch.text.includes('-' + removed)); assert.ok(patch.text.includes('+' + added));
  }
});

test('merge parent selection changes the actual comparison base', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'base'), 'base'); await f.git('add', '.'); await f.git('commit', '-m', 'Root');
  await f.git('switch', '-c', 'topic'); await writeFile(join(f.root, 'topic'), 'topic'); await f.git('add', '.'); await f.git('commit', '-m', 'Topic');
  await f.git('switch', 'main'); await writeFile(join(f.root, 'main'), 'main'); await f.git('add', '.'); await f.git('commit', '-m', 'Main');
  await f.git('merge', '--no-edit', 'topic');
  const oid = await f.git('rev-parse', 'HEAD'), repo = await discoverRepository(host, f.root);
  const detail = await readCommit(read, repo, oid); assert.equal(detail.parents.length, 2);
  const first = await readChangedFiles(read, repo, await endpoints(read, repo, { kind: 'commit', oid, parent: 0 }, detail));
  const second = await readChangedFiles(read, repo, await endpoints(read, repo, { kind: 'commit', oid, parent: 1 }, detail));
  assert.deepEqual(first.map(f => f.path), ['topic']); assert.deepEqual(second.map(f => f.path), ['main']);
});

test('unborn staged changes and literal unusual filenames work without a HEAD', async t => {
  const f = await fixture(t);
  const name = ':(glob)*\tline\n雪.txt'; await writeFile(join(f.root, name), 'literal path\n'); await f.git('add', '--', name);
  const repo = await discoverRepository(host, f.root);
  const diff = await endpoints(read, repo, { kind: 'staged' });
  assert.equal(diff.label, 'Empty tree → index (staged; no commits yet)');
  const files = await readChangedFiles(read, repo, diff); assert.equal(files[0].path, name);
  const patch = await readPatch(read, repo, diff, files[0]); assert.match(patch.text, /\+literal path/);
});

test('binary and oversized text previews retain accurate completeness', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'binary.bin'), Buffer.from([0, 1, 2])); await writeFile(join(f.root, 'large.txt'), 'line\n'.repeat(10000));
  await f.git('add', '.'); await f.git('commit', '-m', 'Large files');
  const repo = await discoverRepository(host, f.root), oid = await f.git('rev-parse', 'HEAD');
  const diff = await endpoints(read, repo, { kind: 'commit', oid, parent: 0 });
  const files = await readChangedFiles(read, repo, diff);
  assert.equal((await readPatch(read, repo, diff, files.find(f => f.path === 'binary.bin'))).binary, true);
  const large = await readPatch(read, repo, diff, files.find(f => f.path === 'large.txt'));
  assert.equal(large.complete, false); assert.equal(large.text.split('\n').length, 2000);
});

test('a shallow boundary retains its real missing parent and cannot masquerade as a root commit', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'file'), 'root'); await f.git('add', 'file'); await f.git('commit', '-m', 'Root');
  const parent = await f.git('rev-parse', 'HEAD');
  await writeFile(join(f.root, 'file'), 'child'); await f.git('commit', '-am', 'Child');
  const oid = await f.git('rev-parse', 'HEAD'), shallow = f.root + '-shallow';
  t.after(() => rm(shallow, { recursive: true, force: true }));
  await exec('git', ['-c', 'protocol.file.allow=always', 'clone', '--depth=1', 'file://' + f.root, shallow]);
  const repo = await discoverRepository(host, shallow); assert.equal(repo.shallow, true);
  const snapshot = await nextPage(read, repo, await startSnapshot(read, repo));
  assert.equal(snapshot.commits.length, 1); assert.equal(snapshot.commits[0].shallowBoundary, true);
  assert.deepEqual(snapshot.commits[0].parents, [parent]); assert.deepEqual(layout(snapshot.commits)[0].boundary, [parent]);
  const commit = await readCommit(read, repo, oid); assert.deepEqual(commit.parents, [parent]); assert.equal(commit.shallowBoundary, true);
  const diff = await endpoints(read, repo, { kind: 'commit', oid, parent: 0 }, commit); assert.doesNotMatch(diff.label, /root commit/);
  await assert.rejects(readChangedFiles(read, repo, diff), /Read changed files/);
  await assert.rejects(readCommit(read, repo, parent), /Read commit/);
  assert.equal(await f.git('rev-parse', 'HEAD'), oid);
});
