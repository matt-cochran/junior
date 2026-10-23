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
import { buildCompactBlock as buildCompact, type CompactDeps } from './compact.ts';
import type { PrSection } from './compact-prs.ts';
import type { Note } from './notes.ts';

type Outcome = Awaited<ReturnType<NonNullable<CompactDeps['callHop']>>>;

const NO_NOTES = (): { notes: Note[]; proposals: Note[] } => ({ notes: [], proposals: [] });
const NO_PRS = async (): Promise<PrSection> => ({ status: 'none', prs: [], errors: [] });

function buildCompactBlock(deps: CompactDeps) {
  return buildCompact({ listNotes: NO_NOTES, openPrs: NO_PRS, ...deps });
}

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
    maxChars: 300,
  });
  assert.ok(block.markdown.length <= 300);
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


function attemptAt(cwd: string, id: string, stamp: string, status: string, files: string[] = []): string {
  const dir = join(cwd, '.delivery', id, stamp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ status }));
  for (const file of files) writeFileSync(join(dir, file), '');
  return dir;
}

const DECISION_NOW = new Date(1792000000000 + 3_600_000);
const DECISION_HOP = (dir: string) => join(dir, 'missing-hop.json');

function managerNote(id: string, kind: Note['kind'], text: string, createdAt: string): Note {
  return { id, kind, text, source: 'manager', createdAt };
}

function captureNote(id: string, kind: Note['kind'], text: string, captureId: string, createdAt: string): Note {
  return { id, kind, text, source: 'capture', captureId, createdAt };
}

function memoryFixture(t: any): { deps: CompactDeps; dir: string } {
  const dir = workspace(t);
  attemptAt(dir, 'X1', '1792000000000', 'needs_answers', ['clarify.md']);
  const deps: CompactDeps = {
    cwd: dir,
    hopPath: hopAt(dir),
    now: () => DECISION_NOW,
    callHop: async (_path, _tool, request) =>
      request.tool === 'plan.status' ? outcome('plan.status', PLAN) : failing(request.tool, 'none'),
    listNotes: () => ({
      notes: [managerNote('n-1', 'todo', 'Publish crate', '2026-10-14T17:46:40.000Z')],
      proposals: [captureNote('n-2', 'decision', 'Ship 0.11 first', 'c-1', '2026-10-14T17:47:40.000Z')],
    }),
  };
  return { deps, dir };
}

test('a needs_answers run is listed under pending decisions', async (t) => {
  const dir = workspace(t);
  attemptAt(dir, 'X1', '1792000000000', 'needs_answers', ['clarify.md']);
  const block = await buildCompactBlock({ cwd: dir, hopPath: DECISION_HOP(dir), now: () => DECISION_NOW });
  assert.match(
    block.markdown,
    /### Pending decisions\n- X1: needs_answers -> \.delivery\/X1\/1792000000000\/clarify\.md/,
  );
});

test('a needs_answers run is absent from in-flight runs', async (t) => {
  const dir = workspace(t);
  attemptAt(dir, 'X1', '1792000000000', 'needs_answers', ['clarify.md']);
  const block = await buildCompactBlock({ cwd: dir, hopPath: DECISION_HOP(dir), now: () => DECISION_NOW });
  assert.doesNotMatch(block.markdown, /### In-flight runs\n- X1:/);
});

test('an answered needs_answers run is listed in neither pending decisions nor in-flight runs', async (t) => {
  const dir = workspace(t);
  attemptAt(dir, 'X1', '1792000000000', 'needs_answers', ['clarify.md', 'clarified-answers.json']);
  const block = await buildCompactBlock({ cwd: dir, hopPath: DECISION_HOP(dir), now: () => DECISION_NOW });
  assert.doesNotMatch(block.markdown, /X1/);
});

test('a needs_choice run points at its brief', async (t) => {
  const dir = workspace(t);
  attemptAt(dir, 'X2', '1792000000000', 'needs_choice', ['brief.md']);
  const block = await buildCompactBlock({ cwd: dir, hopPath: DECISION_HOP(dir), now: () => DECISION_NOW });
  assert.match(block.markdown, /- X2: needs_choice -> \.delivery\/X2\/1792000000000\/brief\.md/);
});

test('a needs_model_approval run points at its model-approval record', async (t) => {
  const dir = workspace(t);
  attemptAt(dir, 'X3', '1792000000000', 'needs_model_approval', ['model-approval.json']);
  const block = await buildCompactBlock({ cwd: dir, hopPath: DECISION_HOP(dir), now: () => DECISION_NOW });
  assert.match(
    block.markdown,
    /- X3: needs_model_approval -> \.delivery\/X3\/1792000000000\/model-approval\.json/,
  );
});

test('an open manager note is listed with its kind and id', async (t) => {
  const dir = workspace(t);
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: DECISION_HOP(dir),
    listNotes: () => ({
      notes: [managerNote('n-1', 'todo', 'Publish crate', '2026-10-14T17:46:40.000Z')],
      proposals: [],
    }),
  });
  assert.match(block.markdown, /### Open notes\n- \[todo\] Publish crate \(n-1\)/);
});

