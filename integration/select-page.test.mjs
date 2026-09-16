import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectPage } from '../hooks/ui/select-page.ts';

test('every choice is reachable under the host limit while preserving off-page selection', () => {
  const choices = Array.from({ length: 200 }, (_, i) => ({ value: String(i), label: `Choice ${i}` }));
  const seen = new Set();
  for (let requested = 0; requested < 4; requested++) {
    const result = selectPage(choices, '199', requested);
    assert.ok(result.options.length <= 64);
    assert.ok(result.options.some(choice => choice.value === '199'));
    for (const choice of result.options) seen.add(choice.value);
    assert.equal(new Set(result.options.map(choice => choice.value)).size, result.options.length);
  }
  assert.equal(seen.size, 200);
  assert.equal(selectPage(choices.slice(0, 1), '0', 3).page, 0);
});
