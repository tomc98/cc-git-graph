import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { host } from './host.mjs';
import { parseTarget, remoteRepository, lineSelection } from '../hooks/review/target.ts';
import { ReviewController } from '../hooks/review/controller.ts';
import { ReviewService } from '../hooks/review/service.ts';
const exec = promisify(execFile), pluginRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('URL parsing preserves comparisons, slash refs, file anchors and rejects unsafe targets', () => {
  assert.equal(parseTarget('https://github.com/team/repo/pull/123/files').tab, 'files');
  assert.equal(parseTarget('https://github.com/team/repo/pull/123/commits/abcdef123').kind, 'commit');
  assert.deepEqual(lineSelection('L10-L20'), { start: 10, end: 20 });
  assert.equal(parseTarget('https://github.com/team/repo/compare/main...feature%2Fsearch').ref, 'feature/search');
  assert.equal(parseTarget('https://github.com/team/repo/compare/main..topic').threeDot, false);
  assert.equal(parseTarget('https://github.com/team/repo/blob/feature/search/src/a.ts#L2').ref, 'feature/search/src/a.ts');
  assert.deepEqual(remoteRepository('git@github.com:team/repo.git'), { owner: 'team', name: 'repo' });
  for (const url of ['http://github.com/a/b/pull/1', 'https://github.com.evil/a/b/pull/1', 'https://github.com@evil/a/b', 'https://github.com/a/b/blob/main/../x', 'https://github.com/a/b/commit/--output=x']) assert.throws(() => parseTarget(url));
});

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-review-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'commit.gpgSign', 'false');
  await git('remote', 'add', 'origin', 'https://github.com/example/project.git');
  await writeFile(join(root, 'shared.txt'), 'original\n'); await git('add', 'shared.txt'); await git('commit', '-m', 'base');
  const base = await git('rev-parse', 'HEAD');
  await git('checkout', '-b', 'feature'); await writeFile(join(root, 'shared.txt'), 'original\nfeature\n'); await git('commit', '-am', 'feature');
  const head = await git('rev-parse', 'HEAD');
  await git('checkout', 'main'); await writeFile(join(root, 'unrelated.txt'), 'base branch only\n'); await git('add', '.'); await git('commit', '-m', 'base advances');
  const main = await git('rev-parse', 'HEAD'); await git('checkout', 'feature');
  const pr = { number: 1, title: 'Feature', body: 'Untrusted PR body', html_url: 'https://github.com/example/project/pull/1', state: 'open', base: { sha: main, ref: 'main', repo: { full_name: 'example/project' } }, head: { sha: head, ref: 'feature', repo: { full_name: 'example/project' } } };
  const remoteCommit = { sha: head, parents: [{ sha: base }], commit: { message: 'feature', author: { name: 'Fixture', date: '2026-01-01T00:00:00Z' } } };
  let apiCalls = 0, opens = 0, prompts = 0;
  const panelHost = { ...host, root: pluginRoot, cwd: async () => root, home: async () => root, configDirectory: async () => root,
    open: async () => { opens++; }, close: async () => {}, redraw: () => {}, after: () => ({ cancel() {} }), submitPrompt: async text => { prompts++; return { text }; },
    run: async (argv, options) => {
      if (argv[1]?.endsWith('/github-read.py')) {
        apiCalls++;
        const input = JSON.parse(options.stdin); let value;
        if (input.mode === 'anchor') return host.run(argv, options);
        if (input.mode === 'objects') throw new Error('Existing local objects should be reused');
        const p = input.endpoint?.replace('repos/example/project', '');
        if (p === '/pulls/1') value = pr;
        else if (p?.startsWith('/compare/') && input.query === '.merge_base_commit.sha') value = base;
        else if (p?.startsWith('/compare/')) value = [remoteCommit];
        else if (p?.startsWith('/pulls?')) value = input.endpoint.includes('feature') ? [pr] : [];
        else if (p?.startsWith('/commits/') && input.query === '.sha') value = head;
        else if (p?.startsWith('/commits/') || p?.startsWith('/commits?')) value = input.query.startsWith('[') ? [remoteCommit] : remoteCommit;
        else throw new Error('Unexpected API endpoint: ' + p);
        return { exitCode: 0, stdout: JSON.stringify({ version: 1, value, end: 'cc-git-graph-github-v1' }), stderr: '' };
      }
      return host.run(argv, options);
    } };
  return { root, git, base, head, main, pr, panelHost, counters: () => ({ apiCalls, opens, prompts }) };
}

test('PR review uses merge-base, exact pinned IDs and does not switch or dirty the checkout', async t => {
  const f = await fixture(t), review = new ReviewController(f.panelHost);
  const before = await f.git('status', '--porcelain=v1');
  const result = await review.open(f.pr.html_url);
  assert.equal(result.displayed, true); assert.equal(review.current.context.base, f.base); assert.notEqual(f.base, f.main);
  assert.deepEqual(review.current.files.files.map(f => f.path), ['shared.txt']);
  await review.selectFile(review.current.files.files[0]);
  assert.match(review.current.preview.text, /\+feature/);
  review.ask(); assert.match(review.handoff.context, new RegExp(f.head)); assert.match(review.handoff.context, /GitHub:/);
  assert.equal(f.counters().prompts, 0); await review.send(); assert.equal(f.counters().prompts, 1); await review.send(); assert.equal(f.counters().prompts, 1);
  assert.equal(await f.git('branch', '--show-current'), 'feature'); assert.equal(await f.git('status', '--porcelain=v1'), before);
});

