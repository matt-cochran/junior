// Behavioral tests for the cpm plan lease around a handoff run.
//
// Every scenario is offline and drives the public `withPlanLease` surface with
// an injected fake `callHop`. Each test asserts exactly one observable outcome:
// a recorded request argument, the returned plan envelope or the run result.
// No private helpers are inspected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isHoldOutcome, runNeverStarted, withPlanLease } from './plan-handoff.ts';

const fixturesRoot = join(import.meta.dirname, 'tools', 'test-fixtures', 'companions');
function cpmFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesRoot, 'cpm@0.4.0', `${name}.json`), 'utf8'));
}

const DELIVERABLE = 'P1b-plan-lease';
const PLAN = { id: 'plan_1', deliverable: DELIVERABLE };
const TASK = { id: 'task-1', plan: PLAN };

type RecordedCall = { tool: string; request: { tool: string; arguments: Record<string, any> } };

function harness(handlers: Record<string, (request: any) => any> = {}) {
  const calls: RecordedCall[] = [];
  const callHop = async (tool: string, request: any) => {
    calls.push({ tool, request });
    const handler = handlers[request.tool];
    if (handler) return handler(request);
    if (request.tool === 'plan.acquire_cohort') return { ok: true, result: { deliverables: [DELIVERABLE] } };
    return { ok: true, result: {} };
  };
  return { calls, callHop };
}

function deps(callHop: any, overrides: any = {}) {
  return {
    callHop,
    deadlineMs: 120_000,
    summarize: () => ({ success: true }),
    ...overrides,
  };
}

function markCall(calls: RecordedCall[]) {
  return calls.find((call) => call.request.tool === 'plan.mark_status');
}

// --- recorded cpm fixtures --------------------------------------------------

test('withPlanLease leases the deliverable from the cpm acquire_cohort fixture', async () => {
  const { callHop } = harness({ 'plan.acquire_cohort': () => ({ ok: true, result: cpmFixture('plan.acquire_cohort') }) });
  const out = await withPlanLease(
    { id: 'task-1', plan: { id: 'plan_FIXTURE', deliverable: 'd-api' } },
    async () => 'ok',
    deps(callHop),
  );
  assert.equal(out.plan.leased, true);
});

test('withPlanLease re-enters the lease shown by the cpm plan.status.leased fixture', async () => {
  const { callHop } = harness({
    'plan.acquire_cohort': () => ({ ok: true, result: { deliverables: ['other'] } }),
    'plan.status': () => ({ ok: true, result: cpmFixture('plan.status.leased') }),
  });
  const out = await withPlanLease(
    { id: 'task-1', plan: { id: 'plan_FIXTURE', deliverable: 'd-api', callerId: 'fixture-worker' } },
    async () => 'ok',
    deps(callHop),
  );
  assert.equal(out.plan.reentered, true);
});

test('withPlanLease refuses an unrecognized acquire_cohort response with the ShapeError reason', async () => {
  const { callHop } = harness({ 'plan.acquire_cohort': () => ({ ok: true, result: { unexpected: [] } }) });
  const out = await withPlanLease(TASK, async () => 'ok', deps(callHop));
  assert.match(out.plan.error ?? '', /Unrecognized cpm\.plan\.acquire_cohort response; top-level keys: unexpected/);
});

test('withPlanLease refuses an unrecognized plan.status response with the ShapeError reason', async () => {
  const { callHop } = harness({
    'plan.acquire_cohort': () => ({ ok: true, result: { deliverables: ['other'] } }),
    'plan.status': () => ({ ok: true, result: { unexpected: [] } }),
  });
  const out = await withPlanLease(TASK, async () => 'ok', deps(callHop));
  assert.match(out.plan.error ?? '', /Unrecognized cpm\.plan\.status response; top-level keys: unexpected/);
});

// --- acquire ----------------------------------------------------------------

test('withPlanLease acquires one cohort slot for the deliverable', async () => {
  const { calls, callHop } = harness();
  await withPlanLease(TASK, async () => 'ok', deps(callHop));
  const acquire = calls.find((call) => call.request.tool === 'plan.acquire_cohort');
  assert.deepEqual(acquire?.request.arguments, {
    plan_id: 'plan_1',
    caller_id: 'junior-worker',
    ids: [DELIVERABLE],
    max_count: 1,
    ttl_seconds: 3720,
  });
});

test('withPlanLease sends the acquire through the cpm tool', async () => {
  const { calls, callHop } = harness();
  await withPlanLease(TASK, async () => 'ok', deps(callHop));
  assert.equal(calls[0].tool, 'cpm');
});

