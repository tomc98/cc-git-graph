import type { Commit } from '../git/history.ts';

export interface GraphEdge { from: number; to: number; target: string; color: number; }
export interface GraphRow { oid: string; lane: number; color: number; colors: (number | null)[]; lanes: (string | null)[]; next: (string | null)[]; edges: GraphEdge[]; boundary: string[]; }
export interface GraphCell { text: string; color?: number; }

export function layout(commits: readonly Pick<Commit, 'oid' | 'parents'>[]): GraphRow[] {
  const loaded = new Set(commits.map(c => c.oid));
  let lanes: (string | null)[] = [];
  let colors: (number | null)[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];
  for (const commit of commits) {
    let lane = lanes.indexOf(commit.oid);
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = commit.oid;
      colors[lane] = nextColor++;
    }
    const color = colors[lane]!;
    const before = [...lanes];
    const next = [...lanes];
    const nextColors = [...colors];
    next[lane] = null;
    nextColors[lane] = null;
    const edges: GraphEdge[] = [];
    for (const [index, parent] of commit.parents.entries()) {
      let target = next.indexOf(parent);
      if (target < 0) {
        target = next[lane] === null ? lane : next.indexOf(null);
        if (target < 0) target = next.length;
        next[target] = parent;
        nextColors[target] = index === 0 ? color : nextColor++;
      }
      edges.push({ from: lane, to: target, target: parent, color: nextColors[target]! });
    }
    before.forEach((id, index) => {
      if (id !== null && index !== lane) edges.push({ from: index, to: next.indexOf(id), target: id, color: colors[index]! });
    });
    while (next.at(-1) === null) { next.pop(); nextColors.pop(); }
    rows.push({ oid: commit.oid, lane, color, colors: [...colors], lanes: before, next, edges, boundary: commit.parents.filter(p => !loaded.has(p)) });
    lanes = next;
    colors = nextColors;
  }
  return rows;
}

export function graphGlyphs(row: GraphRow, firstLane = 0, maxLanes = 10) {
  const count = Math.max(row.lanes.length, row.next.length);
  const end = Math.min(count, firstLane + maxLanes);
  const nodeCells: GraphCell[] = [];
  const masks = Array.from({ length: Math.max(0, count * 2 - 1) }, () => 0);
  const colors: (number | undefined)[] = [];
  const priorities: number[] = [];
  const add = (cell: number, mask: number, color: number, priority: number) => {
    masks[cell] = (masks[cell] ?? 0) | mask;
    // At crossings a continuing vertical lane stays visible over a horizontal edge.
    if (priority > (priorities[cell] ?? 0)) { colors[cell] = color; priorities[cell] = priority; }
  };
  for (const edge of row.edges) {
    const from = edge.from * 2, to = edge.to * 2;
    if (from === to) add(from, 3, edge.color, 3);
    else {
      add(from, 1 | (to > from ? 8 : 4), edge.color, 2);
      add(to, 2 | (to > from ? 4 : 8), edge.color, 2);
      for (let cell = Math.min(from, to) + 1; cell < Math.max(from, to); cell++) add(cell, 12, edge.color, 1);
    }
  }
  for (let lane = firstLane; lane < end; lane++) {
    if (nodeCells.length) nodeCells.push({ text: ' ' });
    nodeCells.push({ text: lane === row.lane ? '●' : row.lanes[lane] ? '│' : ' ', color: row.colors[lane] ?? undefined });
  }
  const glyphs = [' ', '╵', '╷', '│', '╴', '┘', '┐', '┤', '╶', '└', '┌', '├', '─', '┴', '┬', '┼'];
  const edgeCells = masks.slice(firstLane * 2, end * 2 - 1).map((mask, index) => ({ text: glyphs[mask]!, color: colors[firstLane * 2 + index] }));
  return { node: nodeCells.map(cell => cell.text).join(''), edges: edgeCells.map(cell => cell.text).join(''), nodeCells, edgeCells, overflow: firstLane > 0 || end < count };
}
