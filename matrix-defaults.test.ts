import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSources,
  featureFromResult,
  newestResult,
  normalizeFeature,
  resolveMatrixHop,
  resolveMatrixModel,
  resolveMatrixPlan,
} from './matrix-defaults.ts';

function project(t: any, files: Record<string, string> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'junior-matrix-defaults-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.git'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const planLine = (name: string, planId: string, extra: Record<string, unknown> = {}) => ({
  name,
  selected_variant: 'main',
  archived: false,
  variants: [{ variant: 'main', plan_id: planId, selected: true, archived: false, plan_complete: false, ...extra }],
});

const listing = (lines: unknown[]) => async () => ({ ok: true, result: lines }) as any;

test('the hop defaults to the project default hop path when none is configured', (t) => {
  const root = project(t);
  assert.equal(resolveMatrixHop(root).path, join(root, '.delivery', 'setup', 'hop.json'));
});

test('an explicit hop wins over discovery', (t) => {
  const root = project(t);
  assert.equal(resolveMatrixHop(root, '/x/hop.json').path, '/x/hop.json');
});

test('the model defaults to the sole crossmatrix state model', (t) => {
  const root = project(t, { '.crossmatrix/state/acme.json': '{}', '.crossmatrix/state/.gitkeep': '' });
  assert.equal(resolveMatrixModel(root).id, 'acme');
});

test('the configured matrix.model wins over the crossmatrix store', (t) => {
  const root = project(t, {
    'delivery.config.json': JSON.stringify({ matrix: { model: 'pinned' } }),
    '.crossmatrix/state/acme.json': '{}',
  });
  assert.equal(resolveMatrixModel(root).id, 'pinned');
});

test('the model falls back to the unscoped package name', (t) => {
  const root = project(t, { 'package.json': JSON.stringify({ name: '@scope/My_App' }) });
  assert.equal(resolveMatrixModel(root).id, 'my-app');
});

test('several state models matching no project name are refused', (t) => {
  const root = project(t, { '.crossmatrix/state/a.json': '{}', '.crossmatrix/state/b.json': '{}' });
  assert.throws(() => resolveMatrixModel(root), /matrix\.model/);
});

test('several state models pick the one named after the project', (t) => {
  const root = project(t, {
    'package.json': JSON.stringify({ name: 'b' }),
    '.crossmatrix/state/a.json': '{}',
    '.crossmatrix/state/b.json': '{}',
  });
  assert.equal(resolveMatrixModel(root).id, 'b');
});

test('the default sources add jevitate when the project has a .jevitate directory', (t) => {
  const root = project(t, { '.jevitate/jobs.json': '[]' });
  assert.deepEqual(defaultSources(root, false), ['code', 'tests', 'jevitate']);
});

test('the default sources add cpm when a plan resolved', (t) => {
  const root = project(t);
  assert.deepEqual(defaultSources(root, true), ['code', 'tests', 'cpm']);
});

test('configured matrix.sources replace the detected sources', (t) => {
  const root = project(t, { 'delivery.config.json': JSON.stringify({ matrix: { sources: ['code'] } }) });
  assert.deepEqual(defaultSources(root, true), ['code']);
});

test('the plan defaults to the sole unfinished plan line', async (t) => {
  const root = project(t);
  const plan = await resolveMatrixPlan(root, 'hop.json', undefined, listing([
    planLine('done', 'plan_done', { plan_complete: true }),
    planLine('live', 'plan_live'),
  ]));
  assert.equal(plan.planId, 'plan_live');
});

test('archived plan lines are never chosen', async (t) => {
  const root = project(t);
  const plan = await resolveMatrixPlan(root, 'hop.json', undefined, listing([
    { ...planLine('old', 'plan_old'), archived: true },
  ]));
  assert.equal(plan.planId, undefined);
});

test('several unfinished plan lines leave the plan unresolved with candidates', async (t) => {
  const root = project(t);
  const plan = await resolveMatrixPlan(root, 'hop.json', undefined, listing([
    planLine('a', 'plan_a'),
    planLine('b', 'plan_b'),
  ]));
  assert.deepEqual(plan.candidates, ['plan_a (a)', 'plan_b (b)']);
});

test('the configured matrix.plan wins over plan.list', async (t) => {
  const root = project(t, { 'delivery.config.json': JSON.stringify({ matrix: { plan: 'plan_pinned' } }) });
  const plan = await resolveMatrixPlan(root, 'hop.json', undefined, listing([planLine('a', 'plan_a')]));
  assert.equal(plan.planId, 'plan_pinned');
});

test('a failing plan.list leaves the plan unresolved', async (t) => {
  const root = project(t);
  const plan = await resolveMatrixPlan(root, 'hop.json', undefined, async () => ({ ok: false }) as any);
  assert.equal(plan.planId, undefined);
});

test('the newest result is the latest timestamped run across deliverables', (t) => {
  const root = project(t, {
    '.delivery/a/100/result.json': '{}',
    '.delivery/b/300/result.json': '{}',
    '.delivery/a/200/result.json': '{}',
  });
  assert.equal(newestResult(root), join(root, '.delivery', 'b', '300', 'result.json'));
});

test('no delivery runs leave the result unresolved', (t) => {
  const root = project(t);
  assert.equal(newestResult(root), undefined);
});

test('a plan-leased result names its cpm deliverable as the feature', (t) => {
  const root = project(t, { 'r.json': JSON.stringify({ plan: { id: 'p', deliverable: 'd-1' } }) });
  assert.equal(featureFromResult(join(root, 'r.json')), 'cpm:cpm:d-1');
});

test('a result without a plan names no feature', (t) => {
  const root = project(t, { 'r.json': JSON.stringify({ id: 'x' }) });
  assert.equal(featureFromResult(join(root, 'r.json')), undefined);
});

test('a bare feature id means a cpm deliverable', () => {
  assert.equal(normalizeFeature('d-1'), 'cpm:cpm:d-1');
});

test('a cpm feature without the member prefix gains it', () => {
  assert.equal(normalizeFeature('cpm:d-1'), 'cpm:cpm:d-1');
});

test('a fully qualified feature is unchanged', () => {
  assert.equal(normalizeFeature('jevitate-jobs:job:checkout'), 'jevitate-jobs:job:checkout');
});
