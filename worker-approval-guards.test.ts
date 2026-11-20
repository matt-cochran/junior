// ---------------------------------------------------------------------------
// Behavioral tests for the budget-raise guard before any worker starts.
// Each scenario asserts exactly one observable outcome through run()/result.json.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, createRunState } from './worker.ts';
import { settleBudgetApproval } from './worker-preflight-phases.ts';
import { recordBudgetApproval, readBudgetApprovals } from './human-approval.ts';
import { createManualClock } from './clock.ts';

const TOKENS_ABOVE_DEFAULT = 17_000_000;

function cwd(): string {
  return mkdtempSync(join(tmpdir(), 'delivery-budget-approval-'));
}

function task(id: string, extra: any = {}) {
  return {
    id,
    deliverable: 'Exercise the budget-raise guard',
    cwd: extra.cwd ?? cwd(),
    acceptance: ['The run is handled'],
    checks: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
    externalContextConsent: true,
    ...extra,
  };
}

test('a contract budget above the workflow default stops with needs_budget_approval', async () => {
  const result = await run(task('budget-hold', { budget: { maxTotalTokens: TOKENS_ABOVE_DEFAULT } }), true);
  assert.equal(result.status, 'needs_budget_approval');
});

test('an unapproved budget raise records a refused budget_raise_unapproved policy event', async () => {
  const result = await run(task('budget-event', { budget: { maxTotalTokens: TOKENS_ABOVE_DEFAULT } }), true);
  assert.equal(result.policyEvents[0].kind, 'budget_raise_unapproved');
});

test('an unapproved budget raise writes the requested amount to budget-approval.json', async () => {
  const result = await run(task('budget-request', { budget: { maxTotalTokens: TOKENS_ABOVE_DEFAULT } }), true);
  assert.equal(JSON.parse(readFileSync(join(result.artifactDir, 'budget-approval.json'), 'utf8')).requested, TOKENS_ABOVE_DEFAULT);
});

test('an approval token covering the requested budget lets the run continue', async () => {
  const project = cwd();
  recordBudgetApproval(project, {
    id: 'budget-approved',
    maxTotalTokens: TOKENS_ABOVE_DEFAULT,
    token: 'ABC123',
  }, createManualClock('2026-01-01T00:00:00.000Z'));
  const result = await run(task('budget-approved', { cwd: project, budget: { maxTotalTokens: TOKENS_ABOVE_DEFAULT } }), true);
  assert.notEqual(result.status, 'needs_budget_approval');
});

test('an approval token below the requested budget does not cover the raise', async () => {
  const project = cwd();
  recordBudgetApproval(project, {
    id: 'budget-too-small',
    maxTotalTokens: TOKENS_ABOVE_DEFAULT - 1,
    token: 'ABC123',
  }, createManualClock('2026-01-01T00:00:00.000Z'));
  const result = await run(task('budget-too-small', { cwd: project, budget: { maxTotalTokens: TOKENS_ABOVE_DEFAULT } }), true);
  assert.equal(result.status, 'needs_budget_approval');
});

test('an approval token for another contract id does not cover the raise', async () => {
  const project = cwd();
  recordBudgetApproval(project, {
    id: 'different-contract',
    maxTotalTokens: TOKENS_ABOVE_DEFAULT,
    token: 'ABC123',
  }, createManualClock('2026-01-01T00:00:00.000Z'));
  const result = await run(task('budget-wrong-id', { cwd: project, budget: { maxTotalTokens: TOKENS_ABOVE_DEFAULT } }), true);
  assert.equal(result.status, 'needs_budget_approval');
});

test('a resume budget above the parent run stops with needs_budget_approval', () => {
  const project = cwd();
  const t = task('budget-parent', { cwd: project, budget: { maxTotalTokens: 6_000_000 }, workflow: 'test_first' });
  const state = createRunState(t, true, {});
  const result = settleBudgetApproval(state, {
    t,
    requested: state.requested,
    requestedSource: state.requestedSource,
    deadlineAt: state.deadlineAt,
    lineage: { rootId: 'parent', repairs: 1, maxRepairs: 1, deadlineAt: null },
    jev: state.jev,
    explicitWorkflow: 'test_first',
    prior: { budget: { requested: { maxTotalTokens: 5_000_000 } } },
  } as any);
  assert.equal(result.status, 'needs_budget_approval');
});

test('a contract budget at the workflow default needs no human approval', async () => {
  const result = await run(task('budget-default', { budget: { maxTotalTokens: 16_000_000 } }), true);
  assert.notEqual(result.status, 'needs_budget_approval');
});

test('recordBudgetApproval keeps the recorded approval in the project file', () => {
  const project = cwd();
  recordBudgetApproval(project, {
    id: 'G2',
    maxTotalTokens: TOKENS_ABOVE_DEFAULT,
    token: 'ABC123',
  }, createManualClock('2026-01-01T00:00:00.000Z'));
  assert.equal(readBudgetApprovals(project)[0].id, 'G2');
});

test('recordBudgetApproval writes the injected clock time as approvedAt', () => {
  const project = cwd();
  recordBudgetApproval(project, {
    id: 'G2-clock',
    maxTotalTokens: TOKENS_ABOVE_DEFAULT,
    token: 'ABC123',
  }, createManualClock('2026-02-03T04:05:06.000Z'));
  assert.equal(readBudgetApprovals(project)[0].approvedAt, '2026-02-03T04:05:06.000Z');
});

test('an unapproved budget raise creates no budget approval file', async () => {
  const result = await run(task('budget-no-approval-file', { budget: { maxTotalTokens: TOKENS_ABOVE_DEFAULT } }), true);
  assert.equal(existsSync(join(result.sourceCwd, '.junior', 'budget-approvals.json')), false);
});