test('open notes are listed oldest first', async (t) => {
  const dir = workspace(t);
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: DECISION_HOP(dir),
    listNotes: () => ({
      notes: [
        managerNote('n-new', 'note', 'Newer note', '2026-10-14T18:00:00.000Z'),
        managerNote('n-old', 'note', 'Older note', '2026-10-14T17:00:00.000Z'),
      ],
      proposals: [],
    }),
  });
  assert.ok(block.markdown.indexOf('Older note') < block.markdown.indexOf('Newer note'));
});

test('capture proposals are listed newest first with their capture id', async (t) => {
  const dir = workspace(t);
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: DECISION_HOP(dir),
    listNotes: () => ({
      notes: [],
      proposals: [
        captureNote('n-old', 'risk', 'Older proposal', 'c-1', '2026-10-14T17:00:00.000Z'),
        captureNote('n-new', 'decision', 'Newer proposal', 'c-2', '2026-10-14T18:00:00.000Z'),
      ],
    }),
  });
  assert.ok(block.markdown.indexOf('Newer proposal (n-new, c-2)') < block.markdown.indexOf('Older proposal (n-old, c-1)'));
});

test('openPrs starts before the plan companion call', async (t) => {
  const dir = workspace(t);
  const order: string[] = [];
  await buildCompactBlock({
    cwd: dir,
    hopPath: hopAt(dir),
    openPrs: async () => {
      order.push('prs');
      return { status: 'none', prs: [], errors: [] };
    },
    callHop: async (_path, _tool, request) => {
      if (request.tool === 'plan.status') order.push('plan');
      return failing(request.tool, 'NO_ACTIVE_PLAN');
    },
  });
  assert.deepEqual(order.slice(0, 2), ['prs', 'plan']);
});

test('an open PR is listed with its head and base branches', async (t) => {
  const dir = workspace(t);
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: DECISION_HOP(dir),
    openPrs: async () => ({
      status: 'ok',
      prs: [{ repo: '.', number: 7, title: 'T', base: 'dev', head: 'f', draft: false, url: 'u' }],
      errors: [],
    }),
  });
  assert.match(block.markdown, /### Open PRs\n- \.#7 T \(f -> dev\)/);
});

test('trimming removes capture proposals first', async (t) => {
  const { deps } = memoryFixture(t);
  const full = await buildCompactBlock({ ...deps, maxChars: 100_000 });
  const block = await buildCompactBlock({ ...deps, maxChars: full.markdown.length - 1 });
  assert.doesNotMatch(block.markdown, /Ship 0\.11 first/);
});

test('trimming preserves open notes after capture proposals are gone', async (t) => {
  const { deps } = memoryFixture(t);
  const full = await buildCompactBlock({ ...deps, maxChars: 100_000 });
  const block = await buildCompactBlock({ ...deps, maxChars: full.markdown.length - 1 });
  assert.match(block.markdown, /- \[todo\] Publish crate \(n-1\)/);
});

test('trimming preserves pending decisions after capture proposals are gone', async (t) => {
  const { deps } = memoryFixture(t);
  const full = await buildCompactBlock({ ...deps, maxChars: 100_000 });
  const block = await buildCompactBlock({ ...deps, maxChars: full.markdown.length - 1 });
  assert.match(block.markdown, /- X1: needs_answers -> \.delivery\/X1\/1792000000000\/clarify\.md/);
});

test('trimming never removes the active plan section', async (t) => {
  const { deps } = memoryFixture(t);
  const full = await buildCompactBlock({ ...deps, maxChars: 100_000 });
  const block = await buildCompactBlock({ ...deps, maxChars: full.markdown.length - 1 });
  assert.match(block.markdown, /plan_X/);
});

test('a rejecting openPrs marks the PR section unavailable', async (t) => {
  const { deps } = memoryFixture(t);
  const block = await buildCompactBlock({
    ...deps,
    openPrs: async () => {
      throw new Error('gh down');
    },
  });
  assert.equal(block.sections.prs, 'unavailable');
});

test('a rejecting openPrs leaves open notes rendered', async (t) => {
  const { deps } = memoryFixture(t);
  const block = await buildCompactBlock({
    ...deps,
    openPrs: async () => {
      throw new Error('gh down');
    },
  });
  assert.match(block.markdown, /- \[todo\] Publish crate \(n-1\)/);
});

test('a throwing listNotes marks the notes section unavailable', async (t) => {
  const dir = workspace(t);
  const block = await buildCompactBlock({
    cwd: dir,
    hopPath: DECISION_HOP(dir),
    listNotes: () => {
      throw new Error('notes store damaged');
    },
  });
  assert.equal(block.sections.notes, 'unavailable');
});