test('model reads are independent, pinned and bounded; Follow Claude queues rather than moving the view', async t => {
  const f = await fixture(t), review = new ReviewController(f.panelHost);
  await review.open(f.pr.html_url); const current = review.current;
  review.followClaude = false;
  assert.equal((await review.open('https://github.com/example/project/commit/' + f.head, {}, true)).displayed, false);
  assert.equal(review.current, current); assert.ok(review.pending);
  const read = await review.read({ selectionId: current.context.id, file: 'shared.txt' });
  assert.match(read.text, /\+feature/); assert.equal(read.head, f.head); assert.equal(review.current, current);
  const other = await review.read({ target: 'https://github.com/example/project/commit/' + f.head });
  assert.equal(other.head, f.head); assert.equal(review.current, current); assert.equal(f.counters().prompts, 0);
  await assert.rejects(review.read({ selectionId: 'expired' }), /expired/);
  await assert.rejects(review.read({ file: '../outside' }), /Invalid file/);
});

test('local views separate branch changes from pending work and include untracked files', async t => {
  const f = await fixture(t), service = new ReviewService(f.panelHost);
  await writeFile(join(f.root, 'shared.txt'), 'original\nfeature\npending\n');
  await writeFile(join(f.root, 'new.txt'), 'untracked\n');
  const committed = await service.resolve('worktree', { mode: 'branch', base: 'main' });
  const pending = await service.resolve('worktree', { mode: 'uncommitted' });
  const all = await service.resolve('worktree', { base: 'main' });
  const file = { path: 'shared.txt', status: 'M' };
  assert.doesNotMatch((await service.patch(committed, file)).text, /pending/);
  assert.match((await service.patch(pending, file)).text, /\+pending/);
  assert.match((await service.patch(all, file)).text, /\+feature/);
  assert.ok(all.local.working.some(f => f.path === 'new.txt' && f.kind === 'untracked'));
  const review = new ReviewController(f.panelHost);
  const result = await review.read({ target: 'worktree', base: 'main', file: 'new.txt' });
  assert.match(result.text, /untracked/);
  assert.equal(await f.git('branch', '--show-current'), 'feature');
});

test('closed or superseded navigation cannot publish a late result', async t => {
  const f = await fixture(t), review = new ReviewController(f.panelHost);
  let release;
  const original = review.service.resolve.bind(review.service);
  review.service.resolve = async (...args) => { await new Promise(r => { release = r; }); return original(...args); };
  const opening = review.open(f.pr.html_url);
  while (!release) await new Promise(r => setTimeout(r, 1));
  review.closed(); release();
  assert.equal((await opening).displayed, false); assert.equal(review.current, undefined); assert.equal(review.active, false);
});

test('blob anchors open file content at the requested lines', async t => {
  const f = await fixture(t), review = new ReviewController(f.panelHost);
  await review.open('https://github.com/example/project/blob/' + f.head + '/shared.txt#L2');
  assert.equal(review.current.file.path, 'shared.txt'); assert.equal(review.current.lines.start, 2);
  assert.equal(review.current.preview.text, 'original\nfeature\n');
  review.ask(); assert.match(review.handoff.context, /feature/); assert.doesNotMatch(review.handoff.context, /original\n/);
});

test('explicit stacks reject unrelated PRs and one-PR stacks retain the cumulative diff', async t => {
  const f = await fixture(t), service = new ReviewService(f.panelHost);
  const context = await service.resolve('stack ' + f.pr.html_url);
  assert.equal(context.kind, 'stack'); assert.equal(context.base, f.base); assert.equal(context.head, f.head);
  await assert.rejects(service.resolve('stack ' + f.pr.html_url + ' ' + f.pr.html_url), /do not form/);
});

test('file paging retains the original branch snapshot after the branch advances', async t => {
  const f = await fixture(t), review = new ReviewController(f.panelHost);
  for (let i = 0; i < 205; i++) await writeFile(join(f.root, `file-${String(i).padStart(3, '0')}.txt`), 'added\n');
  await f.git('add', '.'); await f.git('commit', '-m', 'many files');
  const first = await review.read({ target: 'worktree', mode: 'branch', base: 'main' });
  assert.equal(first.files.length, 200); assert.equal(first.nextOffset, 200);
  await writeFile(join(f.root, 'later.txt'), 'later\n'); await f.git('add', '.'); await f.git('commit', '-m', 'later');
  const second = await review.read({ selectionId: first.selectionId, offset: first.nextOffset, prefix: first.prefix });
  assert.equal(second.files.length, 6); assert.equal(second.nextOffset, undefined); assert.equal(second.head, first.head);
  assert.ok(!second.files.some(f => f.path === 'later.txt'));
});

