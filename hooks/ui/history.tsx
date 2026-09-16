import type { Elements } from 'claude-code';
import type { Commit, HistorySnapshot } from '../git/history.ts';
import type { Columns } from '../config/preferences.ts';
import { graphGlyphs, type GraphRow } from '../graph/layout.ts';
import { historyBadges, historyRowParts } from './history-row.ts';
import { badgeTextColour, laneColour, refColours } from './colours.ts';
import { clip } from './text.ts';

export function renderHistoryRow(ui: Elements['terminal'], commit: Commit, row: GraphRow, snapshot: HistorySnapshot, options: { width: number; firstLane: number; maxLanes: number; columns: Columns; selected: boolean; searching: boolean; loading?: boolean; loadError?: boolean }, inspect: () => void, loadMore?: () => void) {
  const { Box, Text, Button } = ui;
  const { width, firstLane, maxLanes, columns, selected, searching } = options;
  const glyphs = graphGlyphs(row, firstLane, maxLanes);
  const colour = laneColour(row.color);
  const refs = snapshot.refs.filter(ref => ref.commit === commit.oid);
  const isHead = commit.oid === snapshot.head;
  const badgesBelow = width < 64 && !searching;
  const graphWidth = maxLanes * 2;
  const prefixWidth = 2 + graphWidth + 1;
  const parts = historyRowParts(commit, badgesBelow ? [] : refs, columns, Math.max(1, width - prefixWidth), width, !badgesBelow && isHead, snapshot.branch);
  const continuation = !commit.shallowBoundary && row.boundary.length > 0;
  const canLoadMore = continuation && snapshot.hasMore && !options.loading && options.loadError && loadMore;
  const boundary = commit.shallowBoundary ? ' … shallow boundary' : continuation
    ? options.loading ? ' … Loading history…' : snapshot.hasMore ? options.loadError ? ' … Retry loading' : ' … Loading history…'
      : snapshot.commits.length >= 5000 ? ' … 5,000-commit limit reached' : ' … Parent history unavailable'
    : '';
  const boundaryWidth = Math.max(0, width - 2 - glyphs.edges.length);
  const lowerBadges = badgesBelow && !boundary ? historyBadges(refs, isHead, Math.max(0, width - 3 - glyphs.edges.length), snapshot.branch) : [];
  const badges = (values: typeof parts.badges) => values.map(badge => <Text><Text bold color={badgeTextColour} backgroundColor={badge.kind === 'branch' ? colour : refColours[badge.kind]}>{' ' + badge.label + ' '}</Text>{' '}</Text>);
  return <Box key={'row-' + commit.oid} flexDirection="column" height={2} flexShrink={0}>
    <Box height={1} flexShrink={0}>
      <Text color={colour} bold>{selected ? '› ' : '  '}</Text>
      <Box width={graphWidth} flexShrink={0}><Text bold>{glyphs.nodeCells.map(cell => <Text color={cell.color === undefined ? undefined : laneColour(cell.color)}>{cell.text === '●' && isHead ? '◉' : cell.text}</Text>)}{glyphs.overflow ? '…' : ''}</Text></Box><Text>{' '}</Text>
      <Text color={colour}>{parts.hash}{' '}</Text>
      {badges(parts.badges)}
      <Button key={'commit-' + commit.oid} plain label={parts.label} hover={{ color: colour, bold: true, underline: true }} onPress={inspect} />
    </Box>
    {searching ? <Text dimColor>{clip('  Search match · intervening ancestry omitted', width)}</Text> : <Box height={1} flexShrink={0}><Text>{'  '}{glyphs.edgeCells.map(cell => <Text color={cell.color === undefined ? undefined : laneColour(cell.color)}>{cell.text}</Text>)}{lowerBadges.length ? <Text>{' '}{badges(lowerBadges)}</Text> : null}</Text>{canLoadMore ? <Button key={'history-more-' + commit.oid} plain label={clip(boundary, boundaryWidth)} hover={{ color: colour, underline: true }} onPress={loadMore} /> : <Text dimColor>{clip(boundary, boundaryWidth)}</Text>}</Box>}
  </Box>;
}
