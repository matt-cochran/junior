// ---------------------------------------------------------------------------
// Focused public CLI behavioral tests for issue #2 (side-effect-free help and
// strict flag parsing).
//
// Every scenario drives the real public entry points (`junior.ts` and the
// nested `tools/tools.ts`) in an isolated temp cwd. Each test asserts exactly
// one observable outcome and never inspects private implementation details.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHop } from './tools/tools.ts';

const ROOT = import.meta.dirname;
const JUNIOR = join(ROOT, 'junior.ts');
const TOOLS = join(ROOT, 'tools', 'tools.ts');
const FAKE = join(ROOT, 'tools', 'test-fixtures', 'fake-mcp.mjs');
const NODE = process.execPath;

function runJunior(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(NODE, [JUNIOR, ...args], { cwd, encoding: 'utf8', env: { ...process.env, JUNIOR_NO_INSTALL: '1', JUNIOR_NO_UPDATE_CHECK: '1', ...env } });
}

function runTools(args: string[], cwd: string) {
  return spawnSync(NODE, [TOOLS, ...args], { cwd, encoding: 'utf8', env: { ...process.env, JUNIOR_NO_INSTALL: '1' } });
}

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-cli-'));
}

const SUBCOMMANDS = ['handoff', 'qa', 'run', 'apply', 'validate', 'status', 'doctor', 'setup', 'init', 'update', 'prune'];

// --- top-level help ---------------------------------------------------------

test('junior -h exits successfully', () => {
  assert.equal(runJunior(['-h'], workdir()).status, 0);
});

test('junior help exits successfully', () => {
  assert.equal(runJunior(['help'], workdir()).status, 0);
});

// --- per-subcommand help ----------------------------------------------------

for (const command of SUBCOMMANDS) {
  test(`junior ${command} --help exits successfully`, () => {
    assert.equal(runJunior([command, '--help'], workdir()).status, 0);
  });

  test(`junior ${command} --help prints ${command} usage`, () => {
    assert.match(runJunior([command, '--help'], workdir()).stdout, new RegExp(`^Usage: junior ${command}\\b`, 'm'));
  });
}

test('junior init -h prints init usage', () => {
  assert.match(runJunior(['init', '-h'], workdir()).stdout, /^Usage: junior init\b/m);
});

// --- help never causes side effects -----------------------------------------

test('junior init --help writes nothing to the working directory', () => {
  const dir = workdir();
  runJunior(['init', '--help'], dir);
  assert.deepEqual(readdirSync(dir), []);
});

test('junior init -h writes nothing to the working directory', () => {
  const dir = workdir();
  runJunior(['init', '-h'], dir);
  assert.deepEqual(readdirSync(dir), []);
});

test('junior init --install --help writes nothing to the working directory', () => {
  const dir = workdir();
  runJunior(['init', '--install', '--help'], dir);
  assert.deepEqual(readdirSync(dir), []);
});

test('junior tools init --help writes no hop file', () => {
  const dir = workdir();
  runJunior(['tools', 'init', '--help'], dir);
  assert.ok(!existsSync(join(dir, 'hop.json')));
});

// --- nested tools help ------------------------------------------------------

test('junior tools --help prints tools usage', () => {
  assert.match(runJunior(['tools', '--help'], workdir()).stdout, /^Usage: junior tools\b/m);
});

test('junior tools init --help prints tools init usage', () => {
  assert.match(runJunior(['tools', 'init', '--help'], workdir()).stdout, /^Usage: junior tools init\b/m);
});

test('junior tools call --help prints tools call usage', () => {
  assert.match(runJunior(['tools', 'call', '--help'], workdir()).stdout, /^Usage: junior tools call\b/m);
});

test('junior tools inspect --help prints tools inspect usage', () => {
  assert.match(runJunior(['tools', 'inspect', '--help'], workdir()).stdout, /^Usage: junior tools inspect\b/m);
});

test('tools inspect --help exits successfully', () => {
  assert.equal(runTools(['inspect', '--help'], workdir()).status, 0);
});

// --- init strict flag parsing ----------------------------------------------

test('junior init rejects an unknown long option', () => {
  assert.notEqual(runJunior(['init', '--bogus'], workdir()).status, 0);
});

test('junior init rejects an unknown short option', () => {
  assert.notEqual(runJunior(['init', '-x'], workdir()).status, 0);
});

