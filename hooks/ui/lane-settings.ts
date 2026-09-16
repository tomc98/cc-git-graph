import type { LaneLimit } from '../config/preferences.ts';

export function laneLayout(width: number, count: number, limit?: LaneLimit) {
  const capacity = Math.max(1, Math.floor((width - 24) / 2));
  const requested = limit === 'all' ? count : limit ?? Math.max(1, Math.min(8, Math.floor(width / 5)));
  const maxLanes = Math.max(1, Math.min(requested, count, capacity));
  return { maxLanes, constrained: Math.min(requested, count) > capacity };
}

export function parseLaneLimit(input: string): LaneLimit | undefined | false {
  const text = input.trim().toLowerCase();
  if (text === 'auto') return undefined;
  if (text === 'all') return 'all';
  const count = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(count) && count > 0 ? count : false;
}
