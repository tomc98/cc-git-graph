import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PanelController } from '../hooks/controller.ts';
import { host } from './host.mjs';

const exec = promisify(execFile);
const pluginRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const settle = async predicate => {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Controller did not settle');
};

test('visible history prefetch preserves position, cancels stale requests and pauses after errors', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-progressive-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'commit.gpgSign', 'false');
  const tree = await git('write-tree');
  let parent;
  for (let i = 0; i < 405; i++) parent = await git('commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `Commit ${i}`);
  await git('update-ref', 'refs/heads/main', parent);
  let mode = 'normal', release, pageReads = 0;
  const prefetches = new Set();
  const fire = () => {
    const timer = [...prefetches][0];
    assert.ok(timer, 'a visible continuation queues a prefetch');
    prefetches.delete(timer); timer.fn();
  };
  const controller = new PanelController({ ...host, root: pluginRoot,
    cwd: async () => root, home: async () => root, configDirectory: async () => root,
    open: async () => {}, close: async () => {}, redraw: () => {},
    after: (ms, fn) => { const timer = { fn, cancel: () => prefetches.delete(timer) }; if (ms === 50) prefetches.add(timer); return timer; },
    run: async (argv, options) => {
      if (argv[1]?.endsWith('/git-read.py') && JSON.parse(options.stdin).args.includes('--skip=200')) {
        pageReads++;
        if (mode === 'fail') return { exitCode: 1, stdout: '', stderr: 'fixture page failure' };
        if (mode === 'delay') await new Promise(resolve => { release = resolve; });
      }
      return host.run(argv, options);
    },
  });
  t.after(() => controller.close());
  await controller.open();
  await settle(() => controller.view?.snapshot?.commits.length === 200 && !controller.view.loading);
  const view = controller.view;
  controller.prefetchHistory(180, 200);
  const beforeClose = [...prefetches][0];
  await controller.close();
  assert.equal(prefetches.size, 0, 'close cancels pending history work');
  beforeClose.fn();
  assert.equal(pageReads, 0);
  await controller.open();
  await settle(() => !controller.resolving && !view.loading);
  view.offset = 150;
  controller.historyScrolled(10 + 150 * 2, 10 + 200 * 2 + 1, 1);
  assert.equal(view.offset, 150, 'a footer spacer is not counted as a history header row');
  const selected = view.selected, revision = controller.historyRevision;
  await controller.lanes(25);
  assert.equal(view.laneLimit, 25);
  assert.equal(view.offset, 150);
  assert.equal(view.selected, selected);
  assert.equal(controller.historyRevision, revision);
  await controller.lanes(undefined);
  const boundary = view.graph.at(-1).oid;
  controller.prefetchHistory(0, 20);
  assert.equal(prefetches.size, 0, 'an off-screen boundary does not load more');
  controller.prefetchHistory(180, 200);
  const cancelled = [...prefetches][0];
  controller.prefetchHistory(0, 20);
  assert.equal(prefetches.size, 0, 'scrolling away cancels a queued request');
  cancelled.fn();
  assert.equal(pageReads, 0);
  for (const key of ['detail', 'action', 'picker', 'handoff', 'collection', 'workingView']) {
    controller.prefetchHistory(180, 200);
    controller[key] = key === 'workingView' ? true : {};
    fire();
    assert.equal(pageReads, 0, `${key} cancels a pending prefetch`);
    controller[key] = key === 'workingView' ? false : undefined;
  }
  controller.prefetchHistory(180, 200);
  view.query = 'search'; fire(); view.query = '';
  assert.equal(pageReads, 0, 'search does not trigger automatic history expansion');
  mode = 'fail';
  controller.prefetchHistory(180, 200);
  controller.prefetchHistory(180, 200);
  assert.equal(prefetches.size, 1, 'repeated renders schedule only one request');
  fire();
  await settle(() => !view.loading && Boolean(view.error));
  assert.ok(view.error);
  assert.equal(view.snapshot.commits.length, 200);
  controller.prefetchHistory(180, 200);
  assert.equal(prefetches.size, 0, 'errors require explicit retry, not an automatic loop');
  mode = 'delay';
  const pending = controller.more();
  await settle(() => Boolean(release));
  assert.equal(view.error, undefined);
  await controller.more();
  controller.prefetchHistory(180, 200);
  assert.equal(prefetches.size, 0, 'an in-flight manual retry blocks prefetch');
  assert.equal(pageReads, 2, 'one failed read and one pending retry, no duplicate');
  release(); await pending;
  assert.equal(view.snapshot.commits.length, 400);
  assert.equal(view.offset, 150);
  assert.equal(view.selected, selected);
  assert.equal(controller.historyRevision, revision, 'appending does not request a scroll reset');
  assert.deepEqual(view.graph.find(row => row.oid === boundary).boundary, []);
  controller.prefetchHistory(140, 175);
  assert.equal(prefetches.size, 0, 'loading stops once nearby connections are filled');
  mode = 'normal';
  controller.prefetchHistory(380, 400);
  fire();
  await settle(() => !view.loading && view.snapshot.commits.length === 405);
  assert.equal(view.offset, 150);
  assert.equal(view.selected, selected);
  assert.equal(controller.historyRevision, revision);
  await controller.more();
  assert.equal(pageReads, 2, 'the page at offset 200 was read once plus its failed attempt');
  controller.prefetchHistory(380, 405);
  assert.equal(prefetches.size, 0);
  view.snapshot = { ...view.snapshot, hasMore: true, commits: Array(5000).fill(view.snapshot.commits[0]) };
  controller.prefetchHistory(4980, 5000);
  assert.equal(prefetches.size, 0);
});

