// Behavioral tests for the Junior-optimized cpm plan module
// (`junior plan check` / `junior plan contracts`).
//
// Every scenario is offline and drives the public module surface. Each test
// asserts exactly one observable outcome: a finding code, cohort membership,
// contract field or the CLI JSON. No private helpers are inspected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOT_FILES, REGISTRATION_FILES, checkPlanForJunior, planContracts, registeredTestFiles, runPlanCommand, scorePlanFile } from './plan-junior.ts';

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

// --- model profile findings and contracts ----------------------------------

function planWithJunior(deliverables: any[], junior: any): any {
  return { deliverables, metadata: { junior } };
}

const profiledAgent = (id: string, profile: string): any => agent(id, {
  owned_files: ['src/x.ts'],
  junior: { workflow: 'test_first', profile, acceptance: ['ok'], checks: [{ command: 'true' }] },
});

test('checkPlanForJunior flags a deep-reasoning profile without plan approval', () => {
  const result = checkPlanForJunior(plan(profiledAgent('a', 'deep-reasoning')));
  assert.ok(codes(result).includes('NEEDS_MODEL_APPROVAL'));
});

test('checkPlanForJunior does not flag a deep-reasoning profile the plan approves', () => {
  const value = planWithJunior([profiledAgent('a', 'deep-reasoning')], { approvedProfiles: ['deep-reasoning'] });
  assert.equal(codes(checkPlanForJunior(value)).includes('NEEDS_MODEL_APPROVAL'), false);
});

test('checkPlanForJunior does not flag the default general profile', () => {
  const result = checkPlanForJunior(plan(profiledAgent('a', 'general')));
  assert.equal(codes(result).includes('NEEDS_MODEL_APPROVAL'), false);
});

test('planContracts carries the deliverable profile as modelProfile', () => {
  const [{ contract }] = planContracts(plan(profiledAgent('a', 'deep-reasoning')), { cwd: '/repo' });
  assert.equal(contract.modelProfile, 'deep-reasoning');
});

test('planContracts carries the plan approved profiles', () => {
  const value = planWithJunior([agent('a', { owned_files: ['src/x.ts'] })], { approvedProfiles: ['deep-reasoning'] });
  const [{ contract }] = planContracts(value, { cwd: '/repo' });
  assert.deepEqual(contract.approvedProfiles, ['deep-reasoning']);
});

test('planContracts omits approvedProfiles when the plan approves none', () => {
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: ['src/x.ts'] })), { cwd: '/repo' });
  assert.equal('approvedProfiles' in contract, false);
});

test('a shared file ordered through a manager-owned deliverable is not a parallel conflict', () => {
  const plan = { deliverables: [
    { id: 'a', owned_files: ['x.ts'], prerequisites: [], metadata: { artifact: 'a', owner: 'agent' } },
    { id: 'm', owned_files: [], prerequisites: ['a'], metadata: { artifact: 'm', owner: 'manager' } },
    { id: 'b', owned_files: ['x.ts'], prerequisites: ['m'], metadata: { artifact: 'b', owner: 'agent' } },
  ] };
  assert.equal(checkPlanForJunior(plan).findings.some((f) => f.code === 'SHARED_FILE_PARALLEL'), false);
});

// --- registration scope lessons --------------------------------------------

test('ownedFiles reads an append claim object as its path', () => {
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: [{ path: 'src/x.ts', mode: 'append' }] })), { cwd: '/repo' });
  assert.equal(contract.constraints[0], 'Only modify src/x.ts');
});

test('REGISTRATION_FILES lists the files that must stay coordinated', () => {
  assert.deepEqual(REGISTRATION_FILES, ['package.json', 'package-lock.json', 'scripts/build.mjs', 'junior.ts', 'cli.test.ts', 'CHANGELOG.md', 'README.md']);
});

test('planContracts defaults the model profile to general', () => {
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: ['src/x.ts'] })), { cwd: '/repo' });
  assert.equal(contract.modelProfile, 'general');
});

test('planContracts defaults the execution deadline to 1500000ms', () => {
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: ['src/x.ts'] })), { cwd: '/repo' });
  assert.equal((contract.execution as any).deadlineMs, 1500000);
});

test('planContracts allows a cargo check the longer check timeout', () => {
  const junior = { workflow: 'test_first', acceptance: ['ok'], checks: [{ command: 'cargo', args: ['test'] }] };
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: ['src/x.ts'], junior })), { cwd: '/repo' });
  assert.equal((contract.execution as any).checkTimeoutMs, 900000);
});

test('planContracts lets metadata.junior.execution override execution defaults', () => {
  const junior = { workflow: 'test_first', acceptance: ['ok'], checks: [{ command: 'true' }], execution: { deadlineMs: 1000 } };
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: ['src/x.ts'], junior })), { cwd: '/repo' });
  assert.equal((contract.execution as any).deadlineMs, 1000);
});

