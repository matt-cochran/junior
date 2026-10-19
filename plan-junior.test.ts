// Behavioral tests for the Junior-optimized cpm plan module
// (`junior plan check` / `junior plan contracts`).
//
// Every scenario is offline and drives the public module surface. Each test
// asserts exactly one observable outcome: a finding code, cohort membership,
// contract field or the CLI JSON. No private helpers are inspected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOT_FILES, checkPlanForJunior, planContracts, runPlanCommand } from './plan-junior.ts';

const NODE = process.execPath;
const JUNIOR = join(import.meta.dirname, 'junior.ts');

// --- builders ---------------------------------------------------------------

function agent(id: string, opts: any = {}): any {
  const junior = opts.junior === undefined
    ? { workflow: 'test_first', acceptance: ['ok'], checks: [{ command: 'true' }] }
    : opts.junior;
  return {
    id,
    owned_files: opts.owned_files ?? [],
    prerequisites: opts.prerequisites ?? [],
    ...(opts.estimate ? { estimate: opts.estimate } : {}),
    ...(opts.milestone ? { milestone: true } : {}),
    metadata: {
      artifact: `do ${id}`,
      owner: opts.owner ?? 'agent',
      ...(junior === null ? {} : { junior }),
      ...(opts.metadata ?? {}),
    },
  };
}

function plan(...deliverables: any[]): any {
  return { deliverables };
}

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-plan-'));
}

function writePlan(dir: string, value: unknown): string {
  const path = join(dir, 'plan.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function codes(result: any): string[] {
  return result.findings.map((finding: any) => finding.code);
}

// --- HOT_FILES --------------------------------------------------------------

test('HOT_FILES lists the registration files that serialize cohorts', () => {
  assert.deepEqual(HOT_FILES, ['package.json', 'package-lock.json', 'scripts/build.mjs', 'CHANGELOG.md', 'README.md']);
});

// --- checkPlanForJunior findings -------------------------------------------

test('checkPlanForJunior flags a shared file between unordered deliverables', () => {
  const result = checkPlanForJunior(plan(agent('a', { owned_files: ['src/x.ts'] }), agent('b', { owned_files: ['src/x.ts'] })));
  assert.ok(codes(result).includes('SHARED_FILE_PARALLEL'));
});

test('checkPlanForJunior is not ok when two unordered deliverables share a file', () => {
  const result = checkPlanForJunior(plan(agent('a', { owned_files: ['src/x.ts'] }), agent('b', { owned_files: ['src/x.ts'] })));
  assert.equal(result.ok, false);
});

test('checkPlanForJunior accepts a shared file along a prerequisite chain', () => {
  const result = checkPlanForJunior(plan(
    agent('a', { owned_files: ['src/x.ts'] }),
    agent('b', { owned_files: ['src/x.ts'], prerequisites: [{ id: 'a', consumes: 'x' }] }),
  ));
  assert.equal(codes(result).includes('SHARED_FILE_PARALLEL'), false);
});

test('checkPlanForJunior flags a deliverable likely to exceed four hours', () => {
  const result = checkPlanForJunior(plan(agent('a', { estimate: { optimistic: 3, likely: 6, pessimistic: 9 } })));
  assert.ok(codes(result).includes('TOO_LARGE'));
});

test('checkPlanForJunior honors a custom maxHours', () => {
  const result = checkPlanForJunior(plan(agent('a', { estimate: { optimistic: 3, likely: 6, pessimistic: 9 } })), { maxHours: 8 });
  assert.equal(codes(result).includes('TOO_LARGE'), false);
});

test('checkPlanForJunior flags a deliverable without junior acceptance', () => {
  const result = checkPlanForJunior(plan(agent('a', { junior: { workflow: 'test_first', acceptance: [], checks: [{ command: 'true' }] } })));
  assert.ok(codes(result).includes('NO_ACCEPTANCE'));
});

test('checkPlanForJunior flags a deliverable without junior checks', () => {
  const result = checkPlanForJunior(plan(agent('a', { junior: { workflow: 'test_first', acceptance: ['ok'], checks: [] } })));
  assert.ok(codes(result).includes('NO_CHECKS'));
});

test('checkPlanForJunior flags a deliverable with no owned files', () => {
  const result = checkPlanForJunior(plan(agent('a')));
  assert.ok(codes(result).includes('NO_OWNED_FILES'));
});

test('checkPlanForJunior reports a hot file as info', () => {
  const result = checkPlanForJunior(plan(agent('a', { owned_files: ['package.json'] })));
  assert.equal(result.findings.find((finding: any) => finding.code === 'HOT_FILE')?.severity, 'info');
});

test('checkPlanForJunior flags a prerequisite edge without consumes text', () => {
  const result = checkPlanForJunior(plan(agent('a', { owned_files: ['a.ts'] }), agent('b', { owned_files: ['b.ts'], prerequisites: ['a'] })));
  assert.ok(codes(result).includes('INTERFACE_UNSPECIFIED'));
});

test('checkPlanForJunior skips a manager-owned deliverable', () => {
  const result = checkPlanForJunior(plan(agent('m', { owner: 'manager' })));
  assert.deepEqual(result.findings, []);
});

test('checkPlanForJunior skips a milestone deliverable', () => {
  const result = checkPlanForJunior(plan(agent('milestone-x', { milestone: true })));
  assert.deepEqual(result.findings, []);
});

// --- checkPlanForJunior cohorts --------------------------------------------

test('checkPlanForJunior never puts two shared-file deliverables in one cohort', () => {
  const result = checkPlanForJunior(plan(agent('a', { owned_files: ['src/x.ts'] }), agent('b', { owned_files: ['src/x.ts'] })));
  assert.equal(result.cohorts.every((cohort) => !(cohort.includes('a') && cohort.includes('b'))), true);
});

// --- planContracts ----------------------------------------------------------

test('planContracts omits provider when none is given', () => {
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: ['src/x.ts'] })), { cwd: '/repo' });
  assert.equal('provider' in contract, false);
});

