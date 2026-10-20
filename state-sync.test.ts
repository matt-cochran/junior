// Behavioral tests for the companion-tool state mirror (`state-sync.ts`).
//
// One half exercises the PURE mappers that turn already-read tool state into
// crossmatrix observation descriptors; the other drives `syncState` with an
// injected fake HOP so no MCP server or network is touched. Every scenario
// asserts exactly one observable outcome through the public module interface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cpmStatusObservations,
  elicitationStateObservations,
  fmecaStateObservations,
  jevitateResultObservations,
  scientificProcessStateObservations,
  syncState,
  type StateObservation,
} from './state-sync.ts';

const fixturesRoot = join(import.meta.dirname, 'tools', 'test-fixtures', 'companions');
function fixture(dir: string, name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesRoot, dir, `${name}.json`), 'utf8'));
}
const cpmFixture = (name: string) => fixture('cpm@0.4.0', name);
const fmecaFixture = (name: string) => fixture('fmeca@0.2.0', name);
const elicitFixture = (name: string) => fixture('elicitation@0.1.0', name);
const spFixture = (name: string) => fixture('scientific-process@0.2.0', name);

function observe(op: any) {
  return op.op ?? op;
}

/** A fake HOP: reads come from `states`, writes are appended to `writes`. */
function harness(states: Record<string, unknown> = {}) {
  const writes: any[] = [];
  const thrown = new Set<string>();
  const callHop = async (_hop: string, tool: string, request: any) => {
    if (tool === 'crossmatrix') {
      writes.push(request.arguments.request);
      return { ok: true, result: { ok: true } };
    }
    if (thrown.has(tool)) throw new Error(`${tool} unavailable`);
    if (!(tool in states)) {
      return { ok: false, isError: true, note: null, error: { code: 'missing', message: `${tool} missing` } };
    }
    return { ok: true, result: states[tool] };
  };
  const loadHop = (_hop: string) => ({ tools: { crossmatrix: { sourceVersion: '0.3.0' } } });
  return { callHop, loadHop, writes, thrown };
}

function options(overrides: Record<string, unknown> = {}) {
  return { hopPath: '/tmp/hop.json', modelId: 'm1', deps: {}, ...overrides } as any;
}

// --- pure mappers: cpm ------------------------------------------------------

test('cpmStatusObservations records a completed deliverable as a complete observation on its member', () => {
  const observations = cpmStatusObservations({ deliverables: [['d1', 'complete']] }, 'plan1');
  assert.deepEqual(
    observations.map((o) => [o.from, o.to, o.observation]),
    [['cpm:d1', 'cpm:d1', 'complete']],
  );
});

test('cpmStatusObservations normalises an in-progress deliverable to in_progress', () => {
  const observations = cpmStatusObservations({ deliverables: [['d1', 'in-progress']] }, 'plan1');
  assert.equal(observations[0].observation, 'in_progress');
});

test('cpmStatusObservations ignores a deliverable with no recognised status', () => {
  const observations = cpmStatusObservations({ deliverables: [['d1', 'archived']] }, 'plan1');
  assert.equal(observations.length, 0);
});

// --- pure mappers: fmeca ----------------------------------------------------

test('fmecaStateObservations links a failure mode to the code file it names', () => {
  const observations = fmecaStateObservations(
    { failure_modes: [{ id: 'm1', name: 'Crash on submit', files: ['src/app.ts'] }] },
    's1',
  );
  assert.deepEqual(observations.map((o) => o.to), ['loc:src/app.ts']);
});

test('fmecaStateObservations links a failure mode to the feature member it names', () => {
  const observations = fmecaStateObservations(
    { failure_modes: [{ id: 'm1', name: 'Crash', feature: 'cpm:d1' }] },
    's1',
  );
  assert.deepEqual(observations.map((o) => [o.from, o.to]), [['fm:m1', 'cpm:d1']]);
});

// --- pure mappers: elicitation ----------------------------------------------

test('elicitationStateObservations links a withstood outcome claim to its jevitate outcome member', () => {
  const observations = elicitationStateObservations(
    { claims: [{ id: 'job:j1/outcome:fast', standing: 'withstood' }] },
    'job:j1',
  );
  assert.deepEqual(
    observations.map((o) => [o.from, o.to, o.observation]),
    [['claim:job:j1/outcome:fast', 'job:j1/outcome:fast', 'withstood']],
  );
});

test('elicitationStateObservations links a job-story claim to its requirement member', () => {
  const observations = elicitationStateObservations(
    { claims: [{ id: 'job:j1/story', standing: 'open' }] },
    'job:j1',
  );
  assert.deepEqual(observations.map((o) => o.to), ['job:j1']);
});

// --- pure mappers: scientific process ---------------------------------------

test('scientificProcessStateObservations records a Refuted verdict on its hypothesis link', () => {
  const observations = scientificProcessStateObservations(
    { hypotheses: [{ id: 'h1', statement: 'src/app.ts handles submit', verdict: 'Refuted' }] },
    'sp1',
  );
  assert.deepEqual(
    observations.map((o) => [o.from, o.observation]),
    [['hypothesis:h1', 'Refuted']],
  );
});

// --- pure mappers: jevitate journeys ----------------------------------------

