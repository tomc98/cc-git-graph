import { expect, test, tier } from 'claude-code/testing';
import type { RenderInput } from 'claude-code';
import { renderLaneFooter } from '../hooks/ui/lane-footer.tsx';

tier('user');

test('lane footer stays at the viewport bottom and its buttons clamp lane movement', async ($, on) => {
  let laneOffset = 0;
  const pane: RenderInput<'Pane', 'terminal'> = { component: 'Pane', surface: 'terminal', requestId: 'lane-footer-test', viewport: { columns: 200, rows: 48 },
    props: { title: 'Lanes', isFocused: false, bodyColumns: 89, placement: 'dock', scroll: { offset: 0, bodyRows: 43 }, view: {} } };
  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== 'lane-footer-test' || e.surface !== 'terminal') return next(e);
    return renderLaneFooter($.ui.resolve(e), { width: e.props.bodyColumns, bodyRows: e.props.scroll.bodyRows,
      scrollOffset: e.props.scroll.offset, laneOffset, laneCount: 12, maxLanes: 8 }, offset => { laneOffset = offset; }, { edit: () => {}, apply: () => {}, cancel: () => {} });
  });
  for (const width of [37, 63, 89]) {
    for (const offset of [0, 100, 9000]) {
      const output = JSON.parse(JSON.stringify(await $.ui.render({ ...pane, props: { ...pane.props, bodyColumns: width, scroll: { offset, bodyRows: 43 } } })));
      expect(output.props.marginTop - offset).toBe(42);
      expect(output.props.marginLeft).toBe(-width);
      expect(output.props.height).toBe(1);
      const buttons = output.children[1].children[0].children.filter((element: { type: string }) => element.type === 'Button');
      expect(buttons.length).toBe(3);
      await $.ui.press({ plugin: buttons[2].press.plugin, key: 'lanes-right' });
      expect(laneOffset).toBe(4);
      const right = JSON.parse(JSON.stringify(await $.ui.render(pane))).children[1].children[0].children.find((element: { type: string; props: { key: string } }) => element.type === 'Button' && element.props.key === 'lanes-right');
      await $.ui.press({ plugin: right.press.plugin, key: 'lanes-right' });
      expect(laneOffset).toBe(4);
      const left = JSON.parse(JSON.stringify(await $.ui.render(pane))).children[1].children[0].children.find((element: { type: string; props: { key: string } }) => element.type === 'Button' && element.props.key === 'lanes-left');
      await $.ui.press({ plugin: left.press.plugin, key: 'lanes-left' });
      expect(laneOffset).toBe(0);
    }
  }
});