test('planContracts omits model when none is given', () => {
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: ['src/x.ts'] })), { cwd: '/repo' });
  assert.equal('model' in contract, false);
});

test('planContracts records the metadata artifact as the deliverable', () => {
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: ['src/x.ts'] })), { cwd: '/repo' });
  assert.equal(contract.deliverable, 'do a');
});

test('planContracts names the owned files in the modify constraint', () => {
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: ['src/x.ts'] })), { cwd: '/repo' });
  assert.equal(contract.constraints[0], 'Only modify src/x.ts');
});

test('planContracts carries the junior acceptance list', () => {
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: ['src/x.ts'] })), { cwd: '/repo' });
  assert.deepEqual(contract.acceptance, ['ok']);
});

test('planContracts sets worktree isolation', () => {
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: ['src/x.ts'] })), { cwd: '/repo' });
  assert.equal(contract.isolation, 'worktree');
});

test('planContracts includes provider and model when given', () => {
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: ['src/x.ts'] })), { cwd: '/repo', provider: 'openrouter', model: 'm1' });
  assert.deepEqual([contract.provider, contract.model], ['openrouter', 'm1']);
});

// --- runPlanCommand ---------------------------------------------------------

test('runPlanCommand prints the check findings JSON', () => {
  const dir = workdir();
  const lines: string[] = [];
  runPlanCommand(['check', writePlan(dir, plan(agent('a', { owned_files: ['src/x.ts'] }), agent('b', { owned_files: ['src/x.ts'] })))], {
    cwd: dir,
    out: (line) => lines.push(line),
  });
  assert.ok(JSON.parse(lines.join('\n')).findings.some((finding: any) => finding.code === 'SHARED_FILE_PARALLEL'));
});

test('runPlanCommand returns exit code 1 when the plan is not ok', () => {
  const dir = workdir();
  const { exitCode } = runPlanCommand(['check', writePlan(dir, plan(agent('a', { owned_files: ['x.ts'] }), agent('b', { owned_files: ['x.ts'] })))], { cwd: dir, out: () => {} });
  assert.equal(exitCode, 1);
});

test('runPlanCommand writes one contract file per agent deliverable', () => {
  const dir = workdir();
  const { result } = runPlanCommand(['contracts', writePlan(dir, plan(agent('a', { owned_files: ['src/x.ts'] }))), '--out', 'contracts'], { cwd: dir, out: () => {} });
  assert.equal(result.written.length, 1);
});

// --- CLI dispatch -----------------------------------------------------------

test('junior plan check prints JSON findings', () => {
  const dir = workdir();
  const file = writePlan(dir, plan(agent('a', { owned_files: ['x.ts'] }), agent('b', { owned_files: ['x.ts'] })));
  const cli = spawnSync(NODE, [JUNIOR, 'plan', 'check', file], { cwd: dir, encoding: 'utf8' });
  assert.ok(JSON.parse(cli.stdout).findings.some((finding: any) => finding.code === 'SHARED_FILE_PARALLEL'));
});

test('junior plan check exits 1 for an unsafe plan', () => {
  const dir = workdir();
  const file = writePlan(dir, plan(agent('a', { owned_files: ['x.ts'] }), agent('b', { owned_files: ['x.ts'] })));
  const cli = spawnSync(NODE, [JUNIOR, 'plan', 'check', file], { cwd: dir, encoding: 'utf8' });
  assert.equal(cli.status, 1);
});

test('cohorts keep a dependency that runs through a manager-owned deliverable', () => {
  const plan = { deliverables: [
    { id: 'a', owned_files: ['a.ts'], prerequisites: [], metadata: { artifact: 'a', owner: 'agent' } },
    { id: 'm', owned_files: ['m.ts'], prerequisites: ['a'], metadata: { artifact: 'm', owner: 'manager' } },
    { id: 'b', owned_files: ['b.ts'], prerequisites: ['m'], metadata: { artifact: 'b', owner: 'agent' } },
  ] };
  assert.deepEqual(checkPlanForJunior(plan).cohorts, [['a'], ['b']]);
});

test('a shared file ordered through a manager-owned deliverable is not a parallel conflict', () => {
  const plan = { deliverables: [
    { id: 'a', owned_files: ['x.ts'], prerequisites: [], metadata: { artifact: 'a', owner: 'agent' } },
    { id: 'm', owned_files: [], prerequisites: ['a'], metadata: { artifact: 'm', owner: 'manager' } },
    { id: 'b', owned_files: ['x.ts'], prerequisites: ['m'], metadata: { artifact: 'b', owner: 'agent' } },
  ] };
  assert.equal(checkPlanForJunior(plan).findings.some((f) => f.code === 'SHARED_FILE_PARALLEL'), false);
});
