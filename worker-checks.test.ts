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
import { finish } from './worker-outcome.ts';
import { validate } from './worker-contract.ts';
import { COMMAND_PLACEMENT_ERROR, parseCommandPolicy } from './command-policy.ts';
import { stopReasonSummary } from './handoff.ts';
import { createManualClock, type ManualClock } from './clock.ts';
import { KILL_GRACE_MS } from './runtime-settings.ts';

/** A temporary artifact directory removed when the test finishes. */
const arena = (t: any): string => {
  const dir = mkdtempSync(join(tmpdir(), 'junior-checks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const noopHeartbeat = { update: () => {}, setState: () => {}, poll: () => {}, snapshot: () => ({}) };

/** A minimal RunState whose only job is to run the contract's checks. Its
 * heartbeat carries a manual clock that never advances, so the check timeout
 * cannot fire however slowly a loaded machine starts the child: the check
 * ends when the real process exits. Timeout tests pass their own clock. */
const checkState = (dir: string, checks: any[], overrides: Record<string, unknown> = {}) => ({
  t: { checks },
  mock: true,
  deps: {
    maxOutputBytes: 1024 * 1024,
    admit: async () => ({ ok: true, grant: { waitedMs: 0, pool: null, release() {} } }),
  },
  settings: { checkTimeoutMs: 150, toolTimeoutMs: 5000 },
  sourceCwd: dir,
  executionCwd: dir,
  dir,
  heartbeat: { ...noopHeartbeat, clock: createManualClock(Date.now()) },
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

/** Resolve once `pred` holds. It polls a real condition (a file, a pending
 * timer) and gives up after a generous bound; no assertion depends on how long
 * the wait took. */
const eventually = async (pred: () => boolean, what: string, tries = 3000) => {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** Run one hung check whose timeout and kill grace run on a manual clock that
 * the executor reads from the run heartbeat. Returns the settled state. */
const timedOutCheck = async (dir: string) => {
  const clock: ManualClock = createManualClock(Date.now());
  const state = checkState(dir, [{
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
  }], { settings: { checkTimeoutMs: 100, toolTimeoutMs: 5000 }, heartbeat: { ...noopHeartbeat, clock } });
  let done = false;
  const running = runChecks(state).then(() => { done = true; });
  // The executor's monitor is scheduled once the check child is spawned.
  await eventually(() => clock.pending() > 0, 'the check to start');
  await clock.advanceAsync(99);
  const earlyDone = done;
  await clock.advanceAsync(1);
  await clock.advanceAsync(KILL_GRACE_MS);
  await running;
  return { state, earlyDone };
};

test('a check killed by checkTimeoutMs reports timedOut true', async (t) => {
  const { state } = await timedOutCheck(arena(t));
  assert.equal(state.checks[0].timedOut, true);
});

test('a check is not timed out one millisecond before checkTimeoutMs', async (t) => {
  const { earlyDone } = await timedOutCheck(arena(t));
  assert.equal(earlyDone, false);
});

test('a timed-out check records the timeout it actually used', async (t) => {
  const { state } = await timedOutCheck(arena(t));
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

// --- default policy guards (#281) -------------------------------------------

/** A disposable executable with the given shell body, named for the tool the
 * guard classifies by basename. */
const fakeTool = (dir: string, name: string, body: string): string => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
};

const failedBuild = (dir: string): any => ({ command: fakeTool(dir, 'tsc', 'exit 1') });

const passingBuild = (dir: string): any => ({ command: fakeTool(dir, 'tsc', 'exit 0') });

const noBuildTest = (dir: string, marker: string): any => ({
  command: fakeTool(dir, 'dotnet', `printf ran > '${marker}'`),
  args: ['test', '--no-build'],
});

test('a no-build test after a failed build is refused with E_POLICY_GUARD', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'guarded-marker.txt');
  const state = checkState(dir, [failedBuild(dir), noBuildTest(dir, marker)]);
  await runChecks(state);
  assert.equal(state.checks[1].refused, 'E_POLICY_GUARD');
});

test('a refused no-build test after a failed build is not spawned', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'guarded-marker.txt');
  const state = checkState(dir, [failedBuild(dir), noBuildTest(dir, marker)]);
  await runChecks(state);
  assert.equal(existsSync(marker), false);
});

test('a refused no-build test records no_build_after_failed_build on the receipt', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'guarded-marker.txt');
  const state = checkState(dir, [failedBuild(dir), noBuildTest(dir, marker)]);
  await runChecks(state);
  assert.equal(state.policyEvents[0].kind, 'no_build_after_failed_build');
});

test('a refused no-build test records its check index on the event', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'guarded-marker.txt');
  const state = checkState(dir, [failedBuild(dir), noBuildTest(dir, marker)]);
  await runChecks(state);
  assert.equal(state.policyEvents[0].checkIndex, 1);
});

