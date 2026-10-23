// Behavioral tests for the session-start compact context block.
//
// Each scenario builds a temporary local store and injects `callHop`, so the
// block is exercised through its public API without a model or network call.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHop, loadHop, saveHop } from './tools/tools.ts';
import { buildCompactBlock, type CompactDeps } from './compact.ts';

type Outcome = Awaited<ReturnType<NonNullable<CompactDeps['callHop']>>>;

function workspace(t: any): string {
  const dir = mkdtempSync(join(tmpdir(), 'junior-compact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function hopAt(dir: string): string {
  const path = join(dir, 'hop.json');
  initHop(path, {
    projectId: 'compact-test',
    probeVersion: () => 'test',
    tools: {
      cpm: { command: 'cpm-planner', sourceVersion: 'test' },
      fmeca: { command: 'fmeca-mcp', sourceVersion: 'test' },
      'scientific-process': { command: 'scientific-process', sourceVersion: 'test' },
    },
  });
  const manifest = loadHop(path);
  manifest.revision = 7;
  saveHop(path, manifest);
  return path;
}

function outcome(tool: string, result: unknown): Outcome {
  return {
    ok: true,
    tool: 'cpm',
    toolName: tool,
    revision: 1,
    kind: 'read',
    isError: false,
    unsupported: false,
    note: null,
    result,
  } as Outcome;
}

function failing(tool: string, message: string): Outcome {
  return {
    ok: false,
    tool: 'cpm',
    toolName: tool,
    revision: 1,
    kind: 'read',
    isError: true,
    unsupported: false,
    note: null,
    error: { code: 'RPC_ERROR', message },
  } as Outcome;
}

const PLAN = {
  plan_id: 'plan_X',
  name: 'Release train',
  variant: 'main',
  baseline: { baseline_number: 3 },
  deliverables: [
    ['a', { status: 'complete' }],
    ['b', { status: 'ready' }],
    ['c', { status: 'pending' }],
  ],
  critical_ids: ['b', 'c'],
  ready: ['b'],
};

test('the header is stamped with the hop revision', async (t) => {
  const dir = workspace(t);
  const block = await buildCompactBlock({ cwd: dir, hopPath: hopAt(dir), now: () => new Date('2026-01-02T03:04:05Z') });
  assert.match(block.markdown, /hop revision: 7/);
});

test('the header is stamped with the generation time', async (t) => {
  const dir = workspace(t);
  const block = await buildCompactBlock({ cwd: dir, hopPath: hopAt(dir), now: () => new Date('2026-01-02T03:04:05Z') });
  assert.match(block.markdown, /2026-01-02T03:04:05/);
});

test('a NO_ACTIVE_PLAN response reports the plan section as none', async (t) => {
  const dir = workspace(t);
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: hopAt(dir),
    callHop: async (_path, _tool, request) =>
      request.tool === 'plan.status'
        ? failing('plan.status', 'NO_ACTIVE_PLAN: no active plan')
        : outcome(request.tool, {}),
  });
  assert.equal(block.sections.plan, 'none');
});

test('an active plan keeps its plan id in the block', async (t) => {
  const dir = workspace(t);
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: hopAt(dir),
    callHop: async () => outcome('plan.status', PLAN),
  });
  assert.match(block.markdown, /plan_X/);
});

test('an active plan keeps its baseline number in the block', async (t) => {
  const dir = workspace(t);
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: hopAt(dir),
    callHop: async () => outcome('plan.status', PLAN),
  });
  assert.match(block.markdown, /baseline: 3/);
});

test('an active plan keeps its completion progress in the block', async (t) => {
  const dir = workspace(t);
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: hopAt(dir),
    callHop: async () => outcome('plan.status', PLAN),
  });
  assert.match(block.markdown, /complete: 1\/3/);
});

test('the plan section lists ready deliverable ids', async (t) => {
  const dir = workspace(t);
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: hopAt(dir),
    callHop: async () => outcome('plan.status', PLAN),
  });
  assert.match(block.markdown, /ready: b/);
});

test('the block lists fmeca sessions with their blocker count', async (t) => {
  const dir = workspace(t);
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: hopAt(dir),
    callHop: async (_path, tool, request) => {
      if (tool === 'fmeca') {
        return outcome(request.tool, {
          sessions: [{ id: 'risk-1', ready: true, blockers: ['blocked-mode'] }],
        });
      }
      return failing(request.tool, 'NO_ACTIVE_PLAN');
    },
  });
  assert.match(block.markdown, /risk-1: ready=yes blockers=1/);
});