test('withPlanLease uses the task caller id when provided', async () => {
  const { calls, callHop } = harness();
  await withPlanLease({ ...TASK, plan: { ...PLAN, callerId: 'agent-7' } }, async () => 'ok', deps(callHop));
  const acquire = calls.find((call) => call.request.tool === 'plan.acquire_cohort');
  assert.equal(acquire?.request.arguments.caller_id, 'agent-7');
});

// --- not leased -------------------------------------------------------------

test('withPlanLease skips the run when the lease fails', async () => {
  const { callHop } = harness({ 'plan.acquire_cohort': () => ({ ok: false, error: { message: 'no capacity' } }) });
  let ran = false;
  await withPlanLease(TASK, async () => { ran = true; return 'ok'; }, deps(callHop));
  assert.equal(ran, false);
});

test('withPlanLease reports the acquire failure when the lease is denied', async () => {
  const { callHop } = harness({ 'plan.acquire_cohort': () => ({ ok: false, error: { message: 'no capacity' } }) });
  const out = await withPlanLease(TASK, async () => 'ok', deps(callHop));
  assert.equal(out.plan.error, 'plan.acquire_cohort failed: no capacity');
});

test('withPlanLease treats a cohort without the deliverable as unleased', async () => {
  const { callHop } = harness({ 'plan.acquire_cohort': () => ({ ok: true, result: { deliverables: ['other'] } }) });
  const out = await withPlanLease(TASK, async () => 'ok', deps(callHop));
  assert.equal(out.plan.leased, false);
});

// --- re-entry ---------------------------------------------------------------

test('withPlanLease runs when the same caller already holds the lease', async () => {
  const { callHop } = harness({
    'plan.acquire_cohort': () => ({ ok: true, result: { deliverables: ['other'] } }),
    'plan.status': () => ({ ok: true, result: { locks_held: [{ deliverable_id: DELIVERABLE, caller_id: 'junior-worker' }] } }),
  });
  const out = await withPlanLease(TASK, async () => 'ok', deps(callHop));
  assert.equal(out.result, 'ok');
});

test('withPlanLease marks a re-entered lease as reentered', async () => {
  const { callHop } = harness({
    'plan.acquire_cohort': () => ({ ok: true, result: { deliverables: ['other'] } }),
    'plan.status': () => ({ ok: true, result: { locks_held: [{ deliverable_id: DELIVERABLE, caller_id: 'junior-worker' }] } }),
  });
  const out = await withPlanLease(TASK, async () => 'ok', deps(callHop));
  assert.equal(out.plan.reentered, true);
});

test('withPlanLease asks plan.status when the cohort omits the deliverable', async () => {
  const { calls, callHop } = harness({
    'plan.acquire_cohort': () => ({ ok: true, result: { deliverables: ['other'] } }),
    'plan.status': () => ({ ok: true, result: { locks_held: [] } }),
  });
  await withPlanLease(TASK, async () => 'ok', deps(callHop));
  const status = calls.find((call) => call.request.tool === 'plan.status');
  assert.deepEqual(status?.request.arguments, { plan_id: 'plan_1' });
});

test('withPlanLease refuses a lease held by another caller', async () => {
  const { callHop } = harness({
    'plan.acquire_cohort': () => ({ ok: true, result: { deliverables: ['other'] } }),
    'plan.status': () => ({ ok: true, result: { locks_held: [{ deliverable_id: DELIVERABLE, caller_id: 'agent-9' }] } }),
  });
  const out = await withPlanLease(TASK, async () => 'ok', deps(callHop));
  assert.equal(out.plan.leased, false);
});

test('withPlanLease names the other caller when the lease is held elsewhere', async () => {
  const { callHop } = harness({
    'plan.acquire_cohort': () => ({ ok: true, result: { deliverables: ['other'] } }),
    'plan.status': () => ({ ok: true, result: { locks_held: [{ deliverable_id: DELIVERABLE, caller_id: 'agent-9' }] } }),
  });
  const out = await withPlanLease(TASK, async () => 'ok', deps(callHop));
  assert.match(out.plan.error ?? '', /agent-9/);
});

// --- hold summary -----------------------------------------------------------

test('withPlanLease marks nothing when the summary reports a hold', async () => {
  const { callHop } = harness();
  const out = await withPlanLease(TASK, async () => 'ok', deps(callHop, { summarize: () => ({ success: false, hold: true }) }));
  assert.equal(out.plan.marked, null);
});

