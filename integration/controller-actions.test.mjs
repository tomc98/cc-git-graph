import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PanelController } from '../hooks/controller.ts';
import { host as baseHost } from './host.mjs';

const pluginRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const host = { ...baseHost, run: (argv, options = {}) => baseHost.run(argv, { ...options, env: { ...options.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }) };
const settle = async predicate => {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Controller did not settle');
};

async function fixture(t, preferenceStore) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cc-git-graph-controller-actions-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repos = [join(root, 'control'), join(root, 'mono')];
  const git = async (path, ...args) => {
    const result = await host.run(['git', '-C', path, ...args], { timeoutMs: 10000 });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout.trimEnd();
  };
  for (const path of repos) {
    await mkdir(path); await git(path, 'init', '-b', 'main');
    await git(path, 'config', 'user.name', 'Fixture'); await git(path, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(path, 'file.txt'), 'root\n'); await git(path, 'add', 'file.txt'); await git(path, 'commit', '-m', 'Root');
  }
  await writeFile(join(root, 'cc-git-graph.json'), JSON.stringify({ version: 1, repositoryMaps: [{ whenPath: repos[0], defaultRepository: 'mono', repositories: [{ id: 'mono', label: 'Monorepo', path: repos[1] }, { id: 'control', label: 'Control', path: repos[0] }] }] }));
  let cwd = repos[0], writer, reader = host.run, taskOutput;
  const controller = new PanelController({ ...host, root: pluginRoot, cwd: async () => cwd, home: async () => root, configDirectory: async () => root,
    open: async () => {}, close: async () => {}, redraw: () => {}, after: () => ({ cancel() {} }),
    run: (...args) => reader(...args), write: (...args) => writer(...args), taskOutput: (...args) => taskOutput(...args),
    readPreferences: async () => preferenceStore?.value,
    writePreferences: async value => { if (preferenceStore) preferenceStore.value = structuredClone(value); },
  });
  t.after(() => controller.close());
  await controller.open(); await settle(() => controller.view?.snapshot && !controller.view.loading && !controller.resolving);
  const execute = async command => {
    const result = await host.run(['/bin/sh', '-c', command], { cwd: root, timeoutMs: 30000 });
    return { text: result.stdout, isError: result.exitCode !== 0 };
  };
  const preview = async name => { await controller.openActions(); controller.editAction('name', name); await controller.previewAction(); assert.equal(controller.action.stage, 'ready', controller.action.error); };
  return { root, repos, controller, git, preview, execute, setCwd: value => { cwd = value; }, setWriter: value => { writer = value; }, setReader: value => { reader = value; }, setTaskOutput: value => { taskOutput = value; } };
}

async function addHistory(f, path, count = 1400) {
  const head = await f.git(path, 'rev-parse', 'HEAD');
  let input = '';
  for (let i = 1; i <= count; i++) {
    const message = 'History row ' + i;
    input += `commit refs/heads/main\nmark :${i}\ncommitter Fixture <fixture@example.invalid> ${1700000000 + i} +0000\ndata ${message.length}\n${message}\nfrom ${i === 1 ? head : ':' + (i - 1)}\n\n`;
  }
  const result = await host.run(['git', '-C', path, 'fast-import', '--quiet'], { stdin: input, timeoutMs: 15000 });
  assert.equal(result.exitCode, 0, result.stderr);
}

