// ---------------------------------------------------------------------------
// Behavioral tests for resolved runtime settings on the compact handoff.
//
// The compact receipt must echo the deadline and check timeout from the full
// result so a dropped or overridden value stays visible to the caller.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { compactHandoff } from './handoff.ts';

test('compact receipt echoes the deadline from runtime settings', () => {
 const receipt = compactHandoff({ runtime: { deadlineMs: 1200000, checkTimeoutMs: 900000 } });
 assert.equal(receipt.runtime.deadlineMs, 1200000);
});

test('compact receipt echoes the check timeout from runtime settings', () => {
 const receipt = compactHandoff({ runtime: { deadlineMs: 1200000, checkTimeoutMs: 900000 } });
 assert.equal(receipt.runtime.checkTimeoutMs, 900000);
});

test('compact receipt falls back to resolved settings for the deadline', () => {
 const receipt = compactHandoff({ settings: { deadlineMs: 1500000 } });
 assert.equal(receipt.runtime.deadlineMs, 1500000);
});

test('compact receipt falls back to the execution block for the check timeout', () => {
 const receipt = compactHandoff({ execution: { checkTimeoutMs: 600000 } });
 assert.equal(receipt.runtime.checkTimeoutMs, 600000);
});

test('runtime settings win over settings and execution when both are present', () => {
 const receipt = compactHandoff({
  runtime: { deadlineMs: 1200000 },
  settings: { deadlineMs: 1500000 },
  execution: { deadlineMs: 1800000 },
 });
 assert.equal(receipt.runtime.deadlineMs, 1200000);
});

test('compact receipt reports null runtime settings when they are absent', () => {
 const receipt = compactHandoff({});
 assert.equal(receipt.runtime.checkTimeoutMs, null);
});

test('compactHandoff surfaces notes the run recorded in result.unresolved', () => {
  const compact = compactHandoff({ id: 'n', status: 'ready_for_review', unresolved: ['data policy: served providers could not be verified'] });
  assert.ok(compact.unresolved.includes('data policy: served providers could not be verified'));
});