test('junior init rejects an unknown option before writing files', () => {
  const dir = workdir();
  runJunior(['init', '--bogus'], dir);
  assert.deepEqual(readdirSync(dir), []);
});

test('junior init rejects a missing value for --target', () => {
  assert.notEqual(runJunior(['init', '--target'], workdir()).status, 0);
});

test('junior init rejects a missing value for --skill-root', () => {
  assert.notEqual(runJunior(['init', '--skill-root'], workdir()).status, 0);
});

test('junior init rejects an unsupported --target value', () => {
  assert.notEqual(runJunior(['init', '--target=not-a-manager'], workdir()).status, 0);
});

test('junior init rejects an unsupported --scope value', () => {
  assert.notEqual(runJunior(['init', '--scope=elsewhere'], workdir()).status, 0);
});

test('junior init rejects excess positional arguments', () => {
  assert.notEqual(runJunior(['init', 'extra'], workdir()).status, 0);
});

test('junior init accepts the documented --no-skill option', () => {
  assert.equal(runJunior(['init', '--no-skill', '--no-install', '--no-companions'], workdir()).status, 0);
});

test('junior init accepts the documented --target option', () => {
  assert.equal(runJunior(['init', '--target=codex', '--no-install', '--no-companions'], workdir()).status, 0);
});

// --- subcommand strict flag parsing ----------------------------------------

test('junior init --no-install reports an unattempted install summary', () => {
  const out = JSON.parse(runJunior(['init', '--no-install', '--no-companions'], workdir()).stdout);
  assert.equal(out.installSummary.attempted, false);
});

test('junior doctor rejects an unknown option', () => {
  assert.notEqual(runJunior(['doctor', '--bogus'], workdir()).status, 0);
});

test('junior setup --dry-run executes no managed-tool install', () => {
  const dir = workdir();
  const res = runJunior(['setup', '--harness', 'codex', '--dry-run'], dir);
  assert.equal(res.status, 0);
});

test('junior setup --dry-run writes nothing to the working directory', () => {
  const dir = workdir();
  runJunior(['setup', '--harness', 'codex', '--dry-run'], dir);
  assert.deepEqual(readdirSync(dir), []);
});

test('junior prune rejects an unknown option', () => {
  assert.notEqual(runJunior(['prune', '--bogus'], workdir()).status, 0);
});

test('junior prune rejects an invalid --older-than value', () => {
  assert.notEqual(runJunior(['prune', '--older-than=soon'], workdir()).status, 0);
});

test('junior prune rejects a missing --older-than value', () => {
  assert.notEqual(runJunior(['prune', '--older-than'], workdir()).status, 0);
});

test('junior prune --dry-run exits successfully outside a Git checkout', () => {
  assert.equal(runJunior(['prune', '--dry-run'], workdir()).status, 0);
});

test('junior doctor rejects excess positional arguments', () => {
  assert.notEqual(runJunior(['doctor', 'extra'], workdir()).status, 0);
});

test('junior status rejects an unknown option', () => {
  assert.notEqual(runJunior(['status', '--bogus', 'result.json'], workdir()).status, 0);
});

test('junior status rejects an unknown short option', () => {
  assert.notEqual(runJunior(['status', '-x', 'result.json'], workdir()).status, 0);
});

test('junior status rejects excess positional arguments', () => {
  assert.notEqual(runJunior(['status', 'a.json', 'b.json'], workdir()).status, 0);
});

test('junior handoff rejects an unknown option', () => {
  assert.notEqual(runJunior(['handoff', '--bogus', 'task.json'], workdir()).status, 0);
});

test('junior validate rejects excess positional arguments', () => {
  assert.notEqual(runJunior(['validate', 'a.json', 'b.json'], workdir()).status, 0);
});

// --- prepare --choose/--correct flag handling -------------------------------

function chooseTask(dir: string, id: string): string {
  const taskPath = join(dir, `${id}.json`);
  writeFileSync(taskPath, JSON.stringify({
    id,
    deliverable: 'Choose an option',
    cwd: dir,
    isolation: 'none',
    acceptance: ['ok'],
    checks: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
  }));
  return taskPath;
}