test('a replaced older search cannot block or clear a new repository search', async t => {
  const f = await fixture(t), c = f.controller;
  for (const path of f.repos) await addHistory(f, path);
  await c.refresh(); assert.equal(c.view.snapshot.commits.length, 200);
  let oldRelease, newRelease;
  const blocked = new Set();
  f.setReader(async (argv, options) => {
    const request = argv[0] === '/usr/bin/python3' && options?.stdin ? JSON.parse(options.stdin) : undefined;
    if (request?.args?.[0] === 'rev-list' && request.args.includes('--skip=200') && !blocked.has(options.cwd)) {
      blocked.add(options.cwd);
      await new Promise(resolve => { if (options.cwd === f.repos[1]) oldRelease = resolve; else newRelease = resolve; });
    }
    return host.run(argv, options);
  });
  t.after(() => { oldRelease?.(); newRelease?.(); });
  c.search('old query'); const oldSearch = c.searchOlder(); await settle(() => Boolean(oldRelease));
  await c.switchRepository('control'); assert.equal(c.searchingOlder, false);
  c.search('new query'); const newSearch = c.searchOlder(); await settle(() => Boolean(newRelease));
  oldRelease(); await oldSearch;
  assert.equal(c.searchingOlder, true); assert.equal(c.searchCoverage, undefined);
  newRelease(); await newSearch;
  assert.equal(c.searchingOlder, false); assert.equal(c.view.repository.root, f.repos[0]);
  assert.equal(c.view.query, 'new query'); assert.equal(c.view.snapshot.commits.length, 1200);
  assert.match(c.searchCoverage, /Searched 1000 older commits; 1200 loaded/);
});

test('changing a query stops further older pages and clears obsolete coverage', async t => {
  const f = await fixture(t), c = f.controller; await addHistory(f, f.repos[1]); await c.refresh();
  let release, pages = 0;
  f.setReader(async (argv, options) => {
    const request = argv[0] === '/usr/bin/python3' && options?.stdin ? JSON.parse(options.stdin) : undefined;
    if (request?.args?.[0] === 'rev-list') { pages++; if (pages === 1) await new Promise(resolve => { release = resolve; }); }
    return host.run(argv, options);
  });
  t.after(() => release?.());
  c.search('original'); const searching = c.searchOlder(); await settle(() => Boolean(release));
  c.search('replacement'); assert.equal(c.searchingOlder, false);
  release(); await searching;
  assert.equal(pages, 1); assert.equal(c.view.query, 'replacement');
  assert.equal(c.searchCoverage, undefined); assert.equal(c.view.snapshot.commits.length, 400);
});

test('Stop search permits the current page to finish but schedules no next page and stays idle after close', async t => {
  const f = await fixture(t), c = f.controller; await addHistory(f, f.repos[1]); await c.refresh();
  let release, pages = 0;
  f.setReader(async (argv, options) => {
    const request = argv[0] === '/usr/bin/python3' && options?.stdin ? JSON.parse(options.stdin) : undefined;
    if (request?.args?.[0] === 'rev-list') { pages++; await new Promise(resolve => { release = resolve; }); }
    return host.run(argv, options);
  });
  t.after(() => release?.());
  c.search('History'); const pending = c.searchOlder(); await settle(() => Boolean(release));
  c.stopOlderSearch(); assert.equal(c.searchingOlder, false); assert.match(c.searchCoverage, /^Stopped/);
  release(); await pending;
  assert.equal(pages, 1); assert.equal(c.view.snapshot.commits.length, 400); assert.match(c.searchCoverage, /^Stopped/);
  await c.close(); await c.searchOlder(); assert.equal(c.searchingOlder, false); assert.equal(pages, 1);
});

test('a running action is submitted once and stays on its original mapped checkout across close/cwd changes', async t => {
  const f = await fixture(t), c = f.controller;
  let calls = 0, release;
  f.setWriter(async command => { calls++; await new Promise(resolve => { release = resolve; }); return f.execute(command); });
  await f.preview('created-only-in-mono');
  c.isWorking = true; await c.submitAction(); assert.equal(calls, 0); assert.match(c.action.error, /turn finishes/);
  c.isWorking = false; const pending = c.submitAction(); await settle(() => Boolean(release));
  await c.submitAction(); c.dismissAction(); await c.switchRepository('control');
  assert.equal(calls, 1); assert.equal(c.view.repository.root, f.repos[1]);
  f.setCwd(f.repos[1]); await c.poll(); assert.equal(c.context.mapped, true);
  await c.close(); release(); await pending;
  assert.equal(c.opened, false); assert.equal(c.action.outcome.status, 'succeeded');
  assert.equal(await f.git(f.repos[1], 'branch', '--list', 'created-only-in-mono'), '  created-only-in-mono');
  assert.equal(await f.git(f.repos[0], 'branch', '--list', 'created-only-in-mono'), '');
  await c.open(); await settle(() => !c.resolving && !c.view.loading);
  assert.equal(c.context.mapped, false); assert.equal(c.view.repository.root, f.repos[1]);
});

