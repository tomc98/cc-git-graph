import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, graphGlyphs } from '../hooks/graph/layout.ts';
import { laneColour, lanePalette } from '../hooks/ui/colours.ts';
import { historyBadges, historyRowParts } from '../hooks/ui/history-row.ts';
import { cellWidth } from '../hooks/ui/text.ts';

const commits = [
  { oid: 'merge', parents: ['main', 'topic', 'other'] },
  { oid: 'topic', parents: ['topic-before'] },
  { oid: 'topic-before', parents: ['root'] },
  { oid: 'other', parents: ['root'] },
  { oid: 'main', parents: ['root'] },
  { oid: 'root', parents: [] },
  { oid: 'disconnected', parents: [] },
];

test('graph colours follow first-parent paths and do not recolour passing lanes', () => {
  const rows = layout(commits), byId = new Map(rows.map(row => [row.oid, row]));
  assert.equal(byId.get('merge').color, byId.get('main').color);
  assert.equal(byId.get('topic').color, byId.get('topic-before').color);
  assert.notEqual(byId.get('topic').color, byId.get('main').color);
  assert.notEqual(byId.get('topic').color, byId.get('other').color);
  assert.notEqual(byId.get('root').color, byId.get('disconnected').color);
  for (const [index, row] of rows.entries()) {
    for (const edge of row.edges) {
      assert.equal(edge.color, rows[index + 1]?.colors[edge.to]);
      assert.equal(row.next[edge.to], edge.target);
    }
  }
});

test('coloured cells retain topology and use the same colours when paging or panning', () => {
  const full = layout(commits), page = layout(commits.slice(0, 3));
  for (const [index, row] of page.entries()) {
    assert.equal(row.color, full[index].color);
    assert.deepEqual(graphGlyphs(row).nodeCells, graphGlyphs(full[index]).nodeCells);
    assert.deepEqual(graphGlyphs(row).edgeCells, graphGlyphs(full[index]).edgeCells);
  }
  const glyphs = graphGlyphs(full[1]);
  assert.equal(glyphs.nodeCells.map(cell => cell.text).join(''), '│ ● │');
  assert.equal(new Set(glyphs.nodeCells.filter(cell => cell.text !== ' ').map(cell => cell.color)).size, 3);
  assert.deepEqual(graphGlyphs(full[1], 1, 1).edgeCells, glyphs.edgeCells.slice(2, 3));
  const crossingRow = layout([{ oid: 'm', parents: ['a', 'b', 'c'] }, { oid: 'c', parents: ['a'] }, { oid: 'b', parents: [] }, { oid: 'a', parents: [] }])[1];
  const crossing = graphGlyphs(crossingRow).edgeCells;
  assert.equal(crossing[2].text, '┼');
  assert.equal(crossing[2].color, crossingRow.colors[1]);
  assert.equal(new Set(lanePalette).size, 12);
  assert.equal(laneColour(12), laneColour(0));
});

test('ref badges prioritise current HEAD, preserve kinds, and escape terminal controls', () => {
  const refs = [
    { kind: 'tag', name: 'refs/tags/v1', oid: 'one' },
    { kind: 'remote', name: 'refs/remotes/origin/main', oid: 'one' },
    { kind: 'branch', name: 'refs/heads/aaa', oid: 'one' },
    { kind: 'branch', name: 'refs/heads/main', oid: 'one' },
  ];
  const badges = historyBadges(refs, true, 90, 'main');
  assert.deepEqual(badges.map(badge => badge.kind), ['head', 'branch', 'branch', 'remote', 'tag']);
  assert.equal(badges[1].label, 'main');
  assert.equal(badges.at(-1).label, 'tag: v1');
  const crowded = historyBadges(refs, true, 20, 'main');
  assert.equal(crowded[0].label, 'HEAD');
  assert.equal(crowded.at(-1).kind, 'more');
  const escaped = historyBadges([{ kind: 'branch', name: 'refs/heads/fake\u001b[31m', oid: 'one' }], false, 90);
  assert.doesNotMatch(escaped[0].label, /\u001b/);
  assert.match(escaped[0].label, /\\u001b/);
});

test('coloured history rows fit narrow and wide panes with unicode and many refs', () => {
  const commit = { oid: 'a'.repeat(40), parents: [], author: 'An author 雪', timestamp: 0, subject: '🎉 Fix 👩🏽‍💻 graph café\u0301 '.repeat(30) + '\u001b[0m' };
  const refs = Array.from({ length: 200 }, (_, i) => ({ kind: i % 2 ? 'tag' : 'branch', name: 'refs/heads/long-雪-name-' + i, oid: commit.oid, commit: commit.oid }));
  for (const width of [8, 12, 20, 39, 74, 89, 104, 160]) {
    const parts = historyRowParts(commit, refs, 'auto', width, width, true, 'main');
    const text = parts.hash + ' ' + parts.badges.map(badge => ' ' + badge.label + '  ').join('') + parts.label;
    assert.ok(cellWidth(text) <= width, `${width}: ${text}`);
    assert.doesNotMatch(text, /\u001b/);
    assert.ok(parts.label.length > 0);
  }
});