test('repository tree view lists actual files and model reads their contents', async t => {
  const f = await fixture(t), service = new ReviewService(f.panelHost);
  const context = await service.resolve('https://github.com/example/project/tree/' + f.head);
  const files = await service.files(context);
  assert.ok(files.files.some(f => f.path === 'shared.txt'));
  assert.equal((await service.blob(context, 'shared.txt')).text, 'original\nfeature\n');
});

test('diff file anchors resolve through paged filenames', async t => {
  const f = await fixture(t), service = new ReviewService(f.panelHost);
  const anchor = await service.helper({ mode: 'anchor', path: 'shared.txt' });
  const c = await service.resolve(f.pr.html_url + '/files#' + anchor);
  assert.equal(c.path, 'shared.txt');
});

test('Back retraces tabs, file selection and Ask while restoring their scroll and lane positions', async t => {
  const f = await fixture(t), timers = new Set(), scrolls = [];
  let returnedToGraph = 0;
  const review = new ReviewController({ ...f.panelHost,
    after: (_ms, fn) => { const timer = { fn, cancel: () => timers.delete(timer) }; timers.add(timer); return timer; },
    scrollTo: async offset => { scrolls.push(offset); },
    returnToGraph: async () => { returnedToGraph++; },
  });
  const restore = async () => {
    review.rendered(0);
    for (const timer of [...timers]) { timers.delete(timer); timer.fn(); }
    await Promise.resolve(); await Promise.resolve();
  };
  await review.open(f.pr.html_url, { view: 'graph' }); await restore();
  review.current.graphOffset = 100; review.laneOffset = 3; review.scrolled(42, true);
  await review.tab('files'); await restore(); review.scrolled(18, true);
  await review.selectFile(review.current.files.files[0]); await restore();
  review.current.offset = 100; review.scrolled(27, true); review.lineInput = '1-2'; review.setLines('1-2');
  review.ask(); await restore(); review.rendered(5);
  review.back(); await restore();
  assert.equal(review.current.file.path, 'shared.txt'); assert.equal(review.current.offset, 100);
  assert.equal(review.current.lines.start, 1); assert.equal(review.lineInput, '1-2'); assert.equal(scrolls.at(-1), 27);
  review.back(); await restore();
  assert.equal(review.current.file, undefined); assert.equal(review.current.tab, 'files'); assert.equal(scrolls.at(-1), 18);
  review.back(); await restore();
  assert.equal(review.current.tab, 'graph'); assert.equal(review.current.graphOffset, 100); assert.equal(review.laneOffset, 3); assert.equal(scrolls.at(-1), 42);
  assert.equal(review.backLabel, 'Back to graph');
  review.back(); await Promise.resolve();
  assert.equal(returnedToGraph, 1); assert.equal(review.active, false);
});

test('Back restores the exact file view across tabs and does not record repeated active-tab clicks', async t => {
  const f = await fixture(t), review = new ReviewController(f.panelHost);
  await review.open(f.pr.html_url);
  const count = review.history.length;
  await review.tab('files'); assert.equal(review.history.length, count);
  await review.selectFile(review.current.files.files[0]);
  review.current.offset = 100; review.scrolled(21, true);
  await review.tab('commits'); review.back();
  assert.equal(review.current.file.path, 'shared.txt'); assert.equal(review.current.offset, 100); assert.equal(review.current.viewportOffset, 21);
  review.back(); assert.equal(review.current.tab, 'files'); assert.equal(review.current.file, undefined);
});

test('Back cancels pending navigation and late errors cannot replace the restored view', async t => {
  const f = await fixture(t), review = new ReviewController(f.panelHost);
  await review.open(f.pr.html_url); await review.tab('graph');
  const before = review.current, depth = review.history.length;
  let release;
  review.service.resolve = () => new Promise((_resolve, reject) => { release = () => reject(new Error('late failure')); });
  const pending = review.run(() => review.open('https://github.com/example/project/pull/2'));
  while (!release) await new Promise(r => setTimeout(r, 1));
  review.back(); release(); await pending;
  assert.equal(review.current, before); assert.equal(review.history.length, depth); assert.equal(review.error, undefined);
  assert.equal(review.loading, false);
  review.back(); assert.equal(review.current.tab, 'files');
});

test('Back out of a pending file page ignores the late page even when the view object survives', async t => {
  const f = await fixture(t), review = new ReviewController(f.panelHost);
  await review.open(f.pr.html_url); await review.tab('graph'); await review.tab('files');
  review.current.files.hasMore = true;
  let release;
  review.service.files = () => new Promise(resolve => { release = resolve; });
  const next = review.nextFiles(); review.back();
  release({ files: [], offset: 200, nextOffset: 200, hasMore: false, prefix: 'a'.repeat(64) }); await next;
  assert.equal(review.current.tab, 'graph'); assert.equal(review.current.files.offset, 0);
});