function writeBrief(dir: string, id: string): void {
  const briefDir = join(dir, '.delivery', id, '123');
  mkdirSync(briefDir, { recursive: true });
  writeFileSync(join(briefDir, 'brief.json'), JSON.stringify({
    understanding: { scope: [{ id: 'U1', text: 'Do it' }], outOfScope: [], assumptions: [{ id: 'A2', text: 'guess', status: 'guess' }], acceptanceProof: [] },
    options: [{ id: 'B', title: 'B', approach: 'Option B approach', files: [], effort: { optimistic: 1, likely: 1, pessimistic: 1 }, risks: [], tradeoffs: 'none' }],
    recommendation: { option: 'B', why: 'best' },
  }));
}

test('junior handoff --choose records the choice in the prepare history', () => {
  const dir = workdir();
  const id = 'choose-cli';
  const taskPath = chooseTask(dir, id);
  writeBrief(dir, id);
  runJunior(['handoff', taskPath, '--choose', 'B', '--correct', 'A2=x', '--mock', '--quiet'], dir);
  assert.ok(existsSync(join(dir, '.delivery', 'prepare-history.jsonl')));
});

test('junior run rejects --choose', () => {
  assert.notEqual(runJunior(['run', chooseTask(workdir(), 'run-cli'), '--choose', 'B'], workdir()).status, 0);
});

// --- clarify --answers flag handling ----------------------------------------

test('junior handoff --answers continues the clarification loop', () => {
  const dir = workdir();
  const id = 'clar-cli';
  const hop = join(dir, 'hop.json');
  initHop(hop, {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: {
      elicitation: { command: NODE, args: [FAKE], env: { FAKE_MCP_MODE: 'echo' }, sourceVersion: '1.0.0', sourceSha: '0'.repeat(64) },
    },
  });
  const taskPath = join(dir, 'task.json');
  writeFileSync(taskPath, JSON.stringify({
    id,
    deliverable: 'Clarify the widget',
    cwd: dir,
    isolation: 'none',
    acceptance: ['ok'],
    checks: [{ command: NODE, args: ['-e', 'process.exit(0)'] }],
    hopFrom: hop,
  }));
  const artifactDir = join(dir, '.delivery', id, '1');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, 'clarify.json'), JSON.stringify({
    outcome: 'needs_answers',
    sessionId: `clarify:${id}`,
    round: 1,
    questions: [{ id: 'Q1', question: 'Q?', why: 'signal', suggestedAnswer: null, claimIds: [] }],
    blockers: [],
    playbooks: [],
    artifactDir,
  }));
  writeFileSync(join(dir, 'answers.json'), JSON.stringify({ Q1: { answer: 'yes', stance: 'assent' } }));
  const res = runJunior(['handoff', taskPath, '--answers', join(dir, 'answers.json')], dir);
  assert.equal(JSON.parse(res.stdout).outcome, 'needs_answers');
});

// --- nested tools strict flag parsing --------------------------------------

test('tools inspect rejects an unknown option', () => {
  assert.notEqual(runTools(['inspect', '--bogus'], workdir()).status, 0);
});

test('tools init rejects excess positional arguments', () => {
  assert.notEqual(runTools(['init', 'a.json', 'b.json', 'c.json'], workdir()).status, 0);
});

test('tools call rejects missing arguments', () => {
  assert.notEqual(runTools(['call', 'hop.json'], workdir()).status, 0);
});

test('junior init rejects another option as a missing skill-root value without writes', () => {
  const dir = workdir();
  runJunior(['init', '--skill-root', '--force'], dir);
  assert.deepEqual(readdirSync(dir), []);
});

// --- B07 progress on stderr, --quiet, live status and help size ---------------

function mockTask(dir: string): string {
  const taskPath = join(dir, 'task.json');
  writeFileSync(taskPath, JSON.stringify({
    id: 'cli-mock',
    deliverable: 'Mock handoff',
    cwd: dir,
    isolation: 'none',
    acceptance: ['mock'],
    checks: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
  }));
  return taskPath;
}

test('junior --help prints at most 12 lines', () => {
  assert.ok(runJunior(['--help'], workdir()).stdout.trimEnd().split('\n').length <= 12);
});

test('junior handoff --mock prints a JSON receipt on stdout', () => {
  const dir = workdir();
  const res = runJunior(['handoff', mockTask(dir), '--mock'], dir);
  assert.doesNotThrow(() => JSON.parse(res.stdout));
});

test('junior handoff --mock prefixes progress lines with junior: on stderr', () => {
  const dir = workdir();
  assert.match(runJunior(['handoff', mockTask(dir), '--mock'], dir).stderr, /^junior: /m);
});