test('jevitateResultObservations links a failing journey result to its journey member', () => {
  const observations = jevitateResultObservations([
    { journeyId: 'checkout', metadata: { job: 'j1', serves: ['fast'] }, outcome: 'heal-exhausted' },
  ]);
  const link = observations.find((o) => o.to === 'journey:checkout');
  assert.equal(link?.observation, 'failed');
});

test('jevitateResultObservations links a failing journey result to the outcomes it verifies', () => {
  const observations = jevitateResultObservations([
    { journeyId: 'checkout', metadata: { job: 'j1', serves: ['fast'] }, outcome: 'heal-exhausted' },
  ]);
  assert.deepEqual(observations.filter((o) => o.relationId === 'codemap-jevitate-jobs').map((o) => o.to), [
    'job:j1/outcome:fast',
  ]);
});

// --- syncState --------------------------------------------------------------

test('syncState records a completed cpm deliverable as a status observation on its member', async () => {
  const h = harness({ cpm: { deliverables: [['d1', 'complete']] } });
  const result = await syncState(
    options({ planId: 'plan1', deps: { callHop: h.callHop, loadHop: h.loadHop } }),
  );
  const full = (result as any).observations as StateObservation[];
  assert.deepEqual(
    full.map((o) => [o.from, o.observation]),
    [['cpm:d1', 'complete']],
  );
});

test('syncState resends identical request ids when state is unchanged', async () => {
  const h = harness({ cpm: { deliverables: [['d1', 'complete']] } });
  const deps = { callHop: h.callHop, loadHop: h.loadHop };
  const first = await syncState(options({ planId: 'plan1', deps }));
  const second = await syncState(options({ planId: 'plan1', deps }));
  assert.deepEqual(second.requestIds, first.requestIds);
});

test('syncState skips a missing elicitation session with a note', async () => {
  const h = harness({ cpm: { deliverables: [] } });
  const result = await syncState(
    options({
      planId: 'plan1',
      elicitationSession: 'job:gone',
      deps: { callHop: h.callHop, loadHop: h.loadHop },
    }),
  );
  assert.ok(result.notes.some((note) => note.includes('elicitation')));
});

test('syncState skips a tool whose read throws instead of failing', async () => {
  const h = harness({ cpm: { deliverables: [] } });
  h.thrown.add('cpm');
  const result = await syncState(options({ planId: 'plan1', deps: { callHop: h.callHop, loadHop: h.loadHop } }));
  assert.ok(result.notes.some((note) => note.includes('cpm')));
});

// --- recorded companion fixtures -------------------------------------------

test('syncState mirrors the cpm plan.status.progress fixture as a completed deliverable observation', async () => {
  const h = harness({ cpm: cpmFixture('plan.status.progress') });
  const result = await syncState(
    options({ planId: 'plan_FIXTURE', deps: { callHop: h.callHop, loadHop: h.loadHop } }),
  );
  assert.deepEqual(result.observations.map((o) => [o.from, o.observation]), [['cpm:d-api', 'complete']]);
});

test('fmecaStateObservations links the fmeca state.get fixture failure mode to its member', () => {
  const observations = fmecaStateObservations(fmecaFixture('state.get'), 'fixture-fmeca-20261020');
  assert.deepEqual(observations.map((o) => [o.from, o.to]), [['fm:fm1', 'fm:fm1']]);
});

test('syncState reads the elicitation state.get fixture without an unrecognized-shape note', async () => {
  const h = harness({ elicitation: elicitFixture('state.get') });
  const result = await syncState(
    options({ elicitationSession: 'fixture-elicit-20261020b', deps: { callHop: h.callHop, loadHop: h.loadHop } }),
  );
  assert.equal(result.notes.some((note) => note.includes('Unrecognized')), false);
});

test('scientificProcessStateObservations records the concluded fixture hypothesis verdict', () => {
  const observations = scientificProcessStateObservations(spFixture('state.get.concluded'), 'fixture-sp');
  assert.deepEqual(observations.map((o) => [o.from, o.observation]), [['hypothesis:h1', 'Supported']]);
});

test('syncState notes an unrecognized cpm plan.status response with its tool, method and keys', async () => {
  const h = harness({ cpm: { unexpected: [] } });
  const result = await syncState(
    options({ planId: 'plan1', deps: { callHop: h.callHop, loadHop: h.loadHop } }),
  );
  assert.ok(result.notes.includes('Unrecognized cpm.plan.status response; top-level keys: unexpected'));
});

test('syncState never copies an env value into an observation excerpt', async () => {
  const h = harness({
    elicitation: {
      claims: [
        {
          id: 'job:j1/outcome:fast',
          standing: 'withstood',
          env: { API_KEY: 'super-secret' },
          statement: 'API_KEY=super-secret',
        },
      ],
    },
  });
  const result = await syncState(
    options({
      elicitationSession: 'job:j1',
      deps: { callHop: h.callHop, loadHop: h.loadHop },
    }),
  );
  const excerpts = (result as any).observations.flatMap((o: StateObservation) =>
    o.evidence.map((e) => e.excerpt),
  );
  assert.equal(excerpts.some((excerpt) => excerpt.includes('super-secret')), false);
});
