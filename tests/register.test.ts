import { describe, expect, mock, test, tier } from 'claude-code/testing';
import type { RenderInput } from 'claude-code';

tier('user');

const band: RenderInput<'AbovePrompt', 'terminal'> = {
  component: 'AbovePrompt', surface: 'terminal', requestId: 'above-prompt',
  viewport: { columns: 200, rows: 48 },
  props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 200, scroll: { offset: 0, bodyRows: 8 }, view: {} },
};

describe('conversation panel', () => {
  test('closed state is idle; a native button toggles one pane without submitting a prompt', async ($, on) => {
    const clock = mock.clock(on);
    mock.env(on, { HOME: '/test' });
    mock.store(on);
    const opened: string[] = [];
    const closed: string[] = [];
    let processCalls = 0;
    let promptCalls = 0;
    on('session.cwd', () => ({ value: '/test/not-a-repo' }));
    on('fs.exists', (_, e) => ({ value: !e.path.endsWith('cc-git-graph.json') }));
    on('process.run', (_, e) => {
      processCalls++;
      return { value: e.argv[0] === '/bin/pwd' ? { exitCode: 0, stdout: '/test/not-a-repo\n', stderr: '' } : { exitCode: 128, stdout: '', stderr: 'not a git repository' } };
    });
    on('prompt.submit', () => { promptCalls++; return { text: '' }; });
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['Existing plugin content'] }));
    on('ui.open', (_, e) => { opened.push(e.id); return { value: undefined }; });
    on('ui.close', (_, e) => { closed.push(e.id); return { value: undefined }; });
    on('ui.invalidate', () => ({ value: undefined }));

    const initial = await $.ui.render(band);
    expect(JSON.stringify(initial)).toContain('Existing plugin content');
    expect(opened).toEqual([]);
    expect(processCalls).toBe(0);
    await $.ui.press({ plugin: 'cc-git-graph', key: 'git-graph-toggle' });
    await clock.settle();
    expect(opened).toEqual(['cc-git-graph']);
    const after = await $.ui.render(band);
    expect(JSON.stringify(after)).toContain('Git Graph: open');
    await $.ui.press({ plugin: 'cc-git-graph', key: 'git-graph-toggle' });
    await clock.settle();
    expect(closed).toEqual(['cc-git-graph']);
    const callsAtClose = processCalls;
    await clock.advance(10000);
    expect(processCalls).toBe(callsAtClose);
    expect(promptCalls).toBe(0);
  });

  test('a survey keeps its band without a competing graph launcher', async ($, on) => {
    const previous = { type: 'Text' as const, props: {}, children: ['Survey content'] };
    on('ui.render', () => previous);
    expect(await $.ui.render({ ...band, props: { ...band.props, hasSurvey: true } })).toEqual(previous);
  });

  test('a retained pane after hot reload restores its controller without opening another pane', async ($, on) => {
    const clock = mock.clock(on);
    mock.env(on, { HOME: '/test' });
    mock.store(on);
    on('ui.render', () => ({ type: 'Text', props: {}, children: [] }));
    let opens = 0, reads = 0, redraws = 0;
    on('session.cwd', () => ({ value: '/test/not-a-repo' }));
    on('fs.exists', (_, e) => ({ value: !e.path.endsWith('cc-git-graph.json') }));
    on('process.run', (_, e) => { reads++; return { value: e.argv[0] === '/bin/pwd' ? { exitCode: 0, stdout: '/test/not-a-repo\n', stderr: '' } : { exitCode: 128, stdout: '', stderr: 'not a git repository' } }; });
    on('ui.open', () => { opens++; return { value: undefined }; });
    on('ui.close', () => ({ value: undefined }));
    on('ui.invalidate', () => { redraws++; return { value: undefined }; });
    const pane: RenderInput<'Pane', 'terminal'> = { component: 'Pane', surface: 'terminal', requestId: 'cc-git-graph', viewport: band.viewport,
      props: { title: 'Git Graph', isFocused: false, bodyColumns: 89, placement: 'dock', scroll: { offset: 0, bodyRows: 43 }, view: {} } };
    await $.ui.render(pane); await clock.settle();
    expect(reads > 0).toBe(true); expect(opens).toBe(0);
    expect(JSON.stringify(await $.ui.render(band))).toContain('Git Graph: open');
    expect(JSON.stringify(await $.ui.render(pane))).toContain('not a Git repository');
    const beforeLayout = redraws;
    await clock.advance(50);
    expect(redraws).toBe(beforeLayout + 1);
    await $.ui.render(pane);
    await clock.advance(50);
    expect(redraws).toBe(beforeLayout + 1);
    await $.ui.render({ ...pane, props: { ...pane.props, bodyColumns: 70 } });
    await clock.advance(50);
    expect(redraws).toBe(beforeLayout + 2);
    await $.ui.render({ ...pane, props: { ...pane.props, bodyColumns: 60 } });
    await $.ui.press({ plugin: 'cc-git-graph', key: 'git-graph-toggle' });
    await clock.settle();
    const atClose = redraws;
    await clock.advance(50);
    expect(redraws).toBe(atClose);
  });
});
