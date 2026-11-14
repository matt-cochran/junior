// ---------------------------------------------------------------------------
// Behavioral tests for resolving execution settings from a task contract.
//
// A contract may carry settings at the top level, inside `execution`, or both.
// Each scenario asserts one observable resolved value from the public API.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { resolveExecutionSettings, shadowedExecutionFields } from './runtime-settings.ts';

test('top-level deadline is honoured when the contract also has an execution object', () => {
 const settings = resolveExecutionSettings({ deadlineMs: 3600000, execution: { checkTimeoutMs: 900000 } });
 assert.equal(settings.deadlineMs, 3600000);
});

test('nested execution check timeout is honoured alongside a top-level deadline', () => {
 const settings = resolveExecutionSettings({ deadlineMs: 3600000, execution: { checkTimeoutMs: 900000 } });
 assert.equal(settings.checkTimeoutMs, 900000);
});

test('nested execution value wins per key over the top-level value', () => {
 const settings = resolveExecutionSettings({ deadlineMs: 3600000, execution: { deadlineMs: 1200000 } });
 assert.equal(settings.deadlineMs, 1200000);
});

test('top-level quiet time is honoured when the contract also has an execution object', () => {
 const settings = resolveExecutionSettings({ quietMs: 45000, execution: { deadlineMs: 1200000 } });
 assert.equal(settings.quietMs, 45000);
});

test('shadowed execution fields name both places with different values', () => {
 const fields = shadowedExecutionFields({ deadlineMs: 3600000, execution: { deadlineMs: 1200000 } });
 assert.deepEqual(fields, ['deadlineMs']);
});

test('shadowed execution fields are empty when there is no execution object', () => {
 const fields = shadowedExecutionFields({ deadlineMs: 3600000 });
 assert.deepEqual(fields, []);
});

test('shadowed execution fields are empty when both places agree', () => {
 const fields = shadowedExecutionFields({ deadlineMs: 1200000, execution: { deadlineMs: 1200000 } });
 assert.deepEqual(fields, []);
});

test('shadowed execution fields are reported in sorted order', () => {
 const fields = shadowedExecutionFields({
  quietMs: 45000,
  deadlineMs: 3600000,
  execution: { deadlineMs: 1200000, quietMs: 60000 },
 });
 assert.deepEqual(fields, ['deadlineMs', 'quietMs']);
});

test('an invalid top-level value is reported as execution field', () => {
 assert.throws(
  () => resolveExecutionSettings({ deadlineMs: -1 }),
  /Invalid execution\.deadlineMs/,
 );
});

test('an invalid nested value is reported as execution field', () => {
 assert.throws(
  () => resolveExecutionSettings({ execution: { checkTimeoutMs: 0 } }),
  /Invalid execution\.checkTimeoutMs/,
 );
});
