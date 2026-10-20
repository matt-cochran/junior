// Behavioral tests for companion-shapes.ts: the single module that reads
// companion responses. Every scenario is offline and reads only the recorded
// fixtures under tools/test-fixtures/companions plus legacy synthetic shapes.
// Each test asserts exactly one observable outcome through the public API.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ShapeError,
  VERIFIED_VERSIONS,
  cohortDeliverableIds,
  elicitationClaims,
  elicitationSignals,
  elicitationTopSignal,
  fmecaFailureModes,
  planDeliverables,
  planLocks,
  planStatusRows,
  spHypotheses,
  strictItems,
} from './companion-shapes.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, 'tools', 'test-fixtures', 'companions');

function fixture(dir: string, name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesRoot, dir, `${name}.json`), 'utf8'));
}
function parse(text: string): unknown {
  return JSON.parse(text);
}

const cpm = (name: string) => fixture('cpm@0.4.0', name);
const fmeca = (name: string) => fixture('fmeca@0.2.0', name);
const elicit = (name: string) => fixture('elicitation@0.1.0', name);
const sp = (name: string) => fixture('scientific-process@0.2.0', name);

// ---------------------------------------------------------------------------
// planDeliverables
// ---------------------------------------------------------------------------

test('planDeliverables returns every deliverable from the cpm plan.get fixture', () => {
  assert.deepEqual(planDeliverables(cpm('plan.get')).items.map((d) => d.id), ['d-api', 'd-docs', 'ms']);
});

test('planDeliverables labels the cpm plan.get fixture as graph.deliverables', () => {
  assert.equal(planDeliverables(cpm('plan.get')).shape, 'graph.deliverables');
});

test('planDeliverables accepts the cpm acquire_cohort deliverables shape', () => {
  assert.deepEqual(planDeliverables(cpm('plan.acquire_cohort')).items.map((d) => d.id), ['d-api']);
});

const deliverableShapes: Array<[string, unknown, string]> = [
  ['bare array', [{ id: 'a' }], 'array'],
  ['top-level deliverables', { deliverables: [{ id: 'a' }] }, 'deliverables'],
  ['plan.deliverables', { plan: { deliverables: [{ id: 'a' }] } }, 'plan.deliverables'],
  ['graph.deliverables', { graph: { deliverables: [{ id: 'a' }] } }, 'graph.deliverables'],
];
for (const [name, raw, shape] of deliverableShapes) {
  test(`planDeliverables accepts the legacy ${name} shape`, () => {
    assert.equal(planDeliverables(raw).shape, shape);
  });
}
for (const [name, raw] of deliverableShapes) {
  test(`planDeliverables reads items from the legacy ${name} shape`, () => {
    assert.deepEqual(planDeliverables(raw).items.map((d) => d.id), ['a']);
  });
}

test('planDeliverables recognizes an empty array with zero items', () => {
  assert.deepEqual(planDeliverables([]), { items: [], shape: 'array', recognized: true });
});

test('planDeliverables recognizes an expected empty deliverables array', () => {
  assert.deepEqual(planDeliverables({ graph: { deliverables: [] } }), {
    items: [],
    shape: 'graph.deliverables',
    recognized: true,
  });
});

test('planDeliverables recognizes null as an empty response', () => {
  assert.equal(planDeliverables(null).recognized, true);
});

test('planDeliverables marks an object with no known keys unrecognized', () => {
  assert.equal(planDeliverables({ ok: true }).recognized, false);
});

// ---------------------------------------------------------------------------
// planStatusRows
// ---------------------------------------------------------------------------

test('planStatusRows reads ids and statuses from the cpm plan.status fixture', () => {
  assert.deepEqual(
    planStatusRows(cpm('plan.status')).items.map((r) => [r.id, r.status]),
    [
      ['d-api', 'ready'],
      ['d-docs', 'pending'],
      ['ms', 'pending'],
    ],
  );
});

test('planStatusRows lowercases the leased deliverable status', () => {
  assert.equal(planStatusRows(cpm('plan.status.leased')).items[0].status, 'in_progress');
});

