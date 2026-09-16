import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DetailCache } from '../hooks/cache.ts';

test('detail cache stays within its budget, evicts least-recently-used data and does not retain failures', async () => {
  const cache = new DetailCache(950); let reads = 0;
  await cache.read('first', async () => { reads++; return 'one'; });
  await cache.read('second', async () => { reads++; return 'two'; });
  assert.equal(await cache.read('first', async () => { reads++; return 'wrong'; }), 'one');
  cache.set('third', 'x'.repeat(100));
  assert.equal(cache.get('second'), undefined); assert.equal(cache.get('first'), 'one'); assert.ok(cache.bytes <= 1024); assert.equal(reads, 2);
  cache.set('too-big', 'x'.repeat(2000)); assert.equal(cache.get('too-big'), undefined);
  await assert.rejects(cache.read('failure', async () => { throw new Error('Missing object'); }), /Missing object/);
  assert.equal(await cache.read('failure', async () => 'now available'), 'now available');
});