test('the block lists accepted risk detail when fmeca reports it', async (t) => {
  const dir = workspace(t);
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: hopAt(dir),
    callHop: async (_path, tool, request) => {
      if (tool === 'fmeca') {
        return outcome(request.tool, {
          sessions: [{ id: 'risk-1', ready: false, blockers: [], accepted_risks: ['fm1'] }],
        });
      }
      return failing(request.tool, 'NO_ACTIVE_PLAN');
    },
  });
  assert.match(block.markdown, /accepted risks: 1/);
});

test('open scientific-process hypotheses appear in the block', async (t) => {
  const dir = workspace(t);
  const hopPath = hopAt(dir);
  const stateDir = join(dir, 'scientific-process-state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'sp-1.jsonl'), '');
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath,
    callHop: async (_path, tool, request) => {
      if (tool === 'scientific-process') {
        return outcome(request.tool, {
          hypotheses: [
            { id: 'H-open', statement: 'The cache explains the latency', status: 'Open' },
            { id: 'H-done', statement: 'Rejected theory', status: 'Concluded' },
          ],
        });
      }
      return failing(request.tool, 'NO_ACTIVE_PLAN');
    },
  });
  assert.match(block.markdown, /H-open/);
});

test('concluded scientific-process hypotheses stay out of the block', async (t) => {
  const dir = workspace(t);
  const hopPath = hopAt(dir);
  const stateDir = join(dir, 'scientific-process-state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'sp-1.jsonl'), '');
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath,
    callHop: async (_path, tool, request) => {
      if (tool === 'scientific-process') {
        return outcome(request.tool, {
          hypotheses: [{ id: 'H-done', statement: 'Rejected theory', status: 'Concluded' }],
        });
      }
      return failing(request.tool, 'NO_ACTIVE_PLAN');
    },
  });
  assert.doesNotMatch(block.markdown, /H-done/);
});

function runAt(cwd: string, id: string, stamp: string, status?: string): void {
  const dir = join(cwd, '.delivery', id, stamp);
  mkdirSync(dir, { recursive: true });
  if (status !== undefined) writeFileSync(join(dir, 'result.json'), JSON.stringify({ status }));
}

test('the latest non-terminal run is reported as in flight', async (t) => {
  const dir = workspace(t);
  runAt(dir, 'task-a', '20260101T000000', 'failed');
  const block = await buildCompactBlock({ cwd: dir, hopPath: join(dir, 'missing-hop.json') });
  assert.match(block.markdown, /task-a/);
});

test('the latest terminal run is not reported as in flight', async (t) => {
  const dir = workspace(t);
  runAt(dir, 'task-a', '20260101T000000', 'ready_for_review');
  const block = await buildCompactBlock({ cwd: dir, hopPath: join(dir, 'missing-hop.json') });
  assert.equal(block.sections.runs, 'none');
});

test('an older non-terminal run is ignored when the latest run is terminal', async (t) => {
  const dir = workspace(t);
  runAt(dir, 'task-a', '20260101T000000', 'failed');
  runAt(dir, 'task-a', '20260102T000000', 'ready_for_review');
  const block = await buildCompactBlock({ cwd: dir, hopPath: join(dir, 'missing-hop.json') });
  assert.equal(block.sections.runs, 'none');
});

test('a latest run without result.json is reported as running', async (t) => {
  const dir = workspace(t);
  runAt(dir, 'task-a', '20260101T000000');
  const block = await buildCompactBlock({ cwd: dir, hopPath: join(dir, 'missing-hop.json') });
  assert.match(block.markdown, /status: running/);
});

test('a failing companion turns its section unavailable instead of throwing', async (t) => {
  const dir = workspace(t);
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: hopAt(dir),
    callHop: async () => {
      throw new Error('companion exploded');
    },
  });
  assert.equal(block.sections.plan, 'unavailable');
});

test('an unavailable section renders its error message', async (t) => {
  const dir = workspace(t);
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: hopAt(dir),
    callHop: async () => {
      throw new Error('companion exploded');
    },
  });
  assert.match(block.markdown, /unavailable: companion exploded/);
});

test('a missing hop leaves the plan section as none', async (t) => {
  const dir = workspace(t);
  const block = await buildCompactBlock({ cwd: dir, hopPath: join(dir, 'missing-hop.json') });
  assert.equal(block.sections.plan, 'none');
});