test('editing an in-flight preview or switching repositories invalidates its intent', async t => {
  const f = await fixture(t), c = f.controller;
  let release, delayed = true;
  f.setReader(async (argv, options) => {
    if (delayed && argv.some(arg => arg.endsWith('/git-state.py'))) {
      delayed = false; await new Promise(resolve => { release = resolve; });
    }
    return host.run(argv, options);
  });
  await c.openActions(); c.editAction('name', 'old-name'); const pending = c.previewAction(); await settle(() => Boolean(release));
  c.editAction('name', 'edited-name'); release(); await pending;
  assert.equal(c.action.stage, 'editing'); assert.equal(c.action.intent, undefined);
  await c.previewAction(); assert.equal(c.action.stage, 'ready'); assert.match(c.action.intent.summary.join('\n'), /edited-name/);
  await c.switchRepository('control'); assert.equal(c.action, undefined); await c.submitAction();
  assert.equal(await f.git(f.repos[1], 'branch', '--list', 'edited-name'), '');
});

test('a stale action can be reviewed again without losing its fields or executing automatically', async t => {
  const f = await fixture(t), c = f.controller;
  f.setWriter(f.execute);
  await f.preview('review-again');
  const original = c.action.intent;
  await f.git(f.repos[1], 'branch', 'external-change');
  await c.poll();
  assert.equal(c.action.intent, original, 'polling must not silently replace the reviewed intent');
  assert.equal(c.action.values.name, 'review-again');
  assert.equal(c.action.stage, 'ready');
  await c.submitAction();
  assert.equal(c.action.outcome.status, 'stale');
  assert.equal(await f.git(f.repos[1], 'branch', '--list', 'review-again'), '');
  c.editAction('action', c.action.id);
  assert.equal(c.action.stage, 'editing');
  assert.equal(c.action.values.name, 'review-again');
  assert.equal(c.action.intent, undefined);
  assert.equal(c.action.outcome, undefined);
  await c.submitAction();
  assert.equal(await f.git(f.repos[1], 'branch', '--list', 'review-again'), '');
  await c.previewAction();
  assert.equal(c.action.stage, 'ready', c.action.error);
  assert.notDeepEqual(c.action.intent, original);
  await c.submitAction();
  assert.equal(c.action.outcome.status, 'succeeded');
  assert.equal(await f.git(f.repos[1], 'branch', '--list', 'review-again'), '  review-again');
});

test('background reconciliation consumes the existing receipt and never repeats the Git operation', async t => {
  const f = await fixture(t), c = f.controller;
  let calls = 0, command;
  f.setWriter(async value => { calls++; command = value; return { result: { backgroundTaskId: 'fixture-task' }, text: 'Running' }; });
  await f.preview('background-once'); await c.submitAction();
  assert.equal(c.mutating, true); assert.equal(c.action.outcome.status, 'unknown');
  f.setTaskOutput(async id => { assert.equal(id, 'fixture-task'); return { result: { retrieval_status: 'not_ready', task: { status: 'running' } } }; });
  await c.reconcileAction(); await c.switchRepository('control'); assert.equal(c.mutating, true); assert.equal(c.view.repository.root, f.repos[1]);
  f.setCwd(f.repos[1]); await c.poll();
  const result = await f.execute(command);
  f.setTaskOutput(async () => ({ result: { retrieval_status: 'success', task: { status: 'completed', output: result.text + '\n[exited with code 0]\n', exitCode: 0 } } }));
  await c.reconcileAction();
  assert.equal(c.mutating, false); assert.equal(c.action.outcome.status, 'succeeded'); assert.equal(calls, 1); assert.equal(c.context.mapped, false);
  await c.reconcileAction(); assert.equal(calls, 1);
});

