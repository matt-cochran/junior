// Behavioral tests for the elicitation spec -> cpm draft plan bridge
// (`junior matrix plan-from-spec`).
//
// Every scenario is offline: the cpm lint runs through the repo's fake MCP
// fixture, the Jev classifier and crossmatrix code-map queries are injected as
// fakes, and each test asserts exactly one observable outcome through a public
// interface. No real tool binary, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHop } from './tools/tools.ts';
import { MAX_GATE_QUESTIONS, type GateClassifier, type GateQuestion } from './worker.ts';
import { buildPlanFromSpec, planFromSpec, runPlanFromSpec } from './spec-bridge.ts';

const ROOT = import.meta.dirname;
const JUNIOR = join(ROOT, 'junior.ts');
const FAKE = join(ROOT, 'tools', 'test-fixtures', 'fake-mcp.mjs');
const NODE = process.execPath;

const READY_SPEC = {
  session_id: 's1',
  ready: true,
  dimensions: [],
  requirements: [
    {
      id: 'r-auth',
      statement: 'authenticate users',
      subject: { id: 'user' },
      capability: 'auth',
      acceptance_criteria: ['token issued'],
      priority: 'must',
    },
    {
      id: 'r-api',
      statement: 'serve the API',
      subject: { id: 'api' },
      capability: 'api',
      condition: 'after auth',
      acceptance_criteria: ['200 ok'],
      priority: 'should',
    },
    {
      id: 'r-ui',
      statement: 'render the UI',
      subject: { id: 'ui' },
      capability: 'ui',
      acceptance_criteria: [],
      priority: 'could',
    },
  ],
  accepted_tensions: [],
  blockers: [],
};

function requirementDeliverables(plan: any): any[] {
  return plan.deliverables.filter((d: any) => !d.milestone && String(d.metadata?.source ?? '').startsWith('elicitation:'));
}

function deliverable(plan: any, id: string): any {
  return plan.deliverables.find((d: any) => d.id === id);
}

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-spec-bridge-'));
}

function fakeClassifier(probabilities: Record<string, number>) {
  const calls: Array<Record<string, GateQuestion>> = [];
  const classify: GateClassifier = async ({ questions }) => {
    calls.push(questions);
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(questions)) {
      answers[id] = { type: 'bool', probability: probabilities[id] ?? 0 };
    }
    return { answers };
  };
  return { classify, calls };
}

// --- buildPlanFromSpec: the requirement -> deliverable mapping ---------------

test('buildPlanFromSpec emits one deliverable per requirement', () => {
  const plan = buildPlanFromSpec(READY_SPEC);
  assert.equal(requirementDeliverables(plan).length, 3);
});

test('buildPlanFromSpec adds a spec-accepted milestone', () => {
  const plan = buildPlanFromSpec(READY_SPEC);
  assert.equal(deliverable(plan, 'spec-accepted')?.milestone, true);
});

test('buildPlanFromSpec defaults a missing estimate to 2/4/8 hours', () => {
  const plan = buildPlanFromSpec(READY_SPEC);
  assert.deepEqual(deliverable(plan, 'r-auth')?.estimate, { optimistic: 2, likely: 4, pessimistic: 8 });
});

test('buildPlanFromSpec earns zero_hundred when the likely estimate is two hours', () => {
  const plan = buildPlanFromSpec(READY_SPEC, {
    estimates: { 'r-auth': { optimistic: 1, likely: 2, pessimistic: 3 } },
  });
  assert.equal(deliverable(plan, 'r-auth')?.earning_rule, 'zero_hundred');
});

test('buildPlanFromSpec earns fifty_fifty when the likely estimate exceeds two hours', () => {
  const plan = buildPlanFromSpec(READY_SPEC);
  assert.equal(deliverable(plan, 'r-auth')?.earning_rule, 'fifty_fifty');
});

test('buildPlanFromSpec records the statement and acceptance criteria as the artifact', () => {
  const plan = buildPlanFromSpec(READY_SPEC);
  assert.equal(deliverable(plan, 'r-auth')?.metadata.artifact, 'authenticate users, verified by: token issued');
});

test('buildPlanFromSpec defaults a deliverable owner to agent', () => {
  const plan = buildPlanFromSpec(READY_SPEC);
  assert.equal(deliverable(plan, 'r-api')?.metadata.owner, 'agent');
});