test('junior handoff --mock --quiet writes nothing to stderr', () => {
  const dir = workdir();
  assert.equal(runJunior(['handoff', mockTask(dir), '--mock', '--quiet'], dir).stderr, '');
});

test('junior status --live prints the phase from runtime.json', () => {
  const dir = workdir();
  writeFileSync(join(dir, 'runtime.json'), JSON.stringify({ phase: 'worker', state: 'running', elapsedMs: 12, remainingMs: 34, currentTool: 'bash' }));
  assert.equal(JSON.parse(runJunior(['status', dir, '--live'], dir).stdout).phase, 'worker');
});

// --- doctor companion-skill readiness (issue #39) ---------------------------

test('junior doctor reports companionSkills as a separate report', () => {
  const out = JSON.parse(runJunior(['doctor'], workdir()).stdout);
  assert.ok(Array.isArray(out.companionSkills.skills));
});

test('junior doctor writes nothing to the working directory', () => {
  const dir = workdir();
  runJunior(['doctor'], dir);
  assert.deepEqual(readdirSync(dir), []);
});

// --- startup update notice (R3) ---------------------------------------------

function freshCacheHome(outdated: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'junior-home-'));
  const dir = join(home, '.junior');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'update-check.json'), JSON.stringify({ checkedAt: Date.now(), outdated, remediation: '' }));
  return home;
}

function noticeEnv(home: string, noUpdateCheck: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    JUNIOR_HOME: '',
    JUNIOR_TOOLS_ROOT: join(home, '.junior', 'tools'),
    JUNIOR_NO_UPDATE_CHECK: noUpdateCheck,
  };
}

test('junior validate prints the update notice on stderr', () => {
  const home = freshCacheHome(['crossmatrix', '@jevitate/cli']);
  const res = runJunior(['validate', 'missing.json'], workdir(), noticeEnv(home, ''));
  assert.match(res.stderr, /junior: 2 updates available \(crossmatrix, @jevitate\/cli\); run `junior update`/);
});

test('junior handoff never prints the update notice', () => {
  const dir = workdir();
  const home = freshCacheHome(['junior']);
  const res = runJunior(['handoff', mockTask(dir), '--mock'], dir, noticeEnv(home, ''));
  assert.doesNotMatch(res.stderr, /updates available/);
});

test('junior validate prints no update notice when JUNIOR_NO_UPDATE_CHECK=1', () => {
  const home = freshCacheHome(['junior']);
  const res = runJunior(['validate', 'missing.json'], workdir(), noticeEnv(home, '1'));
  assert.doesNotMatch(res.stderr, /updates available/);
});

// --- apply command (W1-cli-wiring) ------------------------------------------

function gitRepo(): string {
  const dir = workdir();
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

test('junior apply -h prints apply usage', () => {
  assert.match(runJunior(['apply', '-h'], workdir()).stdout, /^Usage: junior apply\b/m);
});

test('junior apply missing-id exits 1 in a temp git repo', () => {
  assert.equal(runJunior(['apply', 'missing-id'], gitRepo()).status, 1);
});

test('junior apply missing-id reports the missing target', () => {
  const out = JSON.parse(runJunior(['apply', 'missing-id'], gitRepo()).stdout);
  assert.match(out.error, /missing-id/);
});

// --- plan-aware handoff (W1-cli-wiring) --------------------------------------

test('junior handoff refuses a plan whose cpm lease cannot be acquired', () => {
  const dir = workdir();
  const hop = join(dir, 'hop.json');
  initHop(hop, {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: { cpm: { command: join(dir, 'missing-cpm'), sourceVersion: '1.0.0', sourceSha: '0'.repeat(64) } },
  });
  const taskPath = join(dir, 'task.json');
  writeFileSync(taskPath, JSON.stringify({
    id: 'plan-cli',
    deliverable: 'Plan lease CLI',
    cwd: dir,
    isolation: 'none',
    acceptance: ['ok'],
    checks: [{ command: NODE, args: ['-e', 'process.exit(0)'] }],
    hopFrom: hop,
    plan: { id: 'plan_x', deliverable: 'P1b-plan-lease' },
  }));
  const res = runJunior(['handoff', taskPath, '--mock', '--quiet'], dir);
  assert.equal(JSON.parse(res.stdout).status, 'plan_lease_refused');
});
