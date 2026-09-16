import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { host } from './host.mjs';
import { discoverRepository } from '../hooks/git/repository.ts';
import { createGitReader } from '../hooks/git/read.ts';
import { filePreview } from '../hooks/git/file-preview.ts';
import { readStashes } from '../hooks/git/stashes.ts';
import { readRemotes } from '../hooks/git/remotes.ts';
import { readCommit, endpoints, readChangedFiles, readPatch } from '../hooks/git/details.ts';

const exec = promisify(execFile), root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const read = createGitReader(host, root);
async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), 'cc-git-graph-collections-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', ['-C', path, '-c', 'commit.gpgSign=false', ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trimEnd();
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  return { path, git, repo: await discoverRepository(host, path) };
}

test('untracked previews bound text and binary content and read symlink targets without following them', async t => {
  const f = await fixture(t);
  await mkdir(join(f.path, 'new')); await writeFile(join(f.path, 'new', 'snow 雪\n.txt'), 'text\n');
  assert.deepEqual((await filePreview(host, root, f.repo, 'new/snow 雪\n.txt')).text, 'text\n');
  await writeFile(join(f.path, 'binary'), Buffer.from([0, 1, 2, 255]));
  const binary = await filePreview(host, root, f.repo, 'binary'); assert.equal(binary.binary, true); assert.match(binary.text, /00 01 02 ff/);
  await writeFile(join(f.path, 'large'), 'row\n'.repeat(3000)); assert.equal((await filePreview(host, root, f.repo, 'large')).complete, false);
  await writeFile(join(f.path, 'wide'), 'x'.repeat(300000)); const wide = await filePreview(host, root, f.repo, 'wide'); assert.equal(wide.complete, false); assert.equal(wide.text.length, 262144);
  await symlink('/unreadable/external-target', join(f.path, 'link'));
  assert.equal((await filePreview(host, root, f.repo, 'link')).text, 'Symbolic link → /unreadable/external-target');
  await symlink(tmpdir(), join(f.path, 'outside'));
  await assert.rejects(filePreview(host, root, f.repo, 'outside/example'), /outside/);
  await assert.rejects(filePreview(host, root, f.repo, '../outside'), /inside/);
  await assert.rejects(filePreview(host, root, f.repo, 'new'), /regular file/);
});

test('stash worktree, index and untracked parents identify three different saved states', async t => {
  const f = await fixture(t);
  await writeFile(join(f.path, 'tracked'), 'base\n'); await f.git('add', 'tracked'); await f.git('commit', '-m', 'Root');
  await writeFile(join(f.path, 'tracked'), 'saved index\n'); await f.git('add', 'tracked'); await writeFile(join(f.path, 'tracked'), 'saved worktree\n');
  await writeFile(join(f.path, 'untracked'), 'saved untracked\n'); await f.git('stash', 'push', '--include-untracked', '-m', 'three states');
  const [stash] = await readStashes(read, f.repo); assert.equal(stash.selector, 'stash@{0}'); assert.match(stash.subject, /three states/);
  const commit = await readCommit(read, f.repo, stash.oid); assert.equal(commit.parents.length, 3);
  const worktree = await endpoints(read, f.repo, { kind: 'commit', oid: stash.oid, parent: 0 }, commit);
  const worktreeFiles = await readChangedFiles(read, f.repo, worktree); assert.deepEqual(worktreeFiles.map(file => file.path), ['tracked']);
  assert.match((await readPatch(read, f.repo, worktree, worktreeFiles[0])).text, /\+saved worktree/);
  const index = await endpoints(read, f.repo, { kind: 'trees', from: commit.parents[0], to: commit.parents[1] });
  const indexFiles = await readChangedFiles(read, f.repo, index); assert.match((await readPatch(read, f.repo, index, indexFiles[0])).text, /\+saved index/);
  const untracked = await endpoints(read, f.repo, { kind: 'commit', oid: commit.parents[2], parent: 0 });
  assert.deepEqual((await readChangedFiles(read, f.repo, untracked)).map(file => file.path), ['untracked']);
});

test('remote inspection preserves names, multiple URLs, push overrides and configured fetch mappings', async t => {
  const f = await fixture(t); assert.deepEqual(await readRemotes(read, f.repo), []);
  await f.git('remote', 'add', 'team.dot', '/local/first');
  await f.git('config', '--add', 'remote.team.dot.url', '/local/second\nline');
  await f.git('config', '--add', 'remote.team.dot.pushurl', '/local/push');
  const [remote] = await readRemotes(read, f.repo);
  assert.equal(remote.name, 'team.dot'); assert.deepEqual(remote.urls, ['/local/first', '/local/second\nline']);
  assert.deepEqual(remote.pushUrls, ['/local/push']); assert.deepEqual(remote.fetchSpecs, ['+refs/heads/*:refs/remotes/team.dot/*']);
});