test('mapped switching, stale reads, reopen and closed idle behavior', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cc-git-graph-controller-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repos = [join(root, 'control'), join(root, 'mono')];
  for (const [index, path] of repos.entries()) {
    await mkdir(path);
    const git = (...args) => exec('git', ['-C', path, '-c', 'commit.gpgSign=false', ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(path, 'file'), String(index)); await git('add', 'file'); await git('commit', '-m', index ? 'Monorepo only' : 'Control only');
  }
  const config = { version: 1, repositoryMaps: [{ whenPath: repos[0], repositories: [{ id: 'mono', label: 'Monorepo', path: repos[1] }, { id: 'control', label: 'Control', path: repos[0] }], defaultRepository: 'mono' }] };
  await writeFile(join(root, 'cc-git-graph.json'), JSON.stringify(config));
  let cwd = repos[0], calls = [], opened = 0, closed = 0, delayed = false, release;
  const timers = new Set();
  const controller = new PanelController({ ...host, root: pluginRoot,
    cwd: async () => cwd, home: async () => root, configDirectory: async () => root,
    open: async () => { opened++; }, close: async () => { closed++; }, redraw: () => {},
    after: (ms, fn) => { const timer = { cancel: () => timers.delete(timer), fn }; timers.add(timer); return timer; },
    run: async (argv, options) => {
      calls.push({ argv, options });
      if (delayed && argv[0] === '/usr/bin/python3' && options.cwd === repos[0]) {
        delayed = false; await new Promise(resolve => { release = resolve; });
      }
      return host.run(argv, options);
    },
  });
  assert.equal(calls.length, 0); await controller.open();
  await settle(() => controller.view?.snapshot && !controller.view.loading);
  assert.equal(opened, 1); assert.equal(controller.view.snapshot.commits[0].subject, 'Monorepo only');
  assert.ok(calls.filter(c => c.argv[0] === '/usr/bin/python3').every(c => c.options.cwd === repos[1]));
  const graph = controller.view.graph;
  await controller.refresh();
  assert.equal(controller.view.graph, graph, 'unchanged ancestry reuses the existing topology');
  controller.search('Monorepo');
  delayed = true;
  const firstSwitch = controller.switchRepository('control');
  await settle(() => Boolean(release));
  await controller.switchRepository('mono');
  release(); await firstSwitch;
  assert.equal(controller.view.snapshot.commits[0].subject, 'Monorepo only');
  assert.equal(controller.view.query, 'Monorepo');
  assert.equal(controller.view.loading, false);
  assert.equal(cwd, repos[0]);
  await controller.close();
  const count = calls.length;
  assert.equal(timers.size, 0);
  controller.toolCompleted(); await controller.poll(); await controller.refresh();
  assert.equal(calls.length, count); assert.equal(closed, 1);
  await controller.open(); await settle(() => !controller.resolving && !controller.view.loading);
  assert.equal(controller.view.query, 'Monorepo');
  await controller.openPicker();
  assert.equal(controller.picker.worktrees.length, 1);
  await controller.choosePath(repos[0]);
  assert.equal(controller.view.snapshot.commits[0].subject, 'Control only');
  assert.equal(controller.pin.repository.root, repos[0]);
  assert.equal(cwd, repos[0]);
  await controller.refresh();
  assert.equal(controller.view.repository.root, repos[0]);
  await controller.followConversation();
  assert.equal(controller.view.repository.root, repos[1]);
  assert.equal(controller.pin, undefined);
  assert.equal(controller.views.size, 2, 'both mapped checkout views remain available within the context');
  cwd = repos[1]; await controller.poll();
  assert.equal(controller.context.mapped, false);
  assert.equal(controller.context.choices.length, 1);
  assert.equal(controller.views.size, 1, 'the unrelated old context no longer retains its history');
  assert.equal([...controller.views.values()][0].repository.root, repos[1]);
  await controller.close();
});