test('a no-build test without a build in the run records no_build_without_build', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'guarded-marker.txt');
  const state = checkState(dir, [noBuildTest(dir, marker)]);
  await runChecks(state);
  assert.equal(state.policyEvents[0].kind, 'no_build_without_build');
});

test('a successful build permits a no-build test in the same run', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'permitted-marker.txt');
  const state = checkState(dir, [passingBuild(dir), noBuildTest(dir, marker)]);
  await runChecks(state);
  assert.equal(existsSync(marker), true);
});

test('noBuild off permits a no-build test after a failed build', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'off-marker.txt');
  const checks = [failedBuild(dir), noBuildTest(dir, marker)];
  const state = checkState(dir, checks, {
    t: { checks, commandPolicy: { guards: { noBuild: 'off' } } },
  });
  await runChecks(state);
  assert.equal(existsSync(marker), true);
});

test('noBuild stale marks a no-build check as stale evidence', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'stale-marker.txt');
  const checks = [failedBuild(dir), noBuildTest(dir, marker)];
  const state = checkState(dir, checks, {
    t: { checks, commandPolicy: { guards: { noBuild: 'stale' } } },
  });
  await runChecks(state);
  assert.equal(state.checks[1].staleEvidence, true);
});

test('a stale no-build check still runs', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'stale-run-marker.txt');
  const checks = [failedBuild(dir), noBuildTest(dir, marker)];
  const state = checkState(dir, checks, {
    t: { checks, commandPolicy: { guards: { noBuild: 'stale' } } },
  });
  await runChecks(state);
  assert.equal(existsSync(marker), true);
});

test('a stale no-build check carries E_STALE_EVIDENCE', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'stale-error-marker.txt');
  const checks = [failedBuild(dir), noBuildTest(dir, marker)];
  const state = checkState(dir, checks, {
    t: { checks, commandPolicy: { guards: { noBuild: 'stale' } } },
  });
  await runChecks(state);
  assert.equal(state.checks[1].error, 'E_STALE_EVIDENCE');
});

test('a stale no-build decision is recorded as flagged_stale', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'stale-event-marker.txt');
  const checks = [failedBuild(dir), noBuildTest(dir, marker)];
  const state = checkState(dir, checks, {
    t: { checks, commandPolicy: { guards: { noBuild: 'stale' } } },
  });
  await runChecks(state);
  assert.equal(state.policyEvents[0].action, 'flagged_stale');
});

test('a check running git commit --no-verify is refused by default', async (t) => {
  const dir = arena(t);
  const check = { command: fakeTool(dir, 'git', 'exit 0'), args: ['commit', '--no-verify'] };
  const state = checkState(dir, [check]);
  await runChecks(state);
  assert.equal(state.checks[0].refused, 'E_POLICY_GUARD');
});

test('a refused hook-bypass check records a hook_bypass event', async (t) => {
  const dir = arena(t);
  const check = { command: fakeTool(dir, 'git', 'exit 0'), args: ['commit', '--no-verify'] };
  const state = checkState(dir, [check]);
  await runChecks(state);
  assert.equal(state.policyEvents[0].kind, 'hook_bypass');
});

test('a refused hook-bypass check records source check', async (t) => {
  const dir = arena(t);
  const check = { command: fakeTool(dir, 'git', 'exit 0'), args: ['commit', '--no-verify'] };
  const state = checkState(dir, [check]);
  await runChecks(state);
  assert.equal(state.policyEvents[0].source, 'check');
});

test('hookBypass off permits a git commit --no-verify check', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'hook-off-marker.txt');
  const check = {
    command: fakeTool(dir, 'git', `printf ran > '${marker}'`),
    args: ['commit', '--no-verify'],
  };
  const state = checkState(dir, [check], {
    t: { checks: [check], commandPolicy: { guards: { hookBypass: 'off' } } },
  });
  await runChecks(state);
  assert.equal(existsSync(marker), true);
});

// --- short flags, opaque and nested shells ----------------------------------

