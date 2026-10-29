// ---------------------------------------------------------------------------
// Behavioral tests for contract checks: timeout reporting and command placement.
//
// Every scenario drives the public runChecks seam with a disposable artifact
// directory. Refused checks use a real script that would leave a marker, so the
// absence of that marker proves the spawn was refused rather than merely
// reported. Each test asserts exactly one observable outcome.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecks } from './worker-checks.ts';
import { validate } from './worker-contract.ts';
import { COMMAND_PLACEMENT_ERROR, parseCommandPolicy } from './command-policy.ts';
import { stopReasonSummary } from './handoff.ts';

/** A temporary artifact directory removed when the test finishes. */
const arena = (t: any): string => {
  const dir = mkdtempSync(join(tmpdir(), 'junior-checks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const noopHeartbeat = { update: () => {}, poll: () => {} };

/** A minimal RunState whose only job is to run the contract's checks. */
const checkState = (dir: string, checks: any[], overrides: Record<string, unknown> = {}) => ({
  t: { checks },
  mock: true,
  deps: { maxOutputBytes: 1024 * 1024 },
  settings: { checkTimeoutMs: 150, toolTimeoutMs: 5000 },
  sourceCwd: dir,
  executionCwd: dir,
  dir,
  heartbeat: noopHeartbeat,
  emit: () => {},
  signal: undefined,
  deadlineAt: Date.now() + 60_000,
  streamResult: undefined,
  workerStatus: 0,
  receiptOk: true,
  ...overrides,
}) as any;

/** A check that writes its marker file, proving it was actually spawned. */
const markerCheck = (dir: string, marker: string) => {
  writeFileSync(
    join(dir, 'marker.js'),
    "require('node:fs').writeFileSync(process.argv[2], 'ran')\n",
  );
  return { command: process.execPath, args: ['marker.js', marker] };
};

const remoteRule = (dir: string) => parseCommandPolicy({
  enforce: true,
  rules: [{
    match: [process.execPath, 'marker.js'],
    placement: 'remote',
    wrapper: '/nonexistent/remote-wrapper.sh',
  }],
}, dir)!;

// --- check timeout reporting -------------------------------------------------

test('a check killed by checkTimeoutMs reports timedOut true', async (t) => {
  const dir = arena(t);
  const state = checkState(dir, [{
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
  }], { settings: { checkTimeoutMs: 100, toolTimeoutMs: 5000 } });
  await runChecks(state);
  assert.equal(state.checks[0].timedOut, true);
});

test('a timed-out check records the timeout it actually used', async (t) => {
  const dir = arena(t);
  const state = checkState(dir, [{
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
  }], { settings: { checkTimeoutMs: 100, toolTimeoutMs: 5000 } });
  await runChecks(state);
  assert.equal(state.checks[0].timeoutMs, 100);
});

test('a timed-out check produces the check_timeout stop reason with its timeout', (t) => {
  const dir = arena(t);
  const lines = stopReasonSummary({ checks: [{ timedOut: true, timeoutMs: 100 }], sourceCwd: dir });
  assert.ok(lines.includes('check_timeout: check 1 killed after 100 ms (raise execution.checkTimeoutMs)'));
});

// --- refused checks ----------------------------------------------------------

test('a check violating a remote-only rule records a placement refusal', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'refused-marker.txt');
  const check = markerCheck(dir, marker);
  const state = checkState(dir, [check], { t: { checks: [check], commandPolicy: remoteRule(dir) } });
  await runChecks(state);
  assert.equal(state.checks[0].refused, COMMAND_PLACEMENT_ERROR);
});

test('a check violating a remote-only rule is not spawned', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'not-spawned-marker.txt');
  const check = markerCheck(dir, marker);
  const state = checkState(dir, [check], { t: { checks: [check], commandPolicy: remoteRule(dir) } });
  await runChecks(state);
  assert.equal(existsSync(marker), false);
});

test('a refused check records the remote placement', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'placement-marker.txt');
  const check = markerCheck(dir, marker);
  const state = checkState(dir, [check], { t: { checks: [check], commandPolicy: remoteRule(dir) } });
  await runChecks(state);
  assert.equal(state.checks[0].placement, 'remote');
});

test('a refused check error names the configured wrapper', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'wrapper-marker.txt');
  const check = markerCheck(dir, marker);
  const state = checkState(dir, [check], { t: { checks: [check], commandPolicy: remoteRule(dir) } });
  await runChecks(state);
  assert.match(state.checks[0].error, /remote-wrapper\.sh/);
});

// --- policy-free behavior ----------------------------------------------------

test('a contract without commandPolicy still spawns its checks', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'policy-free-marker.txt');
  const state = checkState(dir, [markerCheck(dir, marker)]);
  await runChecks(state);
  assert.equal(existsSync(marker), true);
});

test('a contract without commandPolicy records an unknown placement', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'unknown-placement-marker.txt');
  const state = checkState(dir, [markerCheck(dir, marker)]);
  await runChecks(state);
  assert.equal(state.checks[0].placement, 'unknown');
});

// --- contract validation -----------------------------------------------------

test('an invalid commandPolicy fails contract validation', (t) => {
  const dir = arena(t);
  const contract = {
    id: 'W4',
    deliverable: 'deliverable',
    cwd: dir,
    acceptance: ['accepted'],
    checks: [{ command: process.execPath, args: ['--version'] }],
    commandPolicy: { enforce: 'yes', rules: [{ match: ['git'], placement: 'local' }] },
  };
  assert.throws(() => validate(contract), /commandPolicy\.enforce/);
});