test('buildPlanFromSpec uses the requirement owner when present', () => {
  const spec = {
    ...READY_SPEC,
    requirements: [{ ...READY_SPEC.requirements[0], owner: 'owner' }],
  };
  const plan = buildPlanFromSpec(spec);
  assert.equal(deliverable(plan, 'r-auth')?.metadata.owner, 'owner');
});

test('buildPlanFromSpec records the elicitation session and requirement id as the source', () => {
  const plan = buildPlanFromSpec(READY_SPEC);
  assert.equal(deliverable(plan, 'r-auth')?.metadata.source, 'elicitation:s1/r-auth');
});

test('buildPlanFromSpec carries the requirement acceptance criteria as junior acceptance', () => {
  const plan = buildPlanFromSpec(READY_SPEC);
  assert.deepEqual(deliverable(plan, 'r-auth')?.metadata.junior?.acceptance, ['token issued']);
});

test('buildPlanFromSpec adds a prerequisite when a condition names another capability', () => {
  const plan = buildPlanFromSpec(READY_SPEC);
  const edge = deliverable(plan, 'r-api')?.prerequisites?.find((p: any) => p.id === 'r-auth');
  assert.equal(edge?.consumes, 'auth');
});

test('buildPlanFromSpec creates no prerequisite without explicit evidence', () => {
  const plan = buildPlanFromSpec(READY_SPEC);
  assert.equal(deliverable(plan, 'r-ui')?.prerequisites?.some((p: any) => p.id === 'r-auth'), false);
});

test('buildPlanFromSpec leaves owned_files empty without a code map', () => {
  const plan = buildPlanFromSpec(READY_SPEC);
  assert.deepEqual(deliverable(plan, 'r-auth')?.owned_files, []);
});

// --- planFromSpec: suggested edges and the code map --------------------------

test('planFromSpec drops suggested edges below the 0.7 confidence threshold', async () => {
  const { classify } = fakeClassifier(Object.fromEntries(
    ['edge:r-auth:r-api', 'edge:r-auth:r-ui', 'edge:r-api:r-auth', 'edge:r-api:r-ui', 'edge:r-ui:r-auth', 'edge:r-ui:r-api'].map((id) => [id, 0.6]),
  ));
  const plan = await planFromSpec(READY_SPEC, { suggestEdges: true }, { classify });
  const suggested = plan.deliverables.flatMap((d: any) => d.prerequisites ?? []).filter((p: any) => p.metadata?.edge_suggested);
  assert.equal(suggested.length, 0);
});

test('planFromSpec keeps a suggested edge at 0.7 and marks it for review', async () => {
  const { classify } = fakeClassifier({ 'edge:r-ui:r-auth': 0.7 });
  const plan = await planFromSpec(READY_SPEC, { suggestEdges: true }, { classify });
  const edge = deliverable(plan, 'r-auth')?.prerequisites?.find((p: any) => p.id === 'r-ui');
  assert.equal(edge?.metadata?.edge_suggested, true);
});

test('planFromSpec bounds each classifier call to MAX_GATE_QUESTIONS questions', async () => {
  const many = {
    ...READY_SPEC,
    requirements: Array.from({ length: 7 }, (_v, i) => ({
      id: `r${i}`,
      statement: `requirement ${i}`,
      subject: { id: `s${i}` },
      capability: `cap${i}`,
      acceptance_criteria: [],
    })),
  };
  const { classify, calls } = fakeClassifier({});
  await planFromSpec(many, { suggestEdges: true }, { classify });
  assert.equal(calls.every((questions) => Object.keys(questions).length <= MAX_GATE_QUESTIONS), true);
});

test('planFromSpec fills owned_files from crossmatrix implements links', async () => {
  const codemapFiles = (async (options: any) =>
    options.feature === 'cpm:r-auth'
      ? [{ path: 'src/auth.ts', observation: 'implements', relation: 'codemap-implements' }]
      : []) as any;
  const plan = await planFromSpec(
    READY_SPEC,
    { codemap: { hopPath: 'hop.json', modelId: 'm1' } },
    { codemapFiles },
  );
  assert.deepEqual(deliverable(plan, 'r-auth')?.owned_files, ['src/auth.ts']);
});

// --- runPlanFromSpec: refusal, overwrite guard and lint ----------------------