test('planStatusRows reads the progressed deliverable status', () => {
  assert.equal(planStatusRows(cpm('plan.status.progress')).items[0].status, 'complete');
});

const statusShapes: Array<[string, unknown, string]> = [
  ['deliverables', { deliverables: [['d1', { status: 'ready' }]] }, 'deliverables'],
  ['rows', { rows: [['d1', { status: 'ready' }]] }, 'rows'],
  ['statuses', { statuses: [['d1', { status: 'ready' }]] }, 'statuses'],
];
for (const [name, raw, shape] of statusShapes) {
  test(`planStatusRows accepts the legacy ${name} key`, () => {
    assert.equal(planStatusRows(raw).shape, shape);
  });
}

test('planStatusRows accepts a string status on a tuple row', () => {
  assert.equal(planStatusRows({ rows: [['d1', 'In Progress']] }).items[0].status, 'in progress');
});

test('planStatusRows accepts object rows with deliverableId and markStatus aliases', () => {
  assert.deepEqual(
    planStatusRows({ rows: [{ deliverableId: 'd1', markStatus: 'Blocked' }] }).items[0],
    { id: 'd1', status: 'blocked', raw: 'Blocked' },
  );
});

test('planStatusRows recognizes an empty rows array with zero items', () => {
  assert.equal(planStatusRows({ rows: [] }).items.length, 0);
});

test('planStatusRows marks an object with no known keys unrecognized', () => {
  assert.equal(planStatusRows({ ok: true }).recognized, false);
});

// ---------------------------------------------------------------------------
// planLocks
// ---------------------------------------------------------------------------

test('planLocks reads acquire_cohort locks', () => {
  assert.deepEqual(planLocks(cpm('plan.acquire_cohort')).items, [
    {
      deliverableId: 'd-api',
      callerId: 'fixture-worker',
      expiresAt: '2026-01-01T00:00:00Z',
    },
  ]);
});

test('planLocks reads plan.status locks_held', () => {
  assert.equal(planLocks(cpm('plan.status.leased')).items[0].deliverableId, 'd-api');
});

test('planLocks labels the acquire_cohort shape as locks', () => {
  assert.equal(planLocks(cpm('plan.acquire_cohort')).shape, 'locks');
});

test('planLocks labels the plan.status shape as locks_held', () => {
  assert.equal(planLocks(cpm('plan.status.leased')).shape, 'locks_held');
});

test('planLocks recognizes an empty locks_held array with zero items', () => {
  assert.equal(planLocks(cpm('plan.status')).items.length, 0);
});

test('planLocks marks an object with no known keys unrecognized', () => {
  assert.equal(planLocks({ ok: true }).recognized, false);
});

// ---------------------------------------------------------------------------
// cohortDeliverableIds
// ---------------------------------------------------------------------------

test('cohortDeliverableIds reads ids from the acquire_cohort fixture', () => {
  assert.deepEqual(cohortDeliverableIds(cpm('plan.acquire_cohort')).items, ['d-api']);
});

test('cohortDeliverableIds accepts string deliverable entries', () => {
  assert.deepEqual(cohortDeliverableIds({ deliverables: ['d1', 'd2'] }).items, ['d1', 'd2']);
});

test('cohortDeliverableIds accepts object deliverable entries', () => {
  assert.deepEqual(cohortDeliverableIds({ deliverables: [{ id: 'd1' }] }).items, ['d1']);
});

test('cohortDeliverableIds marks an object with no known keys unrecognized', () => {
  assert.equal(cohortDeliverableIds({ ok: true }).recognized, false);
});

// ---------------------------------------------------------------------------
// fmecaFailureModes
// ---------------------------------------------------------------------------

test('fmecaFailureModes reads the failure mode from the fmeca append fixture', () => {
  assert.deepEqual(fmecaFailureModes(fmeca('append')).items.map((m) => m.id), ['fm1']);
});

test('fmecaFailureModes reads the failure mode from the fmeca state.get fixture', () => {
  assert.equal(fmecaFailureModes(fmeca('state.get')).items.length, 1);
});

test('fmecaFailureModes recognizes an empty session.open failure_modes array', () => {
  assert.equal(fmecaFailureModes(fmeca('session.open')).items.length, 0);
});

