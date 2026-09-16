export interface HistoryWindow { start: number; end: number; }

export function historyWindow(total: number, offset: number, bodyRows: number, headerBound: number, anchor?: number): HistoryWindow[] {
  const start = Math.min(total, Math.max(0, Math.floor((offset - headerBound) / 2) - 8));
  const end = Math.min(total, Math.max(start, Math.ceil((offset + bodyRows) / 2) + 8));
  const windows = [{ start, end }];
  if (anchor !== undefined && anchor >= 0 && anchor < total && (anchor < start || anchor >= end)) windows.push({ start: anchor, end: anchor + 1 });
  windows.sort((a, b) => a.start - b.start);
  return windows;
}