test('visible mutable previews refresh even when porcelain status remains unchanged', async t => {
  const f = await fixture(t), c = f.controller, path = join(f.repos[1], 'file.txt');
  await writeFile(path, 'first edit\n'); await c.poll();
  await c.inspectWorkingFile(c.view.working.find(file => file.path === 'file.txt')); assert.match(c.detail.patch.text, /first edit/);
  await writeFile(path, 'second edit\n'); await c.poll(); assert.match(c.detail.patch.text, /second edit/); assert.doesNotMatch(c.detail.patch.text, /first edit/);
  await writeFile(path, 'root\n'); await c.poll(); assert.equal(c.detail.file, undefined); assert.equal(c.detail.files.length, 0); assert.match(c.detail.error, /no longer/);
  await writeFile(join(f.repos[1], 'new.txt'), 'new content'); await c.inspectUntracked('new.txt'); assert.equal(c.detail.patch.text, 'new content');
  await writeFile(join(f.repos[1], 'new.txt'), 'changed content'); await c.poll(); assert.equal(c.detail.patch.text, 'changed content');
  await rm(join(f.repos[1], 'new.txt')); await c.poll(); assert.equal(c.detail.patch, undefined); assert.match(c.detail.error, /unavailable/);
  assert.equal(await readFile(path, 'utf8'), 'root\n');
});

test('a delayed working-file selection cannot replace the detail for another repository', async t => {
  const f = await fixture(t), c = f.controller;
  await writeFile(join(f.repos[1], 'file.txt'), 'mono edit\n'); await writeFile(join(f.repos[0], 'file.txt'), 'control edit\n'); await c.poll();
  let release, delayed = true;
  f.setReader(async (argv, options) => {
    if (delayed && options?.cwd === f.repos[1] && argv.some(arg => arg.endsWith('/git-read.py') || arg.endsWith('/git-files.py'))) {
      delayed = false; await new Promise(resolve => { release = resolve; });
    }
    return host.run(argv, options);
  });
  const pending = c.inspectWorkingFile(c.view.working[0]); await settle(() => Boolean(release));
  const switching = c.switchRepository('control'); release(); await Promise.all([pending, switching]);
  assert.equal(c.detail, undefined); assert.equal(c.view.repository.root, f.repos[0]);
  await c.inspectWorkingFile(c.view.working[0]); assert.match(c.detail.patch.text, /control edit/); assert.doesNotMatch(c.detail.patch.text, /mono edit/);
});

test('Ask Claude sends the reviewed repo context once and is unavailable in an agent transcript', async t => {
  const f = await fixture(t), c = f.controller;
  let calls = 0;
  c.host.submitPrompt = async text => { calls++; assert.match(text, /\/mono\n/); return { text }; };
  await c.inspect({ kind: 'commit', oid: c.view.snapshot.head, parent: 0 });
  c.mainView = false; c.openHandoff(); assert.equal(c.handoff, undefined);
  c.mainView = true; c.openHandoff(); assert.equal(calls, 0); assert.equal(c.handoff.stage, 'editing');
  c.handoff.question = 'Explain this selected fixture commit';
  c.mainView = false; await c.submitHandoff(); assert.equal(calls, 0);
  c.mainView = true; await Promise.all([c.submitHandoff(), c.submitHandoff()]); assert.equal(calls, 1); assert.equal(c.handoff.stage, 'accepted');
  c.handoff = undefined; c.openHandoff(); await c.switchRepository('control'); assert.equal(c.handoff, undefined); await c.submitHandoff(); assert.equal(calls, 1);
});

