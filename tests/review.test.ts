import { expect, test, mock, tier } from 'claude-code/testing';
import type { RenderInput } from 'claude-code';
import { ReviewController } from '../hooks/review/controller.ts';
import { renderReview } from '../hooks/review/view.tsx';
import type { ReviewContext } from '../hooks/review/service.ts';

tier('user');

test('model selection tool returns state without opening a pane or sending a prompt', async ($, on) => {
  let opens = 0, prompts = 0;
  on('ui.open', () => { opens++; return { value: undefined }; });
  on('prompt.submit', () => { prompts++; return { text: '' }; });
  const result = await $.tool.call({ tool: 'mcp__cc-git-graph__graph_selection' });
  expect(result.text).toContain('followClaude');
  expect(opens).toBe(0); expect(prompts).toBe(0);
});

test('native review buttons keep follow mode, selected file and Ask context under user control', async ($, on) => {
  mock.clock(on);
  on('ui.invalidate', () => ({ value: undefined }));
  on('ui.scroll', () => ({}));
  let prompts = 0;
  const controller = new ReviewController({ root: '/plugin', run: async () => ({ exitCode: 0, stdout: '', stderr: '' }), read: async () => '', exists: async () => false,
    cwd: async () => '/repo', home: async () => '/home', configDirectory: async () => undefined, open: async () => {}, close: async () => {}, redraw: () => {}, after: () => ({ cancel() {} }), submitPrompt: async text => { prompts++; return { text }; } });
  const context: ReviewContext = { id: 'test', target: 'https://github.com/example/project/pull/1', kind: 'pr', title: 'Example PR', repository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', identity: 'repo', bare: false, shallow: false, objectFormat: 'sha1' }, github: { owner: 'example', name: 'project' }, base: 'a'.repeat(40), head: 'b'.repeat(40), comparison: { kind: 'trees', from: 'a'.repeat(40), to: 'b'.repeat(40) }, diff: { args: ['a'.repeat(40), 'b'.repeat(40)], immutable: true, label: 'base → head' }, notices: [], snapshot: { commits: [], roots: [], refs: [], hasMore: false }, commitsPage: 0, commitsMore: false };
  controller.active = true;
  controller.current = { context, tab: 'files', offset: 0, graphOffset: 0, file: { path: 'src/a.ts', status: 'M' }, preview: { text: '+hello', complete: true, binary: false, totalBytes: 6 } };
  const pane: RenderInput<'Pane', 'terminal'> = { component: 'Pane', surface: 'terminal', requestId: 'review-proof', viewport: { columns: 160, rows: 40 }, props: { title: 'Review', isFocused: false, bodyColumns: 75, placement: 'dock', scroll: { offset: 0, bodyRows: 35 }, view: {} } };
  on('ui.render', { component: 'Pane' }, ($, e, next) => e.requestId === 'review-proof' && e.surface === 'terminal' ? renderReview($.ui.resolve(e), controller, e.props.bodyColumns) : next(e));
  const rendered = await $.ui.render(pane);
  expect(JSON.stringify(rendered)).toContain('Example PR');
  const queue = [rendered] as any[];
  let plugin = '';
  while (queue.length) { const node = queue.pop(); if (node?.props?.key === 'review-follow') plugin = node.press.plugin; if (node?.children) queue.push(...node.children); }
  expect(Boolean(plugin)).toBe(true);
  await $.ui.press({ plugin, key: 'review-follow' });
  expect(controller.followClaude).toBe(false);
  await $.ui.press({ plugin, key: 'review-ask' });
  expect(controller.handoff?.context).toContain('src/a.ts');
  expect(controller.handoff?.context).toContain(context.head);
  expect(prompts).toBe(0);
  await $.ui.render(pane);
  await $.ui.press({ plugin, key: 'review-send' });
  expect(prompts).toBe(1);
});
