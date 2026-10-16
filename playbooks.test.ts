// Behavioral tests for the declarative multi-tool playbooks and the
// deterministic capability map.
//
// Every scenario is offline and deterministic. Each test asserts exactly one
// observable outcome through a public interface (the playbooks module, the
// shipped catalog, or the `junior matrix` CLI).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHop } from './tools/tools.ts';
import {
  loadPlaybooks,
  selectPlaybooks,
  toolPlan,
  validatePlaybooks,
  type PlaybookCatalog,
} from './playbooks.ts';

const ROOT = import.meta.dirname;
const NODE = process.execPath;
const JUNIOR = join(ROOT, 'junior.ts');
const FAKE = join(ROOT, 'tools', 'test-fixtures', 'fake-mcp.mjs');
const CASES_DIR = join(ROOT, 'tasks', 'routing-eval', 'cases');
const EVAL_TRAITS = join(ROOT, 'playbooks', 'eval-traits.json');

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-playbooks-'));
}

function catalogWithStep(over: Record<string, unknown>): PlaybookCatalog {
  const catalog = structuredClone(loadPlaybooks());
  Object.assign(catalog.playbooks[0].steps[0], over);
  return catalog;
}

// --- validatePlaybooks ------------------------------------------------------

test('validatePlaybooks rejects an unknown tool application', () => {
  const errors = validatePlaybooks(catalogWithStep({ application: 'cpm:made-up' }));
  assert.ok(errors.some((e) => e.includes('cpm:made-up')));
});

test('validatePlaybooks rejects an unknown tool name', () => {
  const errors = validatePlaybooks(catalogWithStep({ tool: 'not-a-tool', application: 'not-a-tool:any' }));
  assert.ok(errors.some((e) => e.includes('not-a-tool')));
});

test('validatePlaybooks rejects an unknown trait', () => {
  const catalog = structuredClone(loadPlaybooks());
  catalog.playbooks[0].traits = { not_a_trait: 1 };
  const errors = validatePlaybooks(catalog);
  assert.ok(errors.some((e) => e.includes('not_a_trait')));
});

test('validatePlaybooks accepts the shipped catalog', () => {
  assert.deepEqual(validatePlaybooks(loadPlaybooks()), []);
});

// --- selectPlaybooks --------------------------------------------------------

test('selectPlaybooks ranks vague-feature first for vague_request+plan_sized', () => {
  const selected = selectPlaybooks({ vague_request: 1, plan_sized: 1 });
  assert.equal(selected[0].id, 'vague-feature');
});

test('selectPlaybooks omits playbooks whose traits are all zero', () => {
  const selected = selectPlaybooks({ vague_request: 1, risky_change: 0 });
  assert.equal(selected.length, 1);
});

// --- toolPlan ---------------------------------------------------------------

test('toolPlan merges managerSetup across the selected playbooks without duplicates', () => {
  const plan = toolPlan(selectPlaybooks({ risky_change: 1, plan_sized: 1 }));
  assert.deepEqual(plan.managerSetup, [
    'open an FMECA session and score failure modes before the edit',
    'sync a cpm plan with this deliverable and pin owned_files',
  ]);
});

test('toolPlan deduplicates a tool application shared by two selected playbooks', () => {
  const plan = toolPlan(selectPlaybooks({ risky_change: 1, plan_sized: 1 }));
  assert.equal(plan.tools.filter((t) => t.application === 'cpm:plan-backed-deliverable').length, 1);
});

// --- matrix capability map --------------------------------------------------

test('junior matrix sync --source playbooks registers the three capability dimensions', () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = join(dir, 'hop.json');
  initHop(hop, {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: {
      crossmatrix: {
        command: NODE,
        args: [FAKE],
        env: { FAKE_MCP_MODE: 'crossmatrix', FAKE_CROSSMATRIX_WRITES: log },
        sourceVersion: '0.3.0',
        sourceSha: '0'.repeat(64),
      },
    },
  });
  const result = spawnSync(
    NODE,
    [JUNIOR, 'matrix', 'sync', '--source', 'playbooks', '--hop', hop, '--model', 'm1'],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.synced.map((s: any) => s.dimensionId), [
    'task-traits',
    'playbooks',
    'tool-applications',
  ]);
});

// --- routing evaluation -----------------------------------------------------

test('the eval traits cover every routing case', () => {
  const traits = JSON.parse(readFileSync(EVAL_TRAITS, 'utf8'));
  const cases = readdirSync(CASES_DIR).filter((f) => f.endsWith('.json'));
  const missing = cases
    .map((f) => f.replace(/\.json$/, ''))
    .filter((key) => !(key in traits));
  assert.deepEqual(missing, []);
});

test('the playbook plan covers at least 27 of the 30 routing cases', () => {
  const traits = JSON.parse(readFileSync(EVAL_TRAITS, 'utf8'));
  const cases = readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort();
  const misses: string[] = [];
  let passes = 0;
  for (const file of cases) {
    const key = file.replace(/\.json$/, '');
    const label = traits[key];
    const parsed = JSON.parse(readFileSync(join(CASES_DIR, file), 'utf8'));
    const plan = toolPlan(selectPlaybooks(label));
    const produced = new Set(plan.tools.map((t) => t.tool));
    const required = parsed.expected.tools
      .filter((t: any) => t.relevance === 'required')
      .map((t: any) => t.tool);
    const missing = required.filter((tool: string) => !produced.has(tool));
    const forbidden = parsed.expected.notTools.filter((tool: string) => produced.has(tool));
    if (missing.length === 0 && forbidden.length === 0) passes += 1;
    else misses.push(`${file}: missing=[${missing}] forbidden=[${forbidden}]`);
  }
  if (misses.length > 0) console.log(`routing misses:\n  ${misses.join('\n  ')}`);
  assert.ok(passes >= 27, `expected >=27 passing cases, got ${passes}`);
});