test('switching repos keeps loaded history and refresh anchors the old top row after a new commit', async t => {
  const f = await fixture(t), c = f.controller;
  await f.git(f.repos[1], 'commit', '--allow-empty', '-m', 'Second'); await c.refresh();
  const originalTop = c.visibleCommits[0].oid;
  c.view.offset = 0;
  const snapshot = c.view.snapshot;
  await c.switchRepository('control'); await c.switchRepository('mono');
  assert.equal(c.view.snapshot.commits, snapshot.commits);
  await f.git(f.repos[1], 'commit', '--allow-empty', '-m', 'Third'); await c.refresh();
  assert.equal(c.visibleCommits[c.view.offset].oid, originalTop); assert.equal(c.view.offset, 1);
  const stableSnapshot = c.view.snapshot;
  await c.close(); await c.open(); await settle(() => !c.resolving && !c.view.loading);
  assert.equal(c.view.snapshot.commits, stableSnapshot.commits);
});

test('immutable details are cached while working-tree details always read their current state', async t => {
  const f = await fixture(t), c = f.controller;
  const comparison = { kind: 'commit', oid: c.view.snapshot.head, parent: 0 };
  await c.inspect(comparison); await c.inspectFile(c.detail.files[0]);
  let reads = 0;
  f.setReader(async (...args) => { reads++; return host.run(...args); });
  await c.inspect(comparison); await c.inspectFile(c.detail.files[0]);
  assert.equal(reads, 1, 'Only the empty-tree identifier is read again for a root comparison');
  await writeFile(join(f.repos[1], 'file.txt'), 'uncached worktree\n');
  await c.inspect({ kind: 'unstaged' }); await c.inspectFile(c.detail.files[0]); assert.ok(reads > 1); assert.match(c.detail.patch.text, /uncached worktree/);
  assert.ok(c.details.bytes <= 32 * 1024 * 1024);
});

test('a fresh controller restores checkout display preferences but follows the map default instead of the last repo', async t => {
  const store = {}, f = await fixture(t, store), c = f.controller;
  await c.columns('full'); await c.filter('refs/heads/main');
  await c.switchRepository('control'); await c.columns('compact'); await c.close();
  const fresh = new PanelController(c.host); t.after(() => fresh.close());
  assert.equal(fresh.opened, false); await fresh.open(); await settle(() => fresh.view?.snapshot && !fresh.view.loading && !fresh.resolving);
  assert.equal(fresh.view.repository.root, f.repos[1]); assert.equal(fresh.view.columns, 'full'); assert.equal(fresh.view.filter, 'refs/heads/main');
  await fresh.switchRepository('control'); assert.equal(fresh.view.columns, 'compact');
  assert.doesNotMatch(JSON.stringify(store.value), /selected|opened|commits|message|offset/);
});

test('a retained render during asynchronous host close cannot reactivate the controller', async t => {
  const f = await fixture(t), c = f.controller;
  let release;
  c.host.close = () => new Promise(resolve => { release = resolve; });
  const pending = c.close();
  c.paneRendered();
  const reopenedDuringClose = c.opened;
  release(); await pending;
  c.host.close = async () => {};
  assert.equal(reopenedDuringClose, false);
  assert.equal(c.opened, false);
  await c.open(); await settle(() => !c.resolving && !c.view.loading);
  assert.equal(c.opened, true);
});

test('changing branch filter resets the horizontal lane position', async t => {
  const f = await fixture(t), c = f.controller;
  c.view.laneOffset = 4;
  await c.filter('refs/heads/main');
  assert.equal(c.view.laneOffset, 0);
  assert.equal(c.view.graph.length, 1);
});

test('failed untracked previews can retry the same path after recovery', async t => {
  const f = await fixture(t), c = f.controller;
  await c.inspectUntracked('late-file.txt');
  assert.ok(c.detail.error);
  assert.equal(c.detail.patch, undefined);
  await writeFile(join(f.repos[1], 'late-file.txt'), 'available after retry\n');
  await c.retryDetail();
  assert.equal(c.detail.error, undefined);
  assert.equal(c.detail.file.path, 'late-file.txt');
  assert.match(c.detail.patch.text, /available after retry/);
  await c.close();
  const detail = c.detail;
  await c.retryDetail();
  assert.equal(c.detail, detail);
});


