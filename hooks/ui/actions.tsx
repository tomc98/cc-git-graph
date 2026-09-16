import type { Elements } from 'claude-code';
import type { PanelController } from '../controller.ts';
import { actions } from '../git/operations.ts';
import { safeText } from './text.ts';
import { selectPage } from './select-page.ts';

const labels: Record<string, string> = { name: 'New name', message: 'Message', branch: 'Local branch', tag: 'Tag', remote: 'Remote', remoteBranch: 'Remote branch', url: 'URL / local path', parent: 'Mainline parent (merge only)', mode: 'Reset mode', strategy: 'Pull strategy', includeUntracked: 'Include untracked', discardScope: 'Discard scope', stash: 'Stash identity' };

export function renderActions(elements: Elements['terminal'], controller: PanelController, width: number) {
  const { Box, Text, Button, Input, Select } = elements;
  const form = controller.action!;
  const definition = actions.find(action => action[0] === form.id)!;
  const options = form.options;
  const choices: Record<string, { value: string; label: string }[]> = {
    branch: (options?.branches ?? []).map(value => ({ value, label: safeText(value) })),
    tag: (options?.tags ?? []).map(value => ({ value, label: safeText(value) })),
    remote: (options?.remotes ?? []).map(remote => ({ value: remote.name, label: safeText(remote.name) })),
    stash: (options?.stashes ?? []).map(stash => ({ value: stash.oid, label: safeText(`${stash.selector} ${stash.oid.slice(0, 12)} ${stash.subject}`) })),
    mode: ['soft', 'mixed', 'hard'].map(value => ({ value, label: value })),
    strategy: [{ value: 'ff-only', label: 'Fast-forward only' }, { value: 'merge', label: 'Merge' }, { value: 'rebase', label: 'Rebase' }],
    includeUntracked: [{ value: 'no', label: 'Tracked only' }, { value: 'yes', label: 'Tracked and untracked' }],
    discardScope: [{ value: 'worktree', label: 'Unstaged only (restore index)' }, { value: 'both', label: 'Staged and unstaged (restore HEAD)' }],
  };
  return <Box flexDirection="column" width={width}>
    <Box gap={1}>
      {!controller.mutating && <Button key="action-back" label="Back" onPress={() => controller.dismissAction()} />}
      <Button key="action-close" label="Close panel" onPress={() => { void controller.close(); }} /><Text bold>Git actions</Text>
    </Box>
    <Text bold>{safeText(form.repository.root)}</Text>
    {form.target && <Text dimColor>Selected commit: {form.target}</Text>}
    {controller.isWorking && <Text color="yellow">Execute becomes available when Claude's current turn finishes.</Text>}
    {form.stage === 'editing' || form.stage === 'preparing' ? <Box flexDirection="column">
      <Select key="action-kind" label="Action" value={form.id} options={actions.map(action => ({ value: action[0], label: action[1] }))} onSelect={value => controller.editAction('action', value)} />
      {definition[2].map(key => {
        const list = choices[key];
        if (!list) return <Input key={'action-' + key} label={labels[key] || key} value={form.values[key] || ''} onInput={value => controller.editAction(key, value)} onSubmit={value => controller.editAction(key, value)} />;
        if (['branch', 'tag', 'remote', 'stash'].includes(key) && !options) return <Text dimColor>{form.optionsLoading ? 'Loading repository choices…' : 'Repository choices could not be loaded.'}</Text>;
        if (!list.length) return <Text dimColor>No {labels[key]?.toLowerCase() || key} is available.</Text>;
        const page = selectPage(list, form.values[key] || '', form.optionPages?.[key]);
        const move = (offset: number) => { form.optionPages = { ...form.optionPages, [key]: page.page + offset }; controller.host.redraw(); };
        return <Box flexDirection="column">
          <Select key={'action-' + key} label={labels[key] || key} value={form.values[key] || ''} options={page.options} onSelect={value => controller.editAction(key, value)} />
          {page.count > 1 && <Box gap={1} flexWrap="wrap">
            {page.page > 0 && <Button key={'previous-' + key} label={'Previous ' + key + ' choices'} onPress={() => move(-1)} />}
            <Text>{labels[key] || key} page {page.page + 1} of {page.count}</Text>
            {page.page + 1 < page.count && <Button key={'next-' + key} label={'Next ' + key + ' choices'} onPress={() => move(1)} />}
          </Box>}
        </Box>;
      })}
      {form.paths.length > 0 && <Text>Selected paths: {form.paths.map(safeText).join(', ')}</Text>}
      {form.optionsLoading ? <Text>Loading repository choices…</Text> : !options ? <Button key="action-options-retry" label="Retry repository choices" onPress={() => { void controller.retryActionOptions(); }} /> : form.stage === 'preparing' ? <Text>Preparing the target and effect preview…</Text> : <Button key="action-preview" label="Preview action" onPress={() => { void controller.previewAction(); }} />}
    </Box> : <Box flexDirection="column">
      <Text bold>{definition[1]}</Text>
      {form.intent?.summary.map(line => <Text>{safeText(line)}</Text>)}
      {definition[2].filter(key => key === 'message').map(key => <Text>Message: {safeText(form.values[key] || '')}</Text>)}
      {form.stage === 'ready' && <Box gap={1} flexWrap="wrap">
        <Button key="action-edit" label="Edit" onPress={() => controller.editAction('action', form.id)} />
        {!controller.isWorking && <Button key="action-execute" label="Confirm and execute" onPress={() => { void controller.submitAction(); }} />}
      </Box>}
      {form.stage === 'running' && <Text>Git is running in this checkout. Closing the panel does not cancel it.</Text>}
      {form.outcome && <Box flexDirection="column">
        <Text bold color={form.outcome.status === 'succeeded' ? 'green' : 'yellow'}>{form.outcome.status}</Text>
        {form.outcome.message.split('\n').map(line => <Text>{safeText(line)}</Text>)}
        {form.outcome.state && <Text dimColor>Observed HEAD: {form.outcome.state.head || 'unborn'} · {form.outcome.state.dirtyCount} changed paths</Text>}
        {form.outcome.status === 'stale' && <Button key="action-review-again" label="Review action again" onPress={() => controller.editAction('action', form.id)} />}
        <Button key="action-reconcile" label={form.outcome.backgroundTaskId ? 'Check existing task' : 'Reconcile current state'} onPress={() => { void controller.reconcileAction(); }} />
        {form.outcome.state?.operation && form.outcome.state.operation !== 'sequencer' && !controller.mutating && <Box gap={1}>
          <Button key="action-continue" label="Prepare Continue" onPress={() => { void controller.openActions('continue'); }} />
          <Button key="action-abort" label="Prepare Abort" onPress={() => { void controller.openActions('abort'); }} />
        </Box>}
      </Box>}
    </Box>}
    {form.error && <Text color="yellow">{safeText(form.error)}</Text>}
  </Box>;
}
