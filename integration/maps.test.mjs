import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveRepositoryContext } from '../hooks/config/repository-maps.ts';
import { normalizePath } from '../hooks/config/paths.ts';

const home = '/home/test';
const repo = root => ({ root, gitDir: root + '/.git', commonDir: root + '/.git', bare: false, shallow: false, objectFormat: 'sha1', identity: root });
const repositories = [repo('/projects/control'), repo('/projects/mono'), repo('/projects/mono-wt'), repo('/unrelated'), repo('/projects/control-backup')];
const aliases = { '/shortcut': '/projects/control', '/mono-shortcut': '/projects/mono' };
const services = {
  canonical: async path => {
    for (const [from, to] of Object.entries(aliases)) if (path === from || path.startsWith(from + '/')) return to + path.slice(from.length);
    return path;
  },
  discover: async path => {
    const found = repositories.find(r => path === r.root || path.startsWith(r.root + '/'));
    if (!found) throw new Error('not a repository');
    return found;
  },
};
const choice = (id, path, label = id) => ({ id, path, label });
const rule = (whenPath = '/projects/control', extra = {}) => ({ whenPath, repositories: [choice('mono', '/projects/mono'), choice('control', '/projects/control')], defaultRepository: 'mono', ...extra });
const resolve = (maps, cwd = '/projects/control', previous) => resolveRepositoryContext({ config: JSON.stringify({ version: 1, repositoryMaps: maps }), cwd, home, previous }, services);
const active = context => context.choices.find(c => c.id === context.selectedId)?.repository?.root;

test('an orchestration map offers ordered repo buttons and the configured default', async () => {
  const context = await resolve([rule()]);
  assert.equal(context.mapped, true);
  assert.deepEqual(context.choices.map(c => c.id), ['mono', 'control']);
  assert.equal(active(context), '/projects/mono');
});

test('missing, empty, malformed and unsupported config fall back to current repo', async () => {
  for (const config of [undefined, '', '{}', '{"version":1,"repositoryMaps":[]}', '{bad', '{"version":2,"repositoryMaps":[]}', '[]']) {
    const context = await resolveRepositoryContext({ config, cwd: '/projects/control', home }, services);
    assert.equal(active(context), '/projects/control');
    assert.equal(context.mapped, false);
  }
});

test('directory boundaries, exact rules, descendants and most-specific rule', async () => {
  assert.equal(active(await resolve([rule()], '/projects/control-backup')), '/projects/control-backup');
  assert.equal(active(await resolve([rule()], '/projects/control/sub')), '/projects/mono');
  assert.equal(active(await resolve([rule(undefined, { includeSubdirectories: false })], '/projects/control/sub')), '/projects/control');
  const narrow = rule('/projects/control/sub', { repositories: [choice('wt', '/projects/mono-wt')], defaultRepository: 'wt' });
  const context = await resolve([rule(), narrow], '/projects/control/sub/deep');
  assert.deepEqual(context.choices.map(c => c.id), ['wt']);
});

test('an unusable specific rule falls back instead of inheriting a broader map', async () => {
  for (const repositories of [[], null, [choice('missing', '/missing')]]) {
    const context = await resolve([rule('/projects'), rule('/projects/control', { repositories })]);
    assert.equal(active(context), '/projects/control');
    assert.equal(context.mapped, false);
  }
});

test('mapping works when the session directory is outside Git', async () => {
  assert.equal(active(await resolve([rule('/orchestrator')], '/orchestrator')), '/projects/mono');
  const noRepo = await resolve([], '/orchestrator');
  assert.equal(noRepo.selectedId, undefined);
  assert.match(noRepo.diagnostics.join('\n'), /not a Git repository/);
});

test('default fallback prefers current listed repo, then first usable choice', async () => {
  const context = await resolve([rule(undefined, { defaultRepository: 'missing' })]);
  assert.equal(active(context), '/projects/control');
  assert.match(context.diagnostics.join(' '), /defaultRepository/);
  assert.equal(active(await resolve([rule('/orchestrator', { defaultRepository: null })], '/orchestrator')), '/projects/mono');
});

test('normalization resolves aliases, dot segments, trailing slash and duplicate checkouts', async () => {
  const context = await resolve([rule('/shortcut/./', { repositories: [choice('first', '/mono-shortcut'), choice('duplicate', '/projects/mono/sub'), choice('wt', '/projects/mono-wt')] })]);
  assert.deepEqual(context.choices.map(c => c.id), ['first', 'wt']);
  assert.match(context.diagnostics.join(' '), /Duplicate checkout/);
  assert.equal(normalizePath('~/x/../y/', home), home + '/y');
  for (const path of ['relative/path', '$HOME/project', '~/project/*', '/bad\0path']) assert.throws(() => normalizePath(path, home));
});

test('same context preserves valid selection; a new context resets it', async () => {
  const initial = await resolve([rule()]);
  initial.selectedId = 'control';
  assert.equal(active(await resolve([rule()], '/projects/control/sub', initial)), '/projects/control');
  assert.equal(active(await resolve([rule()], '/unrelated', initial)), '/unrelated');
  assert.equal(active(await resolve([rule(undefined, { repositories: [choice('mono', '/projects/mono')] })], '/projects/control', initial)), '/projects/mono');
});

test('invalid and duplicate entries remain diagnostic without displacing usable entries', async () => {
  const context = await resolve([rule(undefined, { repositories: [null, choice('bad', '/missing'), choice('mono', '/projects/mono'), choice('mono', '/projects/control')] })]);
  assert.equal(active(context), '/projects/mono');
  assert.equal(context.choices[0].repository, undefined);
  assert.match(context.diagnostics.join(' '), /Duplicate repository id/);
});

test('duplicate normalized matching map ties prefer the earlier rule', async () => {
  const context = await resolve([rule(), rule('/projects/control/', { repositories: [] })]);
  assert.equal(active(context), '/projects/mono');
  assert.match(context.diagnostics.join(' '), /earlier matching map wins/);
});

test('the checked-in repository-map example uses the same resolver', async () => {
  const config = await readFile(new URL('../examples/cc-git-graph.example.json', import.meta.url), 'utf8');
  const cwd = home + '/Projects/control';
  const roots = [repo(cwd), repo(home + '/Projects/monorepo')];
  const context = await resolveRepositoryContext({ config, cwd, home }, {
    canonical: async path => path,
    discover: async path => { const r = roots.find(r => r.root === path); if (!r) throw new Error('not a repository'); return r; },
  });
  assert.deepEqual(context.choices.map(c => c.label), ['Monorepo', 'Control']);
  assert.equal(active(context), home + '/Projects/monorepo');
});
