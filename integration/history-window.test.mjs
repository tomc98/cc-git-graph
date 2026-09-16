import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyWindow } from '../hooks/ui/history-window.ts';

test('virtual history keeps complete row height and covers every visible row at any header height', () => {
  const total = 5000, bound = 52;
  for (const header of [0, 3, 11, 25, 52]) {
    for (const body of [10, 18, 43, 100]) {
      for (const offset of [0, 1, 77, 3000, header + total * 2 - body]) {
        const windows = historyWindow(total, offset, body, bound, 4000);
        let cells = 0, previous = 0, rendered = 0;
        for (const range of windows) {
          assert.ok(range.start >= previous && range.end <= total);
          cells += (range.start - previous) * 2 + (range.end - range.start) * 2;
          rendered += range.end - range.start;
          previous = range.end;
        }
        cells += (total - previous) * 2;
        assert.equal(cells, 10000);
        assert.ok(rendered <= Math.ceil((body + bound) / 2) + 18);
        for (let row = Math.max(0, Math.floor((offset - header) / 2)); row < Math.min(total, Math.ceil((offset + body - header) / 2)); row++) {
          assert.ok(windows.some(range => row >= range.start && row < range.end), `missing ${row} at ${offset}`);
        }
        assert.ok(windows.some(range => 4000 >= range.start && 4000 < range.end));
      }
    }
  }
  assert.deepEqual(historyWindow(0, 500, 43, bound), [{ start: 0, end: 0 }]);
});