test('runPlanFromSpec refuses an unready spec with exit code 2', async () => {
  const spec = { ...READY_SPEC, ready: false, blockers: ['missing owner'] };
  const code = await runPlanFromSpec(['--spec', writeSpec(workdir(), spec), '--name', 'p']);
  assert.equal(code, 2);
});

test('runPlanFromSpec reports the blockers of an unready spec', () => {
  const dir = workdir();
  const spec = { ...READY_SPEC, ready: false, blockers: ['missing owner'] };
  const cli = spawnSync(NODE, [JUNIOR, 'matrix', 'plan-from-spec', '--spec', writeSpec(dir, spec), '--name', 'p'], {
    encoding: 'utf8',
  });
  assert.equal(cli.stderr.includes('missing owner'), true);
});

test('runPlanFromSpec proceeds on an unready spec with --allow-unready', async () => {
  const dir = workdir();
  const hop = fakeCpmHop(dir);
  const spec = { ...READY_SPEC, ready: false, blockers: ['missing owner'] };
  const code = await runPlanFromSpec([
    '--spec', writeSpec(dir, spec), '--name', 'p', '--dir', dir, '--hop', hop, '--allow-unready',
  ]);
  assert.equal(code, 0);
});

test('runPlanFromSpec does not overwrite an existing plan without --force', async () => {
  const dir = workdir();
  const out = join(dir, '.cpm-planner', 'plans', 'p', 'main.json');
  mkdirSync(join(dir, '.cpm-planner', 'plans', 'p'), { recursive: true });
  writeFileSync(out, '{"deliverables":[]}');
  const code = await runPlanFromSpec(['--spec', writeSpec(dir, READY_SPEC), '--name', 'p', '--dir', dir]);
  assert.equal(code, 1);
});

test('runPlanFromSpec writes the plan to .cpm-planner/plans/<name>/main.json', async () => {
  const dir = workdir();
  const hop = fakeCpmHop(dir);
  const code = await runPlanFromSpec([
    '--spec', writeSpec(dir, READY_SPEC), '--name', 'p', '--dir', dir, '--hop', hop,
  ]);
  assert.equal(existsSync(join(dir, '.cpm-planner', 'plans', 'p', 'main.json')), true);
});

test('runPlanFromSpec returns 0 when the cpm lint is clean', async () => {
  const dir = workdir();
  const hop = fakeCpmHop(dir);
  const code = await runPlanFromSpec([
    '--spec', writeSpec(dir, READY_SPEC), '--name', 'p', '--dir', dir, '--hop', hop,
  ]);
  assert.equal(code, 0);
});

test('runPlanFromSpec loads the spec from the hop elicitation tool with --session', async () => {
  const callHop = (async (_hop: string, tool: string) =>
    tool === 'elicitation'
      ? { ok: true, result: READY_SPEC }
      : { ok: true, result: { clean: true, findings: [] } }) as any;
  const dir = workdir();
  const code = await runPlanFromSpec(
    ['--session', 's1', '--name', 'p', '--dir', dir, '--hop', 'hop.json'],
    { callHop },
  );
  assert.equal(code, 0);
});

// --- CLI dispatch -----------------------------------------------------------

test('junior matrix plan-from-spec is dispatched with the bridge refusal code', () => {
  const dir = workdir();
  const spec = { ...READY_SPEC, ready: false, blockers: ['missing owner'] };
  const cli = spawnSync(NODE, [JUNIOR, 'matrix', 'plan-from-spec', '--spec', writeSpec(dir, spec), '--name', 'p'], {
    encoding: 'utf8',
  });
  assert.equal(cli.status, 2);
});

// --- helpers ----------------------------------------------------------------

function writeSpec(dir: string, spec: unknown): string {
  const path = join(dir, 'spec.json');
  writeFileSync(path, JSON.stringify(spec));
  return path;
}

/** A hop whose cpm tool is the repo's fake MCP fixture in echo mode. */
function fakeCpmHop(dir: string): string {
  const hop = join(dir, 'hop.json');
  initHop(hop, {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: {
      cpm: {
        command: NODE,
        args: [FAKE],
        env: { FAKE_MCP_MODE: 'echo' },
        sourceVersion: '0.3.0',
        sourceSha: '0'.repeat(64),
      },
    },
  });
  return hop;
}