test('fmecaFailureModes marks the fmeca report.export rows shape unrecognized', () => {
  assert.equal(fmecaFailureModes(fmeca('report.export')).recognized, false);
});

const fmecaShapes: Array<[string, string]> = [
  ['failure_modes', 'failure_modes'],
  ['failureModes', 'failureModes'],
  ['modes', 'modes'],
  ['risks', 'risks'],
];
for (const [name, key] of fmecaShapes) {
  test(`fmecaFailureModes accepts the legacy ${name} key`, () => {
    assert.equal(fmecaFailureModes({ [key]: [{ id: 'm1' }] }).shape, name);
  });
}

test('fmecaFailureModes accepts a bare array', () => {
  assert.equal(fmecaFailureModes([{ id: 'm1' }]).items.length, 1);
});

test('fmecaFailureModes marks an object with no known keys unrecognized', () => {
  assert.equal(fmecaFailureModes({ readiness: {} }).recognized, false);
});

// ---------------------------------------------------------------------------
// elicitationClaims
// ---------------------------------------------------------------------------

test('elicitationClaims reads claims from the elicitation append fixture', () => {
  assert.deepEqual(elicitationClaims(elicit('append')).items.map((c) => c.id), ['c1']);
});

test('elicitationClaims reads both claims from the contradiction fixture', () => {
  assert.equal(elicitationClaims(elicit('append.contradiction')).items.length, 2);
});

test('elicitationClaims reads both claims from the elicitation state.get fixture', () => {
  assert.equal(elicitationClaims(elicit('state.get')).items.length, 2);
});

test('elicitationClaims recognizes an empty session.open claims array', () => {
  assert.equal(elicitationClaims(elicit('session.open')).items.length, 0);
});

const claimArrayShapes: Array<[string, string]> = [
  ['claims', 'claims'],
  ['claim_standings', 'claim_standings'],
  ['claimStandings', 'claimStandings'],
];
for (const [name, key] of claimArrayShapes) {
  test(`elicitationClaims accepts the legacy ${name} key`, () => {
    assert.equal(elicitationClaims({ [key]: [{ id: 'c1' }] }).shape, name);
  });
}

test('elicitationClaims accepts a state.claims nested array', () => {
  assert.equal(elicitationClaims({ state: { claims: [{ id: 'c1' }] } }).shape, 'state.claims');
});

test('elicitationClaims accepts a map shape and fills missing ids from keys', () => {
  assert.equal(elicitationClaims({ claims: { c1: { standing: 'open' } } }).items[0].id, 'c1');
});

test('elicitationClaims preserves an explicit id in a map shape', () => {
  assert.equal(elicitationClaims({ claims: { key: { id: 'c9' } } }).items[0].id, 'c9');
});

test('elicitationClaims marks an object with no known keys unrecognized', () => {
  assert.equal(elicitationClaims({ readiness: {} }).recognized, false);
});

// ---------------------------------------------------------------------------
// elicitationSignals
// ---------------------------------------------------------------------------

test('elicitationSignals reads both signals from the elicitation append fixture', () => {
  assert.equal(elicitationSignals(elicit('append')).items.length, 2);
});

test('elicitationSignals reads all three signals from the contradiction fixture', () => {
  assert.equal(elicitationSignals(elicit('append.contradiction')).items.length, 3);
});

test('elicitationSignals reads all signals including non-clarify kinds', () => {
  assert.ok(elicitationSignals(elicit('append.contradiction')).items.some((s) => s.kind === 'notify'));
});

test('elicitationSignals accepts a state.signals nested array', () => {
  assert.equal(elicitationSignals({ state: { signals: [{ kind: 'clarify' }] } }).shape, 'state.signals');
});

test('elicitationSignals marks an object with no known keys unrecognized', () => {
  assert.equal(elicitationSignals({ readiness: {} }).recognized, false);
});

// ---------------------------------------------------------------------------
// elicitationTopSignal
// ---------------------------------------------------------------------------

test('elicitationTopSignal returns the question from question.next', () => {
  assert.equal(elicitationTopSignal(elicit('question.next'))?.kind, 'remediate');
});

