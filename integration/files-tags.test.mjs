import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { host } from './host.mjs';
import { discoverRepository } from '../hooks/git/repository.ts';
import { createGitReader } from '../hooks/git/read.ts';
import { endpoints, readChangedFiles } from '../hooks/git/details.ts';
import { readFilePage } from '../hooks/git/files.ts';
import { readRefs } from '../hooks/git/history.ts';
import { readTag } from '../hooks/git/tags.ts';

const exec = promisify(execFile), pluginRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const read = createGitReader(host, pluginRoot);
async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), 'cc-git-graph-files-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', ['-C', path, '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, maxBuffer: 8 * 1024 * 1024 })).stdout.trimEnd();
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  return { path, git, repo: await discoverRepository(host, path) };
}

test('large changed-file lists page through the complete Git result beyond the normal output cap', async t => {
  const f = await fixture(t);
  const names = Array.from({ length: 1400 }, (_, i) => `${String(i).padStart(4, '0')}-${'long-name-'.repeat(22)}.txt`);
  names[701] = '0701-quote\'tab\tline\n雪.txt';
  for (let i = 0; i < names.length; i += 100) await Promise.all(names.slice(i, i + 100).map(name => writeFile(join(f.path, name), name)));
  await f.git('add', '.'); await f.git('commit', '-m', 'Large changed-file fixture');
  const oid = await f.git('rev-parse', 'HEAD'), diff = await endpoints(read, f.repo, { kind: 'commit', oid, parent: 0 });
  await assert.rejects(readChangedFiles(read, f.repo, diff), /limit|complete|truncat/i);
  let cursor = { offset: 0 }, found = [], pages = 0;
  for (;;) {
    const page = await readFilePage(host, pluginRoot, f.repo, diff, cursor);
    assert.ok(page.files.length <= 200); assert.equal(page.offset, found.length); found.push(...page.files.map(file => file.path)); pages++;
    if (!page.hasMore) break;
    cursor = { offset: page.nextOffset, prefix: page.prefix };
  }
  assert.equal(pages, 7); assert.deepEqual(found, [...names].sort()); assert.equal(new Set(found).size, 1400);
});

test('file pages preserve rename records and reject moving mutable list prefixes', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 205; i++) await writeFile(join(f.path, String(i).padStart(3, '0')), 'root');
  await f.git('add', '.'); await f.git('commit', '-m', 'Root');
  await f.git('mv', '000', 'renamed\tfile');
  const staged = await endpoints(read, f.repo, { kind: 'staged' });
  const rename = (await readFilePage(host, pluginRoot, f.repo, staged)).files[0];
  assert.equal(rename.oldPath, '000'); assert.equal(rename.path, 'renamed\tfile'); assert.equal(rename.status, 'R100');
  for (let i = 1; i < 205; i++) await writeFile(join(f.path, String(i).padStart(3, '0')), 'changed');
  const unstaged = await endpoints(read, f.repo, { kind: 'unstaged' });
  const first = await readFilePage(host, pluginRoot, f.repo, unstaged); assert.equal(first.hasMore, true);
  await writeFile(join(f.path, '001'), 'root');
  await assert.rejects(readFilePage(host, pluginRoot, f.repo, unstaged, { offset: first.nextOffset, prefix: first.prefix }), /moved between pages/);
  assert.equal((await readFilePage(host, pluginRoot, f.repo, unstaged)).files[0].path, '002');
});

test('tag inspection distinguishes lightweight and annotated objects and keeps selected OIDs stable', async t => {
  const f = await fixture(t);
  await writeFile(join(f.path, 'file'), 'root'); await f.git('add', 'file'); await f.git('commit', '-m', 'Root');
  await f.git('tag', 'light'); await f.git('tag', '-a', 'annotated', '-m', 'Release heading\n\nDetailed annotation.');
  let refs = (await readRefs(read, f.repo)).refs;
  const light = await readTag(read, f.repo, refs.find(ref => ref.name === 'refs/tags/light'));
  assert.equal(light.annotated, false); assert.equal(light.targetType, 'commit');
  const selected = refs.find(ref => ref.name === 'refs/tags/annotated');
  await f.git('tag', '-fa', 'annotated', '-m', 'Moved annotation');
  const annotated = await readTag(read, f.repo, selected);
  assert.equal(annotated.annotated, true); assert.match(annotated.message, /Detailed annotation/); assert.doesNotMatch(annotated.message, /Moved/);
  assert.match(annotated.tagger, /Fixture/); assert.equal(annotated.target, light.target); assert.equal(annotated.messageComplete, true);
  const message = join(f.path, '.git/long-tag-message'); await writeFile(message, 'tag annotation '.repeat(8000)); await f.git('tag', '-a', 'large', '-F', message);
  refs = (await readRefs(read, f.repo)).refs;
  const large = await readTag(read, f.repo, refs.find(ref => ref.name === 'refs/tags/large')); assert.equal(large.messageComplete, false); assert.ok(large.message.length <= 65536);
});
