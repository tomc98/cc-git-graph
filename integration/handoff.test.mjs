import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandoff, handoffText, sendHandoff } from '../hooks/handoff.ts';

test('Ask Claude is inert until Send and freezes only the bounded selected context', async () => {
  let calls = 0, release, received;
  const form = createHandoff({ repository: '/fixture/selected-repo', comparison: 'HEAD → index', path: 'file.txt', patch: { text: '+selected change\n\u001b[31m', complete: true, binary: false, totalBytes: 25 } });
  form.question = 'Explain why this changed.';
  assert.match(form.context, /selected-repo/); assert.match(form.context, /\\u001b/); assert.equal(calls, 0);
  const expected = handoffText(form);
  const submit = async text => { calls++; received = text; await new Promise(resolve => { release = resolve; }); return { text }; };
  const pending = sendHandoff(form, submit); await sendHandoff(form, submit);
  assert.equal(calls, 1); assert.equal(form.stage, 'sending'); assert.equal(received, expected);
  release(); await pending; assert.equal(form.stage, 'accepted');
  await sendHandoff(form, submit); assert.equal(calls, 1);
});

test('partial context is declared, long questions are rejected and uncertain receipts are never retried', async () => {
  const form = createHandoff({ repository: '/fixture', patch: { text: 'a'.repeat(20000), complete: false, binary: false, totalBytes: 20000 } });
  assert.equal(form.omitted, true); assert.ok(form.context.length < 12100); assert.match(form.context, /omitted/);
  form.question = 'q'.repeat(4001); let calls = 0;
  await sendHandoff(form, async () => { calls++; return {}; }); assert.equal(calls, 0); assert.equal(form.stage, 'editing');
  form.question = 'Explain'; await sendHandoff(form, async () => { calls++; throw new Error('receipt lost'); });
  assert.equal(form.stage, 'unknown'); await sendHandoff(form, async () => { calls++; return {}; }); assert.equal(calls, 1);
  const dropped = createHandoff({ repository: '/fixture' });
  await sendHandoff(dropped, async () => ({ drop: 'Fixture policy' })); assert.equal(dropped.stage, 'dropped'); assert.match(dropped.message, /Fixture policy/);
});
