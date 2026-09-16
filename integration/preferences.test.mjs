import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Preferences } from '../hooks/config/preferences.ts';
import { historyRowParts } from '../hooks/ui/history-row.ts';
import { cellWidth } from '../hooks/ui/text.ts';

test('display preferences round-trip per checkout with a bounded, versioned payload', async () => {
  let stored;
  const preferences = new Preferences(async () => stored, async value => { stored = structuredClone(value); });
  await preferences.load();
  await preferences.set('control/.git', { filter: 'refs/heads/main', columns: 'compact' });
  await preferences.set('mono/.git', { filter: 'refs/heads/topic', columns: 'full' });
  const restored = new Preferences(async () => stored); await restored.load();
  assert.deepEqual(restored.get('mono/.git'), { filter: 'refs/heads/topic', columns: 'full' });
  assert.deepEqual(restored.get('control/.git'), { filter: 'refs/heads/main', columns: 'compact' });
  assert.deepEqual(restored.get('unrelated'), { filter: '', columns: 'auto' });
  assert.equal(stored.version, 1); assert.deepEqual(Object.keys(stored).sort(), ['repositories', 'version']);
  for (let i = 0; i < 200; i++) await preferences.set('/repo/' + i + '/long/path'.repeat(80), { filter: 'refs/heads/main', columns: 'auto' });
  assert.ok(stored.repositories.length <= 128); assert.ok(JSON.stringify(stored).length * 2 <= 32768);
  assert.equal(stored.repositories.at(-1).identity.startsWith('/repo/199/'), true);
});

test('invalid preferences fall back and read/write failures can recover without storing session state', async () => {
  const invalid = new Preferences(async () => ({ version: 1, repositories: [null, { identity: 'bad', filter: {}, columns: 'full' }, { identity: 'good', filter: '', columns: 'author', open: true, selectedRepository: 'wrong' }] }));
  await invalid.load(); assert.deepEqual(invalid.get('bad'), { filter: '', columns: 'auto' }); assert.deepEqual(invalid.get('good'), { filter: '', columns: 'author' });
  let reads = 0, writes = 0;
  const recovering = new Preferences(async () => { if (++reads === 1) throw new Error('temporary read error'); return undefined; }, async () => { if (++writes === 1) throw new Error('temporary write error'); });
  await assert.rejects(recovering.load(), /temporary read/); await recovering.load(); assert.equal(reads, 2);
  await assert.rejects(recovering.set('repo', { filter: '', columns: 'full' }), /temporary write/);
  await recovering.set('repo', { filter: 'refs/heads/main', columns: 'compact' }); assert.equal(writes, 2);
});

test('history columns adapt to actual pane width while refs remain visible and controls stay escaped', () => {
  const commit = { oid: 'a'.repeat(40), parents: [], author: 'Author 雪', timestamp: 0, subject: 'A long subject '.repeat(20) + '\u001b[31m' };
  const refs = [{ kind: 'branch', name: 'refs/heads/main', oid: commit.oid }, { kind: 'tag', name: 'refs/tags/release-v1', oid: commit.oid }];
  for (const width of [20, 39, 74, 89, 104, 160]) {
    const parts = historyRowParts(commit, refs, 'auto', width, width, false);
    const label = parts.hash + ' ' + parts.badges.map(badge => ' ' + badge.label + '  ').join('') + parts.label;
    assert.ok(cellWidth(label) <= width, label); assert.equal(label.includes('\u001b'), false);
    if (width >= 39) assert.match(label, /main/);
    if (width >= 104) assert.match(label, /1970-01-01/);
  }
  assert.doesNotMatch(historyRowParts(commit, refs, 'compact', 160, 160, false).label, /Author/);
});


test('lane counts persist per repository, migrate old preferences and reject invalid counts', async () => {
  let stored;
  const prefs = new Preferences(async () => ({ version: 1, repositories: [
    { identity: 'old', filter: '', columns: 'auto' },
    { identity: 'invalid', filter: '', columns: 'full', laneLimit: -1 },
  ] }), async value => { stored = structuredClone(value); });
  await prefs.load();
  assert.equal(prefs.get('old').laneLimit, undefined);
  assert.equal(prefs.get('invalid').laneLimit, undefined);
  await prefs.set('mono', { filter: '', columns: 'auto', laneLimit: 30 });
  await prefs.set('control', { filter: '', columns: 'auto', laneLimit: 'all' });
  const restored = new Preferences(async () => stored); await restored.load();
  assert.equal(restored.get('mono').laneLimit, 30);
  assert.equal(restored.get('control').laneLimit, 'all');
  for (const laneLimit of [0, -1, 2.5, NaN, Infinity, '12'])
    await assert.rejects(prefs.set('bad', { filter: '', columns: 'auto', laneLimit }));
  await prefs.set('mono', { filter: '', columns: 'auto' });
  assert.equal(prefs.get('mono').laneLimit, undefined);
});