test('a check running bash -c with --no-verify is refused', async (t) => {
  const dir = arena(t);
  const check = {
    command: fakeTool(dir, 'bash', 'exit 0'),
    args: ['-c', 'git commit --no-verify'],
  };
  const state = checkState(dir, [check]);
  await runChecks(state);
  assert.equal(state.checks[0].refused, 'E_POLICY_GUARD');
});

test('a check running xargs git with --no-verify is refused', async (t) => {
  const dir = arena(t);
  const check = {
    command: fakeTool(dir, 'xargs', 'exit 0'),
    args: ['git', 'commit', '--no-verify'],
  };
  const state = checkState(dir, [check]);
  await runChecks(state);
  assert.equal(state.checks[0].refused, 'E_POLICY_GUARD');
});

test('a check running git commit -n is refused', async (t) => {
  const dir = arena(t);
  const check = { command: fakeTool(dir, 'git', 'exit 0'), args: ['commit', '-n'] };
  const state = checkState(dir, [check]);
  await runChecks(state);
  assert.equal(state.checks[0].refused, 'E_POLICY_GUARD');
});

test('a check with a plain quoted mention is not refused', async (t) => {
  const dir = arena(t);
  const check = { command: fakeTool(dir, 'echo', 'exit 0'), args: ['git commit --no-verify'] };
  const state = checkState(dir, [check]);
  await runChecks(state);
  assert.equal(state.checks[0].refused, undefined);
});

// --- machine admission around checks (#277, M2) -----------------------------

const admissionWait = (overrides: any = {}) => ({
  reason: 'pool', detail: 'pool dotnet 2/2 held by r-1, r-2', pool: 'dotnet', since: '2026-01-01T00:00:00.000Z', ...overrides,
});

const granted = (overrides: any = {}) => ({ waitedMs: 0, pool: null, release() {}, ...overrides });

const admissionFailure = (overrides: any = {}) => ({
  ok: false, error: 'E_ADMISSION_TIMEOUT', wait: admissionWait(), waitedMs: 250, ...overrides,
});

test('check admission receives the injected state directory and proc root', async (t) => {
  const dir = arena(t);
  let observed: any;
  const state = checkState(dir, [{ command: process.execPath, args: ['-e', ''] }], {
    deps: {
      maxOutputBytes: 1024 * 1024,
      admissionStateDir: join(dir, 'admission'),
      procRoot: join(dir, 'proc'),
      admit: async (req: any) => { observed = { stateDir: req.stateDir, procRoot: req.procRoot }; return { ok: true, grant: granted() }; },
    },
  });
  await runChecks(state);
  assert.deepEqual(observed, { stateDir: join(dir, 'admission'), procRoot: join(dir, 'proc') });
});

test('a check acquires admission before it starts', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'admitted-marker.txt');
  const check = {
    command: process.execPath,
    args: ['-e', `process.exit(require('node:fs').existsSync(${JSON.stringify(marker)}) ? 0 : 1)`],
  };
  const state = checkState(dir, [check], {
    deps: {
      maxOutputBytes: 1024 * 1024,
      admit: async () => { writeFileSync(marker, 'admitted'); return { ok: true, grant: granted() }; },
    },
  });
  await runChecks(state);
  assert.equal(state.checks[0].exitCode, 0);
});

test('a completed check releases its admission slot', async (t) => {
  const dir = arena(t);
  let released = false;
  const state = checkState(dir, [{ command: process.execPath, args: ['-e', ''] }], {
    deps: {
      maxOutputBytes: 1024 * 1024,
      admit: async () => ({ ok: true, grant: granted({ release: () => { released = true; } }) }),
    },
  });
  await runChecks(state);
  assert.equal(released, true);
});

test('a check admission timeout records E_ADMISSION_TIMEOUT', async (t) => {
  const dir = arena(t);
  const state = checkState(dir, [{ command: process.execPath, args: ['-e', ''] }], {
    deps: { maxOutputBytes: 1024 * 1024, admit: async () => admissionFailure() },
  });
  await runChecks(state);
  assert.equal(state.checks[0].refused, 'E_ADMISSION_TIMEOUT');
});

test('a check admission timeout does not spawn the check', async (t) => {
  const dir = arena(t);
  const marker = join(dir, 'unadmitted-marker.txt');
  const state = checkState(dir, [markerCheck(dir, marker)], {
    deps: { maxOutputBytes: 1024 * 1024, admit: async () => admissionFailure() },
  });
  await runChecks(state);
  assert.equal(existsSync(marker), false);
});