test('planContracts adds the registration files constraint', () => {
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: ['src/x.ts'] })), { cwd: '/repo' });
  assert.equal(contract.constraints[2], 'Do not edit registration files you do not own (package.json, package-lock.json, scripts/build.mjs, junior.ts, cli.test.ts, CHANGELOG.md, README.md); if your change needs registering there, say so in your final message instead');
});

test('planContracts omits an owned registration file from the constraint', () => {
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: ['package.json'] })), { cwd: '/repo' });
  assert.equal(contract.constraints[2], 'Do not edit registration files you do not own (package-lock.json, scripts/build.mjs, junior.ts, cli.test.ts, CHANGELOG.md, README.md); if your change needs registering there, say so in your final message instead');
});

test('registeredTestFiles returns only the test file tokens from scripts.test', () => {
  const value = { scripts: { test: 'node --test a.test.ts b.test.mjs c.test.js README.md' } };
  assert.deepEqual(registeredTestFiles(value), ['a.test.ts', 'b.test.mjs', 'c.test.js']);
});

test('checkPlanForJunior warns when a test owner has no package.json owner downstream', () => {
  const result = checkPlanForJunior(plan(agent('a', { owned_files: ['src/x.test.ts'] })), { registeredTests: [] });
  assert.ok(codes(result).includes('REGISTRATION_OUTSIDE_SCOPE'));
});

test('REGISTRATION_OUTSIDE_SCOPE cites the H2 observation', () => {
  const result = checkPlanForJunior(plan(agent('a', { owned_files: ['src/x.test.ts'] })), { registeredTests: [] });
  assert.match(result.findings.find((finding: any) => finding.code === 'REGISTRATION_OUTSIDE_SCOPE')?.message ?? '', /H2/);
});

test('checkPlanForJunior accepts a test owner with a package.json owner downstream', () => {
  const result = checkPlanForJunior(plan(
    agent('a', { owned_files: ['src/x.test.ts'] }),
    agent('b', { owned_files: ['package.json'], prerequisites: [{ id: 'a', consumes: 'test file' }] }),
  ), { registeredTests: [] });
  assert.equal(codes(result).includes('REGISTRATION_OUTSIDE_SCOPE'), false);
});

test('checkPlanForJunior accepts a test owner that owns package.json itself', () => {
  const result = checkPlanForJunior(plan(agent('a', { owned_files: ['src/x.test.ts', 'package.json'] })), { registeredTests: [] });
  assert.equal(codes(result).includes('REGISTRATION_OUTSIDE_SCOPE'), false);
});

test('checkPlanForJunior accepts a test file already registered in package.json', () => {
  const result = checkPlanForJunior(plan(agent('a', { owned_files: ['src/x.test.ts'] })), { registeredTests: ['src/x.test.ts'] });
  assert.equal(codes(result).includes('REGISTRATION_OUTSIDE_SCOPE'), false);
});

test('checkPlanForJunior skips the registration scope rule without registeredTests', () => {
  const result = checkPlanForJunior(plan(agent('a', { owned_files: ['src/x.test.ts'] })));
  assert.equal(codes(result).includes('REGISTRATION_OUTSIDE_SCOPE'), false);
});

test('planContracts omits the registration constraint when the deliverable owns every registration file', () => {
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: [...REGISTRATION_FILES] })), { cwd: '/repo' });
  assert.equal(contract.constraints.some((c: string) => c.startsWith('Do not edit registration files')), false);
});

// --- CLI10 contract scope and plan-time quality ----------------------------

test('planContracts records the owned files under scope.owned', () => {
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: ['src/x.ts', 'src/y.ts'] })), { cwd: '/repo' });
  assert.deepEqual((contract.scope as any).owned, ['src/x.ts', 'src/y.ts']);
});

test('runPlanCommand reads the registered tests from package.json', () => {
  const dir = workdir();
  const file = writePlan(dir, plan(agent('a', { owned_files: ['x.test.ts'] })));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test x.test.ts' } }));
  const { result } = runPlanCommand(['check', file], { cwd: dir, out: () => {} });
  assert.equal(codes(result).includes('REGISTRATION_OUTSIDE_SCOPE'), false);
});

test('scorePlanFile returns one quality score per planned contract', async () => {
  const dir = workdir();
  const file = writePlan(dir, plan(agent('a', { owned_files: ['src/x.ts'] })));
  const classify = async () => ({ answers: {}, usage: {} });
  const report = await scorePlanFile(file, classify as any, { cwd: dir });
  assert.deepEqual(report.scores.map((score) => score.id), ['a']);
});

// --- P5 multi-repo contracts and context constraints -----------------------

test('planContracts uses the repository checkout as the contract cwd', () => {
  const [{ contract }] = planContracts(
    plan(agent('a', { owned_files: ['triz:README.md'], metadata: { repo: 'triz' } })),
    { cwd: '/repo', repos: { triz: '/w/triz' } },
  );
  assert.equal(contract.cwd, '/w/triz');
});

