import type { Elements } from 'claude-code';
import { clip } from './text.ts';

export interface LaneEditor { value: string; error?: string; }
export interface LaneControls {
  edit(): void;
  apply(value: string): void;
  cancel(): void;
}
export function laneFooterRows(editor: LaneEditor | undefined, constrained: boolean): number { return editor ? 5 : constrained ? 2 : 1; }

export function renderLaneFooter(ui: Elements['terminal'], options: { width: number; bodyRows: number; scrollOffset: number; laneOffset: number; laneCount: number; maxLanes: number; constrained?: boolean; editor?: LaneEditor }, change: (offset: number) => void, controls: LaneControls) {
  const { Box, Text, Button, Input } = ui;
  const { width, bodyRows, scrollOffset, laneOffset, laneCount, maxLanes, constrained = false, editor } = options;
  const rows = laneFooterRows(editor, constrained);
  const fitHint = `${maxLanes} lanes fit · widen pane for more`;
  // Counter the host's scroll offset and clear history under the entire footer.
  // The history tree reserves the same number of rows after its final commit.
  return <Box key="lane-footer" width={width} height={rows} flexShrink={0} marginLeft={-width}
    marginTop={scrollOffset + Math.max(0, bodyRows - rows)}>
    <Box width={width} flexShrink={0} flexDirection="column">{Array.from({ length: rows }, () => <Text>{' '.repeat(width)}</Text>)}</Box>
    <Box width={width} flexShrink={0} marginLeft={-width} flexDirection="column">
      <Box height={1} gap={1}>
        <Button key="lanes-left" label={width < 50 ? '←' : 'Lanes ←'} onPress={() => change(Math.max(0, laneOffset - maxLanes))} />
        <Button key="lanes-count" label={`${laneOffset + 1}–${Math.min(laneCount, laneOffset + maxLanes)}`} onPress={editor ? controls.cancel : controls.edit} />
        <Text>of {laneCount}</Text>
        <Button key="lanes-right" label="→" onPress={() => change(Math.min(Math.max(0, laneCount - maxLanes), laneOffset + maxLanes))} />
      </Box>
      {editor ? <Box flexDirection="column">
        <Box height={1} gap={1}>
          <Button key="lanes-auto" label="Auto" onPress={() => controls.apply('auto')} />
          <Button key="lanes-all" label="All" onPress={() => controls.apply('all')} />
        </Box>
        <Input key="lanes-input" label="Max lanes" submitLabel="apply" value={editor.value} onInput={value => { editor.value = value; }} onSubmit={controls.apply} />
        <Box height={1} gap={1}>
          <Button key="lanes-apply" label="Apply" onPress={() => controls.apply(editor.value)} />
          <Button key="lanes-cancel" label="Cancel" onPress={controls.cancel} />
        </Box>
        <Text color={editor.error ? 'yellow' : undefined} dimColor={!editor.error}>{clip(editor.error || (constrained ? fitHint : 'Number, Auto or All · saved per repo'), width)}</Text>
      </Box> : constrained && <Text dimColor>{clip(fitHint, width)}</Text>}
    </Box>
  </Box>;
}
