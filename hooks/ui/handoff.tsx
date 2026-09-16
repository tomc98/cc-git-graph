import type { Elements } from 'claude-code';
import type { PanelController } from '../controller.ts';
import { safeText } from './text.ts';

export function renderHandoff(ui: Elements['terminal'], controller: PanelController) {
  const { Box, Text, Button, Input } = ui;
  const form = controller.handoff!;
  return <Box flexDirection="column">
    <Box gap={1}><Button key="handoff-back" label="Back" onPress={() => { if (form.stage !== 'sending') { controller.handoff = undefined; controller.host.redraw(); } }} /><Text bold>Ask Claude · main conversation</Text></Box>
    <Text dimColor>{safeText(form.repository)}</Text>
    {form.stage === 'editing' && <Input key="handoff-question" label="Question" value={form.question} onInput={value => { form.question = value; form.message = undefined; controller.host.redraw(); }} onSubmit={value => { form.question = value; controller.host.redraw(); }} />}
    {form.stage === 'editing' && (controller.mainView ? <Button key="handoff-send" label="Send to main conversation" onPress={() => { void controller.submitHandoff(); }} /> : <Text color="yellow">Return to the main conversation to send.</Text>)}
    {form.stage === 'sending' && <Text>Submitting once to the main conversation…</Text>}
    {form.message && <Text color={form.stage === 'accepted' ? 'green' : 'yellow'}>{safeText(form.message)}</Text>}
    <Text bold>Context to include · {form.omitted ? 'partial' : 'complete selected preview'}</Text>
    {form.context.split('\n').map(line => <Text>{line}</Text>)}
  </Box>;
}