test('planContracts strips the repository prefix from scope.owned', () => {
  const [{ contract }] = planContracts(
    plan(agent('a', { owned_files: ['triz:README.md'], metadata: { repo: 'triz' } })),
    { cwd: '/repo', repos: { triz: '/w/triz' } },
  );
  assert.deepEqual((contract.scope as any).owned, ['README.md']);
});

test('planContracts counts a prefixed registration file as owned', () => {
  const [{ contract }] = planContracts(
    plan(agent('a', { owned_files: ['triz:README.md'], metadata: { repo: 'triz' } })),
    { cwd: '/repo', repos: { triz: '/w/triz' } },
  );
  const registration = String(contract.constraints.find((c: string) => c.startsWith('Do not edit registration files')));
  assert.equal(registration.includes('README.md'), false);
});

test('planContracts strips the repository prefix from the modify constraint', () => {
  const [{ contract }] = planContracts(
    plan(agent('a', { owned_files: ['triz:README.md'], metadata: { repo: 'triz' } })),
    { cwd: '/repo', repos: { triz: '/w/triz' } },
  );
  assert.equal(contract.constraints[0], 'Only modify README.md');
});

test('planContracts copies the junior context array onto the contract', () => {
  const context = [{ path: 'a.ts', start: 1, end: 5 }];
  const [{ contract }] = planContracts(
    plan(agent('a', { owned_files: ['a.ts'], junior: { workflow: 'test_first', acceptance: ['ok'], checks: [{ command: 'true' }], context } })),
    { cwd: '/repo' },
  );
  assert.deepEqual(contract.context, context);
});

test('planContracts appends a junior constraint after the generated ones', () => {
  const [{ contract }] = planContracts(
    plan(agent('a', { owned_files: ['a.ts'], junior: { workflow: 'test_first', acceptance: ['ok'], checks: [{ command: 'true' }], constraints: ['No new dependencies'] } })),
    { cwd: '/repo' },
  );
  assert.equal(contract.constraints.at(-1), 'No new dependencies');
});

test('planContracts appends a repeated junior constraint only once', () => {
  const [{ contract }] = planContracts(
    plan(agent('a', { owned_files: ['a.ts'], junior: { workflow: 'test_first', acceptance: ['ok'], checks: [{ command: 'true' }], constraints: ['No new dependencies', 'No new dependencies'] } })),
    { cwd: '/repo' },
  );
  assert.deepEqual(contract.constraints.filter((c: string) => c === 'No new dependencies'), ['No new dependencies']);
});

test('planContracts keeps the base cwd when metadata.repo is absent', () => {
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: ['src/x.ts'] })), { cwd: '/repo' });
  assert.equal(contract.cwd, '/repo');
});

test('planContracts keeps the generated constraints when metadata.repo is absent', () => {
  const [{ contract }] = planContracts(plan(agent('a', { owned_files: ['src/x.ts'] })), { cwd: '/repo' });
  assert.deepEqual(contract.constraints, [
    'Only modify src/x.ts',
    'Work only inside the current working directory; no commits or pushes; no nested workers',
    'Do not edit registration files you do not own (package.json, package-lock.json, scripts/build.mjs, junior.ts, cli.test.ts, CHANGELOG.md, README.md); if your change needs registering there, say so in your final message instead',
  ]);
});

test('runPlanCommand reads repository checkouts from delivery.config.json', () => {
  const dir = workdir();
  const repo = join(dir, 'triz');
  writeFileSync(join(dir, 'delivery.config.json'), JSON.stringify({ plan: { repos: { triz: repo } } }));
  const file = writePlan(dir, plan(agent('a', { owned_files: ['triz:README.md'], metadata: { repo: 'triz' } })));
  const { result } = runPlanCommand(['contracts', file, '--out', 'contracts'], { cwd: dir, out: () => {} });
  const written = JSON.parse(readFileSync(result.written[0], 'utf8'));
  assert.equal(written.cwd, repo);
});

test('scorePlanFile resolves context against the configured repository checkout', async () => {
  const dir = workdir();
  const repo = join(dir, 'triz');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'a.ts'), 'repo-excerpt-marker');
  writeFileSync(join(dir, 'delivery.config.json'), JSON.stringify({ plan: { repos: { triz: repo } } }));
  const file = writePlan(dir, plan(agent('a', {
    owned_files: ['triz:a.ts'],
    metadata: { repo: 'triz' },
    junior: { workflow: 'test_first', acceptance: ['ok'], checks: [{ command: 'true' }], context: [{ path: 'a.ts' }] },
  })));
  let sent = '';
  const classify = async ({ state }: any) => {
    sent = JSON.stringify(state);
    return { answers: {} };
  };
  await scorePlanFile(file, classify, { cwd: dir });
  assert.equal(sent.includes('repo-excerpt-marker'), true);
});
