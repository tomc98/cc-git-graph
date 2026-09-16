import type { Commit, Ref } from '../git/history.ts';
import type { Columns } from '../config/preferences.ts';
import { cellWidth, clip } from './text.ts';

export interface RefBadge { kind: Ref['kind'] | 'head' | 'more'; label: string; }

export function historyBadges(refs: readonly Ref[], isHead: boolean, columns: number, currentBranch?: string): RefBadge[] {
  const order = { branch: 0, remote: 1, tag: 2 };
  const candidates: RefBadge[] = [
    ...(isHead ? [{ kind: 'head' as const, label: 'HEAD' }] : []),
    ...[...refs].sort((a, b) => Number(b.name === 'refs/heads/' + currentBranch) - Number(a.name === 'refs/heads/' + currentBranch) || order[a.kind] - order[b.kind])
      .map(ref => ({ kind: ref.kind, label: (ref.kind === 'tag' ? 'tag: ' : '') + ref.name.replace(/^refs\/(heads|remotes|tags)\//, '') })),
  ];
  const badges: RefBadge[] = [];
  let remaining = columns;
  for (const [index, badge] of candidates.entries()) {
    const count = candidates.length - index - 1;
    const reserve = count ? String(count).length + 4 : 0;
    const available = remaining - reserve - 3;
    if (available < Math.min(4, cellWidth(badge.label))) {
      if (remaining >= String(count + 1).length + 4) badges.push({ kind: 'more', label: '+' + (count + 1) });
      break;
    }
    const label = clip(badge.label, available);
    badges.push({ ...badge, label });
    remaining -= cellWidth(label) + 3;
  }
  return badges;
}

export function historyRowParts(commit: Commit, refs: readonly Ref[], columns: Columns, width: number, layoutWidth: number, isHead: boolean, currentBranch?: string) {
  const hash = clip(commit.oid.slice(0, 7), Math.max(0, Math.min(7, width - 3)));
  const hashWidth = cellWidth(hash) + 1;
  const badges = historyBadges(refs, isHead, Math.max(0, Math.min(36, Math.floor(width * 0.45), width - hashWidth - 18)), currentBranch);
  const labelWidth = Math.max(1, width - hashWidth - badges.reduce((sum, badge) => sum + cellWidth(badge.label) + 3, 0));
  const timestamp = new Date(commit.timestamp * 1000);
  let author = columns !== 'compact' && layoutWidth >= 74 ? ' · ' + clip(commit.author, 14) : '';
  let date = (columns === 'full' || columns === 'auto') && layoutWidth >= 104 ? ' · ' + (Number.isNaN(timestamp.getTime()) ? 'unknown date' : timestamp.toISOString().slice(0, 10)) : '';
  if (cellWidth(author + date) + 12 > labelWidth) date = '';
  if (cellWidth(author) + 12 > labelWidth) author = '';
  const metadata = author + date;
  return { hash, badges, label: clip(commit.subject, labelWidth - cellWidth(metadata)) + metadata };
}