test('a check admission timeout is recorded with its check index', async (t) => {
  const dir = arena(t);
  const state = checkState(dir, [{ command: process.execPath, args: ['-e', ''] }], {
    deps: { maxOutputBytes: 1024 * 1024, admit: async () => admissionFailure() },
  });
  await runChecks(state);
  assert.deepEqual(state.admissionTimeout, { kind: 'check', waitedMs: 250, wait: admissionWait(), checkIndex: 0 });
});

test('a check admission timeout stops later checks', async (t) => {
  const dir = arena(t);
  const state = checkState(dir, [
    { command: process.execPath, args: ['-e', ''] },
    { command: process.execPath, args: ['-e', ''] },
  ], {
    deps: { maxOutputBytes: 1024 * 1024, admit: async () => admissionFailure() },
  });
  await runChecks(state);
  assert.equal(state.checks.length, 1);
});

test('an interrupted check admission records E_ADMISSION_INTERRUPTED', async (t) => {
  const dir = arena(t);
  const state = checkState(dir, [{ command: process.execPath, args: ['-e', ''] }], {
    deps: { maxOutputBytes: 1024 * 1024, admit: async () => admissionFailure({ error: 'E_ADMISSION_INTERRUPTED' }) },
  });
  await runChecks(state);
  assert.equal(state.checks[0].refused, 'E_ADMISSION_INTERRUPTED');
});

test('an interrupted check admission marks the check phase interrupted', async (t) => {
  const dir = arena(t);
  const state = checkState(dir, [{ command: process.execPath, args: ['-e', ''] }], {
    deps: { maxOutputBytes: 1024 * 1024, admit: async () => admissionFailure({ error: 'E_ADMISSION_INTERRUPTED' }) },
  });
  await runChecks(state);
  assert.equal(state.interruptedDuringChecks, true);
});

test('a check admission timeout ends the run admission_timeout', async (t) => {
  const dir = arena(t);
  const state = checkState(dir, [{ command: process.execPath, args: ['-e', ''] }], {
    deps: { maxOutputBytes: 1024 * 1024, admit: async () => admissionFailure() },
  });
  state.before = { changedFiles: [] };
  state.receipt = { outputLimited: false, malformed: false, errored: false, aborted: false, assistantMessages: 1, usage: { cost: null, available: false }, observed: [] };
  await runChecks(state);
  const result = await finish(state);
  assert.equal(result.status, 'admission_timeout');
});

test('a waiting check reports the admission phase and wait reason in its heartbeat', async (t) => {
  const dir = arena(t);
  const updates: any[] = [];
  const state = checkState(dir, [{ command: process.execPath, args: ['-e', ''] }], {
    heartbeat: {
      clock: createManualClock(Date.now()),
      update: (patch: any) => updates.push({ ...patch }),
      poll: () => {},
    },
    deps: {
      maxOutputBytes: 1024 * 1024,
      admit: async (req: any) => { req.onWait(admissionWait()); return { ok: true, grant: granted({ waitedMs: 5 }) }; },
    },
  });
  await runChecks(state);
  assert.equal(updates.some((patch) => patch.phase === 'admission' && patch.admission?.reason === 'pool'), true);
});

test('a check admission wait is bounded by the remaining run deadline', async (t) => {
  const dir = arena(t);
  const clock = createManualClock(Date.now());
  let observedTimeout: number | undefined;
  const state = checkState(dir, [{ command: process.execPath, args: ['-e', ''] }], {
    deadlineAt: clock.now() + 5000,
    heartbeat: { ...noopHeartbeat, clock },
    deps: {
      maxOutputBytes: 1024 * 1024,
      admit: async (req: any) => { observedTimeout = req.config.admissionTimeoutMs; return { ok: true, grant: granted() }; },
    },
  });
  await runChecks(state);
  assert.equal(observedTimeout, 5000);
});

test('a waiting check is recorded on the run admission waits', async (t) => {
  const dir = arena(t);
  const state = checkState(dir, [{ command: process.execPath, args: ['-e', ''] }], {
    deps: {
      maxOutputBytes: 1024 * 1024,
      admit: async (req: any) => { req.onWait(admissionWait()); return { ok: true, grant: granted({ waitedMs: 7 }) }; },
    },
  });
  await runChecks(state);
  assert.deepEqual(state.admissionWaits, [{ ...admissionWait(), waitedMs: 7 }]);
});
