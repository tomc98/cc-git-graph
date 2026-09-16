import { test } from 'node:test';
import assert from 'node:assert/strict';
import { host } from './host.mjs';

test('the fixture transport returns the child result when it deliberately closes stdin early', async () => {
  const result = await host.run(['/bin/sh', '-c', "exec 0<&-; sleep 0.01; printf 'child receipt'; exit 7"], { stdin: 'x'.repeat(262144), timeoutMs: 5000 });
  assert.equal(result.exitCode, 7); assert.equal(result.stdout, 'child receipt');
  const empty = await host.run(['/usr/bin/true']); assert.equal(empty.exitCode, 0);
});