test('withPlanLease keeps the lease when the summary reports a hold', async () => {
  const { callHop } = harness();
  const out = await withPlanLease(TASK, async () => 'ok', deps(callHop, { summarize: () => ({ success: false, hold: true }) }));
  assert.equal(out.plan.leased, true);
});

test('withPlanLease sends no mark when the summary reports a hold', async () => {
  const { calls, callHop } = harness();
  await withPlanLease(TASK, async () => 'ok', deps(callHop, { summarize: () => ({ success: false, hold: true }) }));
  assert.equal(markCall(calls), undefined);
});

// --- successful run ---------------------------------------------------------

test('withPlanLease reports the plan leased after a successful acquire', async () => {
  const { callHop } = harness();
  const out = await withPlanLease(TASK, async () => 'ok', deps(callHop));
  assert.equal(out.plan.leased, true);
});

test('withPlanLease marks a successful run in progress', async () => {
  const { callHop } = harness();
  const out = await withPlanLease(TASK, async () => 'ok', deps(callHop));
  assert.equal(out.plan.marked, 'in_progress');
});

test('withPlanLease sends an in_progress status for a successful run', async () => {
  const { calls, callHop } = harness();
  await withPlanLease(TASK, async () => 'ok', deps(callHop));
  assert.deepEqual(markCall(calls)?.request.arguments.status, { status: 'in_progress' });
});

// --- unsuccessful run -------------------------------------------------------

test('withPlanLease marks an unsuccessful run failed', async () => {
  const { callHop } = harness();
  const out = await withPlanLease(TASK, async () => 'ok', deps(callHop, { summarize: () => ({ success: false, reason: 'checks failed' }) }));
  assert.equal(out.plan.marked, 'failed');
});

test('withPlanLease records the failure reason in the failed status', async () => {
  const { calls, callHop } = harness();
  await withPlanLease(TASK, async () => 'ok', deps(callHop, { summarize: () => ({ success: false, reason: 'checks failed' }) }));
  assert.deepEqual(markCall(calls)?.request.arguments.status, { status: 'failed', reason: 'checks failed' });
});

// --- thrown run -------------------------------------------------------------

test('withPlanLease rethrows the run error', async () => {
  const { callHop } = harness();
  await assert.rejects(() => withPlanLease(TASK, async () => { throw new Error('boom'); }, deps(callHop)), /boom/);
});

test('withPlanLease marks a thrown run failed with the error message', async () => {
  const { calls, callHop } = harness();
  try {
    await withPlanLease(TASK, async () => { throw new Error('boom'); }, deps(callHop));
  } catch {
    // expected: the run error is rethrown
  }
  assert.deepEqual(markCall(calls)?.request.arguments.status, { status: 'failed', reason: 'boom' });
});

// --- progress record --------------------------------------------------------

test('withPlanLease reports elapsed wall hours rounded to two decimals', async () => {
  const { calls, callHop } = harness();
  const ticks = [0, 3_725_000];
  let i = 0;
  const now = () => ticks[Math.min(i++, ticks.length - 1)];
  await withPlanLease(TASK, async () => 'ok', deps(callHop, { now }));
  assert.equal(markCall(calls)?.request.arguments.actual_effort_hours, 1.03);
});

test('withPlanLease never records less than a hundredth of an hour', async () => {
  const { calls, callHop } = harness();
  const ticks = [0, 1000];
  let i = 0;
  const now = () => ticks[Math.min(i++, ticks.length - 1)];
  await withPlanLease(TASK, async () => 'ok', deps(callHop, { now }));
  assert.equal(markCall(calls)?.request.arguments.actual_effort_hours, 0.01);
});

test('withPlanLease records artifact, outcome and model in the evidence line', async () => {
  const { calls, callHop } = harness();
  await withPlanLease(TASK, async () => 'ok', deps(callHop, {
    summarize: () => ({ success: true, artifactDir: '/tmp/a', outcome: 'ok', model: 'm1' }),
  }));
  assert.equal(markCall(calls)?.request.arguments.evidence, 'artifactDir=/tmp/a outcome=ok model=m1');
});

// --- failing mark -----------------------------------------------------------

test('withPlanLease returns the run result when marking fails', async () => {
  const { callHop } = harness({ 'plan.mark_status': () => ({ ok: false, error: { message: 'locked' } }) });
  const out = await withPlanLease(TASK, async () => 'artifact', deps(callHop));
  assert.equal(out.result, 'artifact');
});

