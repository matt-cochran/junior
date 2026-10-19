// Behavioral tests for the cpm plan lease around a handoff run.
//
// Every scenario is offline and drives the public `withPlanLease` surface with
// an injected fake `callHop`. Each test asserts exactly one observable outcome:
// a recorded request argument, the returned plan envelope or the run result.
// No private helpers are inspected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPlanLease } from './plan-handoff.ts';

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
