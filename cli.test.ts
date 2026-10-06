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
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = import.meta.dirname;
const JUNIOR = join(ROOT, 'junior.ts');
const TOOLS = join(ROOT, 'tools', 'tools.ts');
const NODE = process.execPath;

function runJunior(args: string[], cwd: string) {
  return spawnSync(NODE, [JUNIOR, ...args], { cwd, encoding: 'utf8' });
}

function runTools(args: string[], cwd: string) {
  return spawnSync(NODE, [TOOLS, ...args], { cwd, encoding: 'utf8' });
}

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-cli-'));
}

const SUBCOMMANDS = ['handoff', 'qa', 'run', 'validate', 'status', 'doctor', 'init'];

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
  assert.equal(runJunior(['init', '--no-skill'], workdir()).status, 0);
});

test('junior init accepts the documented --target option', () => {
  assert.equal(runJunior(['init', '--target=codex'], workdir()).status, 0);
});

// --- subcommand strict flag parsing ----------------------------------------

test('junior doctor rejects an unknown option', () => {
  assert.notEqual(runJunior(['doctor', '--bogus'], workdir()).status, 0);
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
