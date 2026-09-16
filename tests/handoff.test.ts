import { expect, test, tier } from 'claude-code/testing';
import type { RenderInput } from 'claude-code';
import type { PanelController } from '../hooks/controller.ts';
import { renderHandoff } from '../hooks/ui/handoff.tsx';

tier('user');

test('handoff render removes Send when the visible transcript is an agent', async ($, on) => {
  const controller = {
    mainView: true,
    handoff: { repository: '/fixture', question: 'Explain this commit', context: 'Fixture context', omitted: false, stage: 'editing' },
    host: { redraw() {} },
  } as PanelController;
  const pane: RenderInput<'Pane', 'terminal'> = {
    component: 'Pane', surface: 'terminal', requestId: 'handoff-proof', viewport: { columns: 200, rows: 48 },
    props: { title: 'Handoff proof', isFocused: false, bodyColumns: 89, placement: 'dock', scroll: { offset: 0, bodyRows: 43 }, view: {} },
  };
  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== 'handoff-proof' || e.surface !== 'terminal') return next(e);
    controller.mainView = !e.props.view.agentId;
    return renderHandoff($.ui.resolve(e), controller);
  });
  expect(JSON.stringify(await $.ui.render(pane))).toContain('Send to main conversation');
  const agent = JSON.stringify(await $.ui.render({ ...pane, props: { ...pane.props, view: { agentId: 'fixture-agent' } } }));
  expect(agent).toContain('Return to the main conversation to send.');
  expect(agent.includes('handoff-send')).toBe(false);
  expect(JSON.stringify(await $.ui.render(pane))).toContain('Send to main conversation');
});