test('collection read failures recover through an explicit retry', async t => {
  const f = await fixture(t), c = f.controller;
  await f.git(f.repos[1], 'remote', 'add', 'fixture', f.repos[0]);
  f.setReader(async () => { throw new Error('fixture read timeout'); });
  await c.openCollection('remotes');
  assert.match(c.collection.error, /fixture read timeout/);
  f.setReader(host.run);
  await c.retryCollection();
  assert.equal(c.collection.error, undefined);
  assert.equal(c.collection.remotes[0].name, 'fixture');
});

test('a late clipboard failure cannot attach to another repository or detail', async t => {
  const f = await fixture(t), c = f.controller;
  await c.inspect({ kind: 'commit', oid: c.view.snapshot.head, parent: 0 });
  let release;
  f.setReader(async (argv, options) => {
    if (argv[0] === '/usr/bin/pbcopy') {
      await new Promise(resolve => { release = resolve; });
      return { exitCode: 1, stdout: '', stderr: 'fixture clipboard unavailable' };
    }
    return host.run(argv, options);
  });
  const pending = c.copy('fixture text');
  await settle(() => Boolean(release));
  await c.switchRepository('control');
  await c.inspect({ kind: 'commit', oid: c.view.snapshot.head, parent: 0 });
  release(); await pending;
  assert.equal(c.detail.error, undefined);
  assert.equal(c.error, undefined);
  f.setReader(async (argv, options) => argv[0] === '/usr/bin/pbcopy'
    ? { exitCode: 1, stdout: '', stderr: 'fixture clipboard unavailable' }
    : host.run(argv, options));
  await c.copy('fixture text');
  assert.match(c.detail.error, /fixture clipboard unavailable/);
});

test('a superseded file-page failure cannot clear loading or add an error to a selected patch', async t => {
  const f = await fixture(t), c = f.controller;
  await Promise.all(Array.from({ length: 201 }, (_, i) => writeFile(join(f.repos[1], `page-${i}.txt`), 'fixture patch\n')));
  await f.git(f.repos[1], 'add', '--all'); await f.git(f.repos[1], 'commit', '-m', 'Paged files');
  await c.inspect({ kind: 'commit', oid: await f.git(f.repos[1], 'rev-parse', 'HEAD'), parent: 0 });
  assert.equal(c.detail.page.hasMore, true);
  const file = c.detail.files[0];
  let releasePage, releasePatch;
  f.setReader(async (argv, options) => {
    if (argv.some(arg => arg.endsWith('/git-files.py'))) {
      await new Promise(resolve => { releasePage = resolve; });
      throw new Error('superseded page failed');
    }
    if (argv.some(arg => arg.endsWith('/git-read.py'))) {
      await new Promise(resolve => { releasePatch = resolve; });
    }
    return host.run(argv, options);
  });
  const page = c.filePageDirection('next'); await settle(() => Boolean(releasePage));
  const patch = c.inspectFile(file); await settle(() => Boolean(releasePatch));
  releasePage(); await page;
  assert.equal(c.detail.loading, true);
  assert.equal(c.detail.error, undefined);
  releasePatch(); await patch;
  assert.equal(c.detail.loading, false);
  assert.equal(c.detail.file.path, file.path);
  assert.match(c.detail.patch.text, /fixture patch/);
});