test('a missing hop makes no companion call', async (t) => {
  const dir = workspace(t);
  let calls = 0;
  await buildCompactBlock({
    cwd: dir,
    hopPath: join(dir, 'missing-hop.json'),
    callHop: async () => {
      calls += 1;
      return outcome('plan.status', PLAN);
    },
  });
  assert.equal(calls, 0);
});

test('the block stays within maxChars when removable detail overflows', async (t) => {
  const dir = workspace(t);
  for (const id of ['run-old', 'run-mid', 'run-new']) runAt(dir, id, '20260101T000000', 'failed');
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: join(dir, 'missing-hop.json'),
    maxChars: 220,
  });
  assert.ok(block.markdown.length <= 220);
});

test('truncation drops the oldest in-flight run before newer ones', async (t) => {
  const dir = workspace(t);
  runAt(dir, 'run-old', '20260101T000000', 'failed');
  runAt(dir, 'run-new', '20260102T000000', 'failed');
  let block = await buildCompactBlock({
    cwd: dir,
    hopPath: join(dir, 'missing-hop.json'),
    callHop: async () => failing('plan.status', 'NO_ACTIVE_PLAN'),
    maxChars: 100_000,
  });
  const baseline = block.markdown.length;
  block = await buildCompactBlock({
    cwd: dir,
    hopPath: join(dir, 'missing-hop.json'),
    callHop: async () => failing('plan.status', 'NO_ACTIVE_PLAN'),
    maxChars: baseline - 1,
  });
  assert.doesNotMatch(block.markdown, /run-old/);
});

test('a truncated block appends a more marker', async (t) => {
  const dir = workspace(t);
  runAt(dir, 'run-old', '20260101T000000', 'failed');
  runAt(dir, 'run-new', '20260102T000000', 'failed');
  const full = await buildCompactBlock({
    cwd: dir,
    hopPath: join(dir, 'missing-hop.json'),
    maxChars: 100_000,
  });
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: join(dir, 'missing-hop.json'),
    maxChars: full.markdown.length - 1,
  });
  assert.match(block.markdown, /\(\+\d+ more\)/);
});

test('truncation never removes the active plan section', async (t) => {
  const dir = workspace(t);
  for (const id of ['run-old', 'run-new']) runAt(dir, id, '20260101T000000', 'failed');
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: hopAt(dir),
    callHop: async (_path, tool, request) =>
      request.tool === 'plan.status' ? outcome('plan.status', PLAN) : failing(request.tool, 'none'),
    maxChars: 200,
  });
  assert.match(block.markdown, /plan_X/);
});

test('the truncation flag reflects whether content was dropped', async (t) => {
  const dir = workspace(t);
  runAt(dir, 'run-old', '20260101T000000', 'failed');
  runAt(dir, 'run-new', '20260102T000000', 'failed');
  const full = await buildCompactBlock({
    cwd: dir,
    hopPath: join(dir, 'missing-hop.json'),
    maxChars: 100_000,
  });
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: join(dir, 'missing-hop.json'),
    maxChars: full.markdown.length - 1,
  });
  assert.equal(block.truncated, true);
});

test('a non-positive maxChars is rejected at the boundary', async (t) => {
  const dir = workspace(t);
  await assert.rejects(
    buildCompactBlock({ cwd: dir, hopPath: join(dir, 'missing-hop.json'), maxChars: 0 }),
    /maxChars/,
  );
});

const NOW = new Date('2026-10-23T12:00:00Z');
const HOURS_AGO = (h: number) => String(NOW.getTime() - h * 3_600_000);

test('a failed run older than the in-flight window is left out', async (t) => {
  const dir = workspace(t);
  runAt(dir, 'task-old', HOURS_AGO(72), 'checks_failed');
  const block = await buildCompactBlock({ cwd: dir, hopPath: join(dir, 'missing-hop.json'), now: () => NOW });
  assert.equal(block.sections.runs, 'none');
});

test('a failed run inside the in-flight window is reported', async (t) => {
  const dir = workspace(t);
  runAt(dir, 'task-new', HOURS_AGO(2), 'checks_failed');
  const block = await buildCompactBlock({ cwd: dir, hopPath: join(dir, 'missing-hop.json'), now: () => NOW });
  assert.match(block.markdown, /task-new: status: checks_failed/);
});

test('a failed run resolved by a successful repair run is left out', async (t) => {
  const dir = workspace(t);
  runAt(dir, 'task-a', HOURS_AGO(3), 'needs_review');
  runAt(dir, 'task-a-repair', HOURS_AGO(1), 'ready_for_review');
  const block = await buildCompactBlock({ cwd: dir, hopPath: join(dir, 'missing-hop.json'), now: () => NOW });
  assert.equal(block.sections.runs, 'none');
});