test('elicitationTopSignal returns null when the response is done', () => {
  assert.equal(elicitationTopSignal({ done: true }), null);
});

test('elicitationTopSignal returns a signal field', () => {
  assert.equal(elicitationTopSignal({ signal: { kind: 'clarify' } })?.kind, 'clarify');
});

test('elicitationTopSignal returns the result itself when unframed', () => {
  assert.equal(elicitationTopSignal({ kind: 'notify', code: 'x' })?.code, 'x');
});

test('elicitationTopSignal returns null for an empty object', () => {
  assert.equal(elicitationTopSignal({}), null);
});

// ---------------------------------------------------------------------------
// spHypotheses
// ---------------------------------------------------------------------------

test('spHypotheses reads the hypothesis from the report.export fixture', () => {
  assert.deepEqual(spHypotheses(sp('report.export')).items.map((h) => h.hypothesis_id), ['h1']);
});

test('spHypotheses reads the hypothesis from the state.get fixture', () => {
  assert.deepEqual(spHypotheses(sp('state.get')).items.map((h) => h.id), ['h1']);
});

test('spHypotheses reads the concluded hypothesis from the state.get.concluded fixture', () => {
  assert.equal(spHypotheses(sp('state.get.concluded')).items[0].status, 'Supported');
});

test('spHypotheses accepts the legacy claims alias', () => {
  assert.equal(spHypotheses({ claims: [{ id: 'h1' }] }).shape, 'claims');
});

test('spHypotheses accepts a bare array', () => {
  assert.equal(spHypotheses([{ id: 'h1' }]).shape, 'array');
});

test('spHypotheses marks the session.open response unrecognized', () => {
  assert.equal(spHypotheses(sp('session.open')).recognized, false);
});

// ---------------------------------------------------------------------------
// strictItems and ShapeError
// ---------------------------------------------------------------------------

test('strictItems throws ShapeError for an unrecognized response', () => {
  assert.throws(() => strictItems(planDeliverables({ ok: true }), 'cpm', 'plan.get', { ok: true }), ShapeError);
});

test('strictItems names the tool on the error', () => {
  try {
    strictItems(planDeliverables({ ok: true }), 'cpm', 'plan.get', { ok: true });
    assert.fail('expected ShapeError');
  } catch (error) {
    assert.equal((error as ShapeError).tool, 'cpm');
  }
});

test('strictItems names the method on the error', () => {
  try {
    strictItems(planDeliverables({ ok: true }), 'cpm', 'plan.get', { ok: true });
    assert.fail('expected ShapeError');
  } catch (error) {
    assert.equal((error as ShapeError).method, 'plan.get');
  }
});

test('strictItems reports the response top-level keys on the error', () => {
  try {
    strictItems(planDeliverables({ ok: true }), 'cpm', 'plan.get', { ok: true });
    assert.fail('expected ShapeError');
  } catch (error) {
    assert.deepEqual((error as ShapeError).keys, ['ok']);
  }
});

test('strictItems names tool, method and keys in the error message', () => {
  try {
    strictItems(planDeliverables({ ok: true }), 'cpm', 'plan.get', { ok: true });
    assert.fail('expected ShapeError');
  } catch (error) {
    const message = (error as ShapeError).message;
    assert.ok(message.includes('cpm') && message.includes('plan.get') && message.includes('ok'));
  }
});

test('strictItems returns the items of a recognized response', () => {
  assert.deepEqual(strictItems(planDeliverables(cpm('plan.get')), 'cpm', 'plan.get', cpm('plan.get')).length, 3);
});

// ---------------------------------------------------------------------------
// VERIFIED_VERSIONS
// ---------------------------------------------------------------------------

test('VERIFIED_VERSIONS matches the tool/version pairs recorded in index.json', () => {
  const index = parse(readFileSync(join(fixturesRoot, 'index.json'), 'utf8')) as {
    tools: Record<string, { version: string; versions?: string[] }>;
  };
  const expected = Object.fromEntries(
    Object.entries(index.tools).map(([tool, meta]) => [tool, meta.versions ?? [meta.version]]),
  );
  assert.deepEqual(VERIFIED_VERSIONS, expected);
});