test('stash untracked preparation failures remain visible and can recover', async t => {
  const f = await fixture(t), c = f.controller;
  await writeFile(join(f.repos[1], 'saved-extra.txt'), 'saved untracked data\n');
  await f.git(f.repos[1], 'stash', 'push', '--include-untracked', '-m', 'Retry fixture');
  await c.openCollection('stashes'); await c.inspectStash(c.collection.stashes[0]);
  f.setReader(async () => { throw new Error('fixture empty-tree read failed'); });
  await c.inspectStashPart('untracked');
  assert.match(c.detail.error, /fixture empty-tree read failed/);
  assert.equal(c.detail.loading, false);
  f.setReader(host.run);
  await c.inspectStashPart('untracked');
  assert.equal(c.detail.error, undefined);
  assert.equal(c.detail.files[0].path, 'saved-extra.txt');
});

test('an earlier tag request cannot overwrite a later request for the same tag', async t => {
  const f = await fixture(t), c = f.controller;
  await f.git(f.repos[1], 'tag', '-a', 'tag-a', '-m', 'Annotation A');
  await f.git(f.repos[1], 'tag', '-a', 'tag-b', '-m', 'Annotation B');
  await c.openCollection('tags');
  const a = c.collection.tags.find(ref => ref.name === 'refs/tags/tag-a');
  const b = c.collection.tags.find(ref => ref.name === 'refs/tags/tag-b');
  let release, first = true;
  f.setReader(async (argv, options) => {
    if (first) { first = false; await new Promise(resolve => { release = resolve; }); throw new Error('obsolete tag read'); }
    return host.run(argv, options);
  });
  const pending = c.inspectTag(a); await settle(() => Boolean(release));
  await c.inspectTag(b); await c.inspectTag(a);
  release(); await pending;
  assert.equal(c.collection.tag.ref.name, a.name);
  assert.equal(c.collection.error, undefined);
  assert.equal(c.collection.loading, false);
});


test('Back from a pending tag returns to its list and rejects the late failure', async t => {
  const f = await fixture(t), c = f.controller;
  await f.git(f.repos[1], 'tag', '-a', 'pending-tag', '-m', 'Annotation');
  await c.openCollection('tags');
  const collection = c.collection;
  let release;
  f.setReader(async () => { await new Promise(resolve => { release = resolve; }); throw new Error('late tag failure'); });
  const pending = c.inspectTag(collection.tags[0]); await settle(() => Boolean(release));
  c.backCollection();
  assert.equal(c.collection, collection);
  assert.equal(collection.loading, false);
  assert.equal(collection.tagRequest, undefined);
  release(); await pending;
  assert.equal(collection.error, undefined);
  assert.equal(collection.tags.length, 1);
  c.backCollection(); assert.equal(c.collection, undefined);
});

test('dismissing the repository picker cancels a pending path selection', async t => {
  const f = await fixture(t), c = f.controller;
  await c.openPicker();
  let release;
  c.host.home = () => new Promise(resolve => { release = () => resolve(f.root); });
  const pending = c.choosePath(f.repos[0]); await settle(() => Boolean(release));
  c.picker = undefined;
  release(); await pending;
  assert.equal(c.view.repository.root, f.repos[1]);
  assert.equal(c.pin, undefined);
});

test('a superseded path selection cannot win while the newer lookup is pending', async t => {
  const f = await fixture(t), c = f.controller;
  await c.openPicker();
  const releases = [];
  c.host.home = () => new Promise(resolve => { releases.push(() => resolve(f.root)); });
  const first = c.choosePath(f.repos[0]);
  const second = c.choosePath(f.repos[1]);
  await settle(() => releases.length === 2);
  releases[0](); await first;
  assert.equal(c.view.repository.root, f.repos[1]);
  assert.equal(c.pin, undefined);
  assert.equal(c.picker.loading, true);
  releases[1](); await second;
  assert.equal(c.pin.repository.root, f.repos[1]);
  assert.equal(c.picker, undefined);
});


test('successful polling clears its stale warning without clearing an unrelated error', async t => {
  const f = await fixture(t), c = f.controller;
  c.view.error = 'Fixture unrelated view error';
  f.setReader(async () => { throw new Error('fixture poll timeout'); });
  await c.poll();
  assert.match(c.view.refreshError, /fixture poll timeout/);
  f.setReader(host.run);
  await c.poll();
  assert.equal(c.view.refreshError, undefined);
  assert.equal(c.view.error, 'Fixture unrelated view error');
});