test('a non-positive in-flight window is rejected at the boundary', async (t) => {
  const dir = workspace(t);
  await assert.rejects(buildCompactBlock({ cwd: dir, inFlightMaxAgeHours: 0 }), /inFlightMaxAgeHours must be a positive number/);
});

test('a completed deliverable is not reported as in flight', async (t) => {
  const dir = workspace(t);
  runAt(dir, 'CLI10', HOURS_AGO(2), 'checks_failed');
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: join(dir, 'missing-hop.json'),
    now: () => NOW,
    completedDeliverables: async () => new Set(['CLI10']),
  });
  assert.doesNotMatch(block.markdown, /CLI10/);
});

test('an incomplete deliverable remains in flight', async (t) => {
  const dir = workspace(t);
  runAt(dir, 'CLI10', HOURS_AGO(2), 'checks_failed');
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: join(dir, 'missing-hop.json'),
    now: () => NOW,
    completedDeliverables: async () => new Set(),
  });
  assert.match(block.markdown, /- CLI10: status: checks_failed/);
});

test('a live-check run is never reported as in flight', async (t) => {
  const dir = workspace(t);
  runAt(dir, 'live-check-vague', HOURS_AGO(2), 'needs_review');
  const block = await buildCompactBlock({ cwd: dir, hopPath: join(dir, 'missing-hop.json'), now: () => NOW });
  assert.doesNotMatch(block.markdown, /live-check-vague/);
});

test('a failing completed-deliverable lookup leaves the run in flight', async (t) => {
  const dir = workspace(t);
  runAt(dir, 'CLI10', HOURS_AGO(2), 'checks_failed');
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: join(dir, 'missing-hop.json'),
    now: () => NOW,
    completedDeliverables: async () => {
      throw new Error('lookup failed');
    },
  });
  assert.match(block.markdown, /- CLI10: status: checks_failed/);
});

test('the default lookup includes completed deliverables from archived plan lines', async (t) => {
  const dir = workspace(t);
  runAt(dir, 'CLI10', HOURS_AGO(2), 'checks_failed');
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: hopAt(dir),
    now: () => NOW,
    callHop: async (_path, tool, request) => {
      if (request.tool === 'plan.list') {
        return outcome('plan.list', [{ variants: [{ plan_id: 'plan_archived', archived: true, plan_complete: false }] }]);
      }
      if (request.tool === 'plan.status') {
        if ((request.arguments as any)?.plan_id === 'plan_archived') {
          return outcome('plan.status', { deliverables: [['CLI10', { status: 'complete' }]] });
        }
        return failing('plan.status', 'NO_ACTIVE_PLAN');
      }
      return failing(request.tool, 'none');
    },
  });
  assert.doesNotMatch(block.markdown, /CLI10/);
});

test('the default lookup includes completed deliverables from complete plan lines', async (t) => {
  const dir = workspace(t);
  runAt(dir, 'CLI10', HOURS_AGO(2), 'checks_failed');
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: hopAt(dir),
    now: () => NOW,
    callHop: async (_path, tool, request) => {
      if (request.tool === 'plan.list') {
        return outcome('plan.list', [{ variants: [{ plan_id: 'plan_done', archived: false, plan_complete: true }] }]);
      }
      if (request.tool === 'plan.status') {
        if ((request.arguments as any)?.plan_id === 'plan_done') {
          return outcome('plan.status', { deliverables: [['CLI10', { status: 'complete' }]] });
        }
        return failing('plan.status', 'NO_ACTIVE_PLAN');
      }
      return failing(request.tool, 'none');
    },
  });
  assert.doesNotMatch(block.markdown, /CLI10/);
});

test('a failing plan.status lookup in the default path leaves the run in flight', async (t) => {
  const dir = workspace(t);
  runAt(dir, 'CLI10', HOURS_AGO(2), 'checks_failed');
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: hopAt(dir),
    now: () => NOW,
    callHop: async (_path, _tool, request) => {
      if (request.tool === 'plan.list') {
        return outcome('plan.list', [{ variants: [{ plan_id: 'plan_broken' }] }]);
      }
      return failing(request.tool, 'NO_ACTIVE_PLAN');
    },
  });
  assert.match(block.markdown, /- CLI10: status: checks_failed/);
});
