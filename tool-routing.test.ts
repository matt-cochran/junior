// Behavioral tests for the deterministic tool router.
//
// `routeTools` turns the trait probabilities from the single Jev readiness
// call into a ranked, explainable tool plan. Every scenario is offline and
// deterministic and asserts exactly one observable outcome through the module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { routeTools } from './tool-routing.ts';

const ROOT = import.meta.dirname;
const EVAL_TRAITS = join(ROOT, 'playbooks', 'eval-traits.json');
const CASES_DIR = join(ROOT, 'tasks', 'routing-eval', 'cases');

test('routeTools selects the vague-feature playbook for a vague request', () => {
  const route = routeTools({ vague_request: 1 });
  assert.equal(route.playbooks[0].id, 'vague-feature');
});

test('routeTools merges manager setup across selected playbooks without duplicates', () => {
  const route = routeTools({ risky_change: 1, plan_sized: 1 });
  assert.deepEqual(route.managerSetup, [
    'open an FMECA session and score failure modes before the edit',
    'sync a cpm plan with this deliverable and pin owned_files',
  ]);
});

test('routeTools returns one worker direction per selected tool application', () => {
  const route = routeTools({ risky_change: 1, plan_sized: 1 });
  assert.equal(route.workerDirections.length, route.tools.length);
});

test('routeTools names the tools call command for a non-matrix application', () => {
  const route = routeTools({ risky_change: 1 });
  assert.ok(route.workerDirections.some((d) => d.includes('junior tools call <hop> fmeca')));
});

test('routeTools ignores an unknown trait name instead of throwing', () => {
  const route = routeTools({ not_a_trait: 1 });
  assert.deepEqual(route.traits, {});
});

test('routeTools returns an empty plan for no traits', () => {
  const route = routeTools({});
  assert.deepEqual(route.tools, []);
});

test('routeTools covers at least 27 of the 30 routing cases', () => {
  const traits = JSON.parse(readFileSync(EVAL_TRAITS, 'utf8'));
  const cases = readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort();
  let passes = 0;
  for (const file of cases) {
    const key = file.replace(/\.json$/, '');
    const parsed = JSON.parse(readFileSync(join(CASES_DIR, file), 'utf8'));
    const route = routeTools(traits[key] ?? {});
    const produced = new Set(route.tools.map((t) => t.tool));
    const required = parsed.expected.tools.filter((t: any) => t.relevance === 'required').map((t: any) => t.tool);
    const missing = required.filter((tool: string) => !produced.has(tool));
    const forbidden = parsed.expected.notTools.filter((tool: string) => produced.has(tool));
    if (missing.length === 0 && forbidden.length === 0) passes += 1;
  }
  assert.ok(passes >= 27, `expected >=27 passing cases, got ${passes}`);
});