test('action previews wait for repository choices to finish loading', async t => {
  const f = await fixture(t), c = f.controller;
  let release, first = true;
  f.setReader(async (argv, options) => {
    if (first) { first = false; await new Promise(resolve => { release = resolve; }); }
    return host.run(argv, options);
  });
  const opening = c.openActions(); await settle(() => Boolean(release));
  assert.equal(c.action.optionsLoading, true);
  c.editAction('name', 'wait-for-choices'); await c.previewAction();
  assert.equal(c.action.stage, 'editing'); assert.equal(c.action.intent, undefined);
  release(); await opening;
  assert.equal(c.action.optionsLoading, false);
  await c.previewAction(); assert.equal(c.action.stage, 'ready');
});


test('retrying action choices preserves typed values after a read failure', async t => {
  const f = await fixture(t), c = f.controller;
  f.setReader(async () => { throw new Error('fixture options unavailable'); });
  await c.openActions();
  assert.match(c.action.error, /fixture options unavailable/);
  c.editAction('name', 'preserved-name');
  await c.previewAction(); assert.equal(c.action.intent, undefined);
  f.setReader(host.run);
  await c.retryActionOptions();
  assert.equal(c.action.values.name, 'preserved-name');
  assert.equal(c.action.error, undefined);
  assert.ok(c.action.options.branches.includes('main'));
  await c.previewAction(); assert.equal(c.action.stage, 'ready');
});

test('a failed host open leaves the controller closed and permits retry', async t => {
  const f = await fixture(t), c = f.controller;
  await c.close();
  let attempts = 0;
  c.host.open = async () => { if (++attempts === 1) throw new Error('Host pane unavailable'); };
  await assert.rejects(c.open(), /Host pane unavailable/);
  assert.equal(c.opened, false);
  await c.open();
  await settle(() => !c.resolving && !c.view.loading);
  assert.equal(attempts, 2);
  assert.equal(c.opened, true);
  assert.equal(c.view.repository.root, f.repos[1]);
});

for (const outcome of ['resolve', 'reject']) {
  test(`a superseded host open ${outcome} cannot disturb a reopened pane`, async t => {
    const f = await fixture(t), c = f.controller;
    await c.close();
    let resolve, reject;
    c.host.open = () => new Promise((yes, no) => { resolve = yes; reject = no; });
    const pending = c.open();
    const observed = pending.catch(error => error);
    await c.close();
    c.host.open = async () => {};
    await c.open(); await settle(() => !c.resolving && !c.view.loading);
    await f.preview('keep-new-preview');
    const action = c.action;
    if (outcome === 'resolve') resolve(); else reject(new Error('Old open failed'));
    await observed;
    assert.equal(c.opened, true);
    assert.equal(c.action, action);
    assert.equal(c.action.stage, 'ready');
  });
}

test('closing and reopening during handoff preserves one submission and its receipt', async t => {
  const f = await fixture(t), c = f.controller;
  let calls = 0, release;
  c.host.submitPrompt = text => { calls++; return new Promise(resolve => { release = () => resolve({ text }); }); };
  await c.inspect({ kind: 'commit', oid: c.view.snapshot.head, parent: 0 });
  c.mainView = true; c.openHandoff();
  const form = c.handoff;
  const pending = c.submitHandoff();
  assert.equal(form.stage, 'sending');
  await c.close(); await c.submitHandoff();
  await c.open(); await settle(() => !c.resolving && !c.view.loading);
  assert.equal(c.handoff, form);
  await c.submitHandoff(); assert.equal(calls, 1);
  release(); await pending;
  assert.equal(c.handoff, form);
  assert.equal(form.stage, 'accepted');
  await c.submitHandoff(); assert.equal(calls, 1);
});
