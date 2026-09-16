import { expect, test, tier } from 'claude-code/testing';
import type { RenderInput } from 'claude-code';
import { renderHistoryRow } from '../hooks/ui/history.tsx';
import { layout } from '../hooks/graph/layout.ts';
import { laneColour, refColours } from '../hooks/ui/colours.ts';
import type { Commit, HistorySnapshot } from '../hooks/git/history.ts';

tier('user');

test('coloured native rows retain one focusable commit target and styled inline badges', async ($, on) => {
  const commit = { oid: 'a'.repeat(40), parents: ['b', 'c', 'd'], author: 'Fixture', subject: 'Inspect this colourful merge', timestamp: 0 };
  const graph = layout([commit, ...commit.parents.map(oid => ({ oid, parents: [] }))]);
  const snapshot = { commits: [commit], roots: [commit.oid], hasMore: false, head: commit.oid, branch: 'main',
    refs: [{ name: 'refs/heads/main', kind: 'branch' as const, oid: commit.oid, commit: commit.oid }] };
  const pane: RenderInput<'Pane', 'terminal'> = { component: 'Pane', surface: 'terminal', requestId: 'colour-proof', viewport: { columns: 200, rows: 48 },
    props: { title: 'Colour proof', isFocused: false, bodyColumns: 89, placement: 'dock', scroll: { offset: 0, bodyRows: 43 }, view: {} } };
  let clicks = 0;
  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== 'colour-proof' || e.surface !== 'terminal') return next(e);
    return renderHistoryRow($.ui.resolve(e), commit, graph[0]!, snapshot, { width: e.props.bodyColumns, firstLane: 0, maxLanes: 8, columns: 'compact', selected: true, searching: false }, () => { clicks++; });
  });
  const output = JSON.stringify(await $.ui.render(pane));
  expect(output).toContain(laneColour(0));
  expect(output).toContain(laneColour(1));
  expect(output).toContain(laneColour(2));
  expect(output).toContain('backgroundColor');
  expect(output).toContain(refColours.head);
  expect(output).toContain('HEAD');
  expect(output).toContain('main');
  expect(output).toContain('Inspect this colourful');
  const narrow = JSON.stringify(await $.ui.render({ ...pane, props: { ...pane.props, bodyColumns: 37 } }));
  expect(narrow).toContain('HEAD');
  expect(narrow).toContain('main');
  expect(narrow).toContain(refColours.head);
  const pending = [JSON.parse(output)];
  const buttons = [];
  while (pending.length) {
    const element = pending.pop();
    if (element?.type === 'Button') buttons.push(element);
    if (element?.children) pending.push(...element.children);
  }
  expect(buttons.length).toBe(1);
  expect(buttons[0].props.key).toBe('commit-' + commit.oid);
  await $.ui.press({ plugin: buttons[0].press.plugin, key: buttons[0].props.key });
  expect(clicks).toBe(1);
});

test('history boundaries show automatic loading and offer a button only for a failed-read retry', async ($, on) => {
  const parent: Commit = { oid: 'b'.repeat(40), parents: [], author: 'Fixture', subject: 'Parent', timestamp: 0 };
  const commit: Commit = { ...parent, oid: 'a'.repeat(40), parents: [parent.oid], subject: 'Child' };
  let snapshot: HistorySnapshot = { commits: [commit], roots: [commit.oid], hasMore: true, refs: [] };
  let loading = false, loadError = false, searching = false, clicks = 0;
  const pane: RenderInput<'Pane', 'terminal'> = { component: 'Pane', surface: 'terminal', requestId: 'history-boundary', viewport: { columns: 200, rows: 48 },
    props: { title: 'History', isFocused: false, bodyColumns: 89, placement: 'dock', scroll: { offset: 0, bodyRows: 43 }, view: {} } };
  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== 'history-boundary' || e.surface !== 'terminal') return next(e);
    return renderHistoryRow($.ui.resolve(e), commit, layout(snapshot.commits)[0]!, snapshot,
      { width: e.props.bodyColumns, firstLane: 0, maxLanes: 8, columns: 'compact', selected: false, searching, loading, loadError },
      () => {}, () => { clicks++; loading = true; loadError = false; });
  });
  const render = async (width = 89) => JSON.stringify(await $.ui.render({ ...pane, props: { ...pane.props, bodyColumns: width } }));
  expect(await render(37)).toContain('Loading history');
  expect(await render(37)).not.toContain('history-more-');
  loadError = true;
  const output = await render(37);
  expect(output).toContain('Retry loading');
  const pending = [JSON.parse(output)];
  let more;
  while (pending.length) {
    const element = pending.pop();
    if (element?.type === 'Button' && element.props.key === 'history-more-' + commit.oid) more = element;
    if (element?.children) pending.push(...element.children);
  }
  expect(Boolean(more)).toBe(true);
  await $.ui.press({ plugin: more.press.plugin, key: more.props.key });
  expect(clicks).toBe(1);
  expect(await render()).toContain('Loading history');
  expect(await render()).not.toContain('history-more-');
  loading = false;
  commit.shallowBoundary = true;
  expect(await render()).toContain('shallow boundary');
  expect(await render()).not.toContain('history-more-');
  commit.shallowBoundary = false;
  searching = true;
  expect(await render()).toContain('Search match');
  expect(await render()).not.toContain('history-more-');
  searching = false;
  snapshot = { ...snapshot, hasMore: false };
  expect(await render()).toContain('Parent history unavailable');
  expect(await render()).not.toContain('history-more-');
  snapshot = { ...snapshot, commits: Array(5000).fill(commit) };
  expect(await render()).toContain('5,000-commit limit');
  expect(await render()).not.toContain('history-more-');
  snapshot = { ...snapshot, commits: [commit, parent] };
  expect(await render()).not.toContain('history-more-');
  expect(await render()).not.toContain('Parent history unavailable');
});