test('withPlanLease records the mark failure in plan.error', async () => {
  const { callHop } = harness({ 'plan.mark_status': () => ({ ok: false, error: { message: 'locked' } }) });
  const out = await withPlanLease(TASK, async () => 'artifact', deps(callHop));
  assert.equal(out.plan.error, 'plan.mark_status failed: locked');
});

// --- hold outcomes ----------------------------------------------------------

test('a model approval stop is a hold outcome', () => {
  assert.equal(isHoldOutcome('needs_model_approval'), true);
});

test('a failed run is not a hold outcome', () => {
  assert.equal(isHoldOutcome('failed'), false);
});

// --- never-started runs -----------------------------------------------------

test('a blocked run with no segments and no observed model never started', () => {
  const result = { status: 'needs_review', segments: 0, runtime: { stopReason: 'blocked', elapsedMs: 0 }, model: { observed: [] } };
  assert.equal(runNeverStarted(result), true);
});

test('a run with one segment and a checks failure did start', () => {
  const result = { status: 'needs_review', segments: 1, runtime: { stopReason: 'checks_failed' }, model: { observed: [] } };
  assert.equal(runNeverStarted(result), false);
});

test('a blocked run without segment or model fields never started', () => {
  const result = { status: 'needs_review', runtime: { stopReason: 'blocked' } };
  assert.equal(runNeverStarted(result), true);
});

// --- failed retry lifecycle -------------------------------------------------

function failedStatus(reason: string, actual_effort_hours?: number) {
  return () => ({ ok: true, result: { deliverables: [[DELIVERABLE, { status: 'failed', reason, ...(actual_effort_hours === undefined ? {} : { actual_effort_hours }) }]], locks_held: [] } });
}

function acquireAfterFirstLease() {
  let attempts = 0;
  return () => ({ ok: true, result: { deliverables: ++attempts === 1 ? ['other'] : [DELIVERABLE] } });
}

test('withPlanLease returns a failed deliverable to ready then retries it', async () => {
  const { calls, callHop } = harness({
    'plan.acquire_cohort': acquireAfterFirstLease(),
    'plan.status': failedStatus('checks failed'),
  });
  const out = await withPlanLease(TASK, async () => 'ok', deps(callHop));
  assert.equal(out.plan.leased, true);
  assert.equal(out.plan.retried, true);
  assert.deepEqual(calls.find((call) => call.request.tool === 'plan.mark_status')?.request.arguments.status, { status: 'ready' });
});

test('withPlanLease retains the failure reason in retry evidence', async () => {
  const { calls, callHop } = harness({
    'plan.acquire_cohort': acquireAfterFirstLease(),
    'plan.status': failedStatus('earlier checks failed'),
  });
  await withPlanLease(TASK, async () => 'ok', deps(callHop));
  const ready = calls.find((call) => call.request.tool === 'plan.mark_status');
  assert.match(String(ready?.request.arguments.evidence), /earlier checks failed/);
});

test('withPlanLease refuses completed work until CPM reopens it', async () => {
  const { callHop } = harness({
    'plan.acquire_cohort': () => ({ ok: true, result: { deliverables: ['other'] } }),
    'plan.status': () => ({ ok: true, result: { deliverables: [[DELIVERABLE, { status: 'complete' }]], locks_held: [] } }),
  });
  const out = await withPlanLease(TASK, async () => 'ok', deps(callHop));
  assert.match(out.plan.error ?? '', /revised\/reopened/);
});

test('withPlanLease accumulates failed actuals with the new run', async () => {
  const { calls, callHop } = harness({
    'plan.acquire_cohort': acquireAfterFirstLease(),
    'plan.status': failedStatus('checks failed', 2.5),
  });
  const ticks = [0, 3_600_000];
  let index = 0;
  await withPlanLease(TASK, async () => 'ok', deps(callHop, { now: () => ticks[Math.min(index++, ticks.length - 1)] }));
  const marks = calls.filter((call) => call.request.tool === 'plan.mark_status');
  assert.equal(marks.at(-1)?.request.arguments.actual_effort_hours, 3.5);
});

test('withPlanLease uses EV actuals when a reopened correction has them', async () => {
  const { calls, callHop } = harness({
    'plan.ev': () => ({ ok: true, result: { rows: [{ id: DELIVERABLE, ac: 2 }] } }),
  });
  const ticks = [0, 3_600_000];
  let index = 0;
  await withPlanLease(TASK, async () => 'ok', deps(callHop, { now: () => ticks[Math.min(index++, ticks.length - 1)] }));
  assert.equal(markCall(calls)?.request.arguments.actual_effort_hours, 3);
});
