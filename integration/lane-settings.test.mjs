import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laneLayout, parseLaneLimit } from '../hooks/ui/lane-settings.ts';

test('requested lanes grow beyond eight and adapt to available width without losing the preference', () => {
  assert.equal(laneLayout(89, 30).maxLanes, 8);
  assert.equal(laneLayout(89, 30, 25).maxLanes, 25);
  assert.deepEqual(laneLayout(89, 30, 'all'), { maxLanes: 30, constrained: false });
  assert.deepEqual(laneLayout(39, 30, 25), { maxLanes: 7, constrained: true });
  assert.equal(laneLayout(89, 30, 25).maxLanes, 25);
  assert.equal(laneLayout(89, 3, 25).maxLanes, 3);
  assert.equal(laneLayout(89, 15, 'all').maxLanes, 15);
  for (const width of [37, 39, 76, 89, 150]) {
    const { maxLanes } = laneLayout(width, 1000, 'all');
    assert.ok(maxLanes * 2 + 24 <= width);
  }
});

test('lane input accepts Auto, All or positive integers and rejects ambiguous numbers', () => {
  assert.equal(parseLaneLimit(' Auto '), undefined);
  assert.equal(parseLaneLimit('ALL'), 'all');
  assert.equal(parseLaneLimit(' 25 '), 25);
  for (const text of ['', '0', '-1', '2.5', '1e3', '12px', 'Infinity', '9007199254740992'])
    assert.equal(parseLaneLimit(text), false, text);
});
