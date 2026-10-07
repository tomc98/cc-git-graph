import type { Elements } from 'claude-code';
import type { ReviewController } from './controller.ts';
import { clip, safeText } from '../ui/text.ts';
import { laneLayout, parseLaneLimit } from '../ui/lane-settings.ts';
import { renderLaneFooter, laneFooterRows } from '../ui/lane-footer.tsx';
import { renderHistoryRow } from '../ui/history.tsx';

export function renderReview(ui: Elements['terminal'], controller: ReviewController, width: number, geometry = { bodyRows: 0, scrollOffset: 0 }) {
  const { Box, Text, Button, Input } = ui;
  controller.rendered(geometry.scrollOffset);
  const view = controller.current, context = view?.context;
  const run = (work: () => Promise<unknown>) => { void controller.run(work); };
  const redraw = () => controller.host.redraw();
  if (controller.handoff) {
    const form = controller.handoff;
    return <Box flexDirection="column" width={width}>
      {form.stage !== 'sending' && <Button key="review-ask-back" label="Back to review" onPress={() => controller.back()} />}
      <Text bold>Ask Claude · {view?.file ? safeText(view.file.path) : safeText(context?.title ?? '')}</Text>
      {form.stage === 'editing' && <Input key="review-question" label="Question" value={form.question} onInput={v => { form.question = v; }} onSubmit={v => { form.question = v; redraw(); }} />}
      {form.stage === 'editing' && controller.mainView && <Button key="review-send" label="Send to main conversation" onPress={() => run(() => controller.send())} />}
      <Text>{form.stage === 'sending' ? 'Sending once…' : form.message ?? ''}</Text>
      <Text dimColor>{form.omitted ? 'Partial selected context' : 'Selected context'}</Text>
      {form.context.split('\n').map(line => <Text>{clip(line, width)}</Text>)}
    </Box>;
  }
  const graph = view && (view.tab === 'graph' || view.tab === 'commits') ? controller.graph : [];
  const preview = view?.preview?.binary ? ['Binary content; textual preview unavailable.'] : view?.preview?.text.split('\n');
  const laneCount = Math.max(0, ...graph.map(row => Math.max(row.lanes.length, row.next.length)));
  const { maxLanes, constrained } = laneLayout(width, laneCount, controller.laneLimit);
  controller.laneOffset = Math.min(controller.laneOffset, Math.max(0, laneCount - maxLanes));
  const showLanes = view?.tab === 'graph' && laneCount > 0 && geometry.bodyRows > 0;
  const footerRows = showLanes ? laneFooterRows(controller.laneEditor, constrained) : 0;
  const body = <Box flexDirection="column" width={width} flexShrink={0}>
    <Box gap={1} flexWrap="wrap">
      <Button key="review-back" label={controller.backLabel} onPress={() => controller.back()} />
      <Button key="review-close" label="Close" onPress={() => run(() => controller.close())} />
      <Button key="review-follow" label={'Follow Claude: ' + (controller.followClaude ? 'on' : 'off')} onPress={() => { controller.followClaude = !controller.followClaude; redraw(); }} />
    </Box>
    <Input key="review-url" label="Open URL" value={controller.input} onInput={v => { controller.input = v; }} onSubmit={v => run(() => controller.open(v.trim()))} />
    {controller.pending && <Button key="review-pending" label="Show Claude's suggested selection" onPress={() => { const p = controller.pending!; run(() => controller.open(p.target, p.options)); }} />}
    {controller.loading && <Text>Loading selected review…</Text>}
    {controller.error && <Text color="yellow">{safeText(controller.error)}</Text>}
    {context && view && <Box flexDirection="column">
      <Text bold>{clip(context.title, width)}</Text>
      <Text dimColor>{clip(context.repository.root, width)}</Text>
      <Text>{clip(context.diff.label, width)}</Text>
      {context.notices.map(notice => <Text color="yellow">{clip(notice, width)}</Text>)}
      <Box gap={1} flexWrap="wrap">
        {(['graph', 'commits', 'files'] as const).map(tab => <Button key={'review-tab-' + tab} label={tab === view.tab ? tab.toUpperCase() : tab} onPress={() => run(() => controller.tab(tab))} />)}
        <Button key="review-refresh" label="Refresh snapshot" onPress={() => run(() => controller.open(context.target, context.local ? { repository: context.repository.root, mode: context.local.mode, base: context.base } : {}))} />
        {controller.mainView && <Button key="review-ask" label={view.lines ? 'Ask about lines' : view.file ? 'Ask about file' : context.pr ? 'Ask about PR' : 'Ask Claude'} onPress={() => controller.ask()} />}
        {view.link && <Button key="review-github" label="Open GitHub" onPress={() => run(() => controller.link(false))} />}
        {view.link && <Button key="review-copy" label="Copy link" onPress={() => run(() => controller.link(true))} />}
      </Box>
      <Box gap={1} flexWrap="wrap">
        <Button key="review-local-branch" label="Local branch" onPress={() => run(() => controller.local('branch'))} />
        <Button key="review-local-all" label="All local changes" onPress={() => run(() => controller.local('worktree'))} />
        <Button key="review-local-pending" label="Uncommitted" onPress={() => run(() => controller.local('uncommitted'))} />
        {context.local?.published && <Button key="review-published" label="Published PR" onPress={() => run(() => controller.open(context.local!.published!))} />}
        {context.pr && <Button key="review-stack" label="Stack to this PR" onPress={() => run(() => controller.open('stack ' + context.url))} />}
      </Box>
      {context.stack?.map(pr => <Button key={'review-stack-' + pr.number} label={clip(`#${pr.number} ${pr.title}`, width - 4)} onPress={() => run(() => controller.open(pr.html_url))} />)}
      {view.file && preview ? <Box flexDirection="column">
        <Text bold>{clip(view.file.path, width)}</Text>
        <Text dimColor>{view.preview?.complete ? 'Complete preview' : 'Partial preview · content limit reached'} · numbered preview lines</Text>
        <Input key="review-lines" label="Ask about lines (e.g. 10-25)" value={controller.lineInput} onInput={v => { controller.lineInput = v; }} onSubmit={v => { try { controller.setLines(v); } catch (e) { controller.error = String(e); redraw(); } }} />
        <Box gap={1}>
          {view.offset > 0 && <Button key="review-preview-prev" label="Previous" onPress={() => { view.offset = Math.max(0, view.offset - 100); redraw(); }} />}
          {view.offset + 100 < preview.length && <Button key="review-preview-next" label="Next" onPress={() => { view.offset += 100; redraw(); }} />}
          {view.lines && <Button key="review-lines-clear" label="Clear line selection" onPress={() => { view.lines = undefined; redraw(); }} />}
        </Box>
        {preview.slice(view.offset, view.offset + 100).map((line, i) => <Text color={view.lines && view.offset + i + 1 >= view.lines.start && view.offset + i + 1 <= view.lines.end ? 'yellow' : line.startsWith('+') ? 'green' : line.startsWith('-') ? 'red' : undefined}>{clip(`${view.offset + i + 1} ${line}`, width)}</Text>)}
      </Box> : view.tab === 'files' ? <Box flexDirection="column">
        <Text dimColor>Files {view.files ? view.files.offset + 1 : 0}–{(view.files?.offset ?? 0) + (view.files?.files.length ?? 0)}{view.files?.hasMore ? ' · more available' : ''}</Text>
        {view.files?.files.map((file, i) => <Button key={'review-file-' + i} label={clip(`${file.status} ${file.oldPath ? file.oldPath + ' → ' : ''}${file.path}`, width - 4)} onPress={() => run(() => controller.selectFile(file))} />)}
        {view.files?.hasMore && <Button key="review-files-next" label="Next files" onPress={() => run(() => controller.nextFiles())} />}
        {context.local?.mode !== 'branch' && context.local?.working.filter(f => f.kind === 'untracked').map((file, i) => <Button key={'review-untracked-' + i} label={clip('? ' + file.path, width - 4)} onPress={() => run(() => controller.selectFile({ status: '?', path: file.path }))} />)}
        {!view.files?.files.length && <Text dimColor>No tracked changes in this comparison.</Text>}
      </Box> : <Box flexDirection="column">
        <Text dimColor>{context.snapshot.commits.length} commits loaded · selected comparison {context.base.slice(0, 8)} → {context.head.slice(0, 8)}</Text>
        <Box gap={1}>
          {view.graphOffset > 0 && <Button key="review-graph-prev" label="Newer" onPress={() => { view.graphOffset = Math.max(0, view.graphOffset - 100); redraw(); }} />}
          {view.graphOffset + 100 < graph.length && <Button key="review-graph-next" label="Older loaded" onPress={() => { view.graphOffset += 100; redraw(); }} />}
          {context.commitsMore && <Button key="review-more" label="Load more commits" onPress={() => run(() => controller.moreCommits())} />}
        </Box>
        {context.snapshot.commits.slice(view.graphOffset, view.graphOffset + 100).map((commit, i) => view.tab === 'commits'
          ? <Button key={'review-commit-' + i} label={clip(commit.oid.slice(0, 8) + ' ' + commit.subject, width - 4)} onPress={() => run(() => controller.selectCommit(commit.oid))} />
          : renderHistoryRow(ui, commit, graph[view.graphOffset + i]!, context.snapshot, { width, firstLane: controller.laneOffset, maxLanes, columns: 'auto', selected: commit.oid === context.head, searching: false }, () => run(() => controller.selectCommit(commit.oid))))}
      </Box>}
    </Box>}
    {showLanes && <Box height={footerRows} />}
  </Box>;
  return <Box flexDirection="row" width={width}>{body}{controller.restoreOffset > 0 && <Box key="review-scroll-anchor" width={1} height={1} flexShrink={0} marginLeft={-1} marginTop={controller.restoreOffset} />}{showLanes && renderLaneFooter(ui, { width, ...geometry, laneOffset: controller.laneOffset, laneCount, maxLanes, constrained, editor: controller.laneEditor }, offset => { controller.laneOffset = offset; redraw(); }, {
    edit: () => { controller.laneEditor = { value: String(controller.laneLimit ?? 'auto') }; redraw(); },
    cancel: () => { controller.laneEditor = undefined; redraw(); },
    apply: value => { const limit = parseLaneLimit(value); if (limit === false) { if (controller.laneEditor) controller.laneEditor.error = 'Use Auto, All or a positive integer.'; redraw(); } else run(() => controller.lanes(limit)); },
  })}</Box>;
}
