// ---------------------------------------------------------------------------
// Behavioral tests for the worker launch phase: run-local Pi credentials,
// bounded work, typed failures and key resolution.
//
// Each test drives the public launch/resolver interface once and asserts one
// observable outcome. Fixture credentials are fake and never logged.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { launch } from './worker-launch.ts';
import { finish } from './worker-outcome.ts';
import { createRunState, outOfTime, remainingMs } from './worker-preflight.ts';
import { createManualClock, systemClock } from './clock.ts';
import { resolveOpenRouterKey } from './worker-gates.ts';

const COMMODITY_MODEL = 'deepseek/deepseek-v4.1-flash';

const fakeChild = () => {
  const ee = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exited = false;
  const state = { killed: false };
  const finish = (code: number | null, signal: string | null) => {
    if (exited) return;
    exited = true;
    stdout.end();
    stderr.end();
    ee.emit('exit', code, signal);
    ee.emit('close', code, signal);
  };
  const child: any = {
    pid: 0,
    stdout,
    stderr,
    on: (event: string, cb: any) => { ee.on(event, cb); return child; },
    kill: (signal?: string) => { state.killed = true; finish(null, signal || 'SIGTERM'); return true; },
  };
  const emit = (event: any) => stdout.write(JSON.stringify(event) + '\n');
  const end = (code = 0) => finish(code, null);
  return { child, emit, end, state, stderr };
};

const completeStream = (fake: ReturnType<typeof fakeChild>) => {
  fake.emit({ type: 'message_end', message: { role: 'assistant', provider: 'openrouter', model: 'm', usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } }, stopReason: 'stop' } });
  fake.emit({ type: 'agent_settled' });
  fake.end(0);
};

/** Let the launch phase reach its child spawn after the admission await. */
const spawned = () => new Promise<void>((resolve) => setImmediate(resolve));

const launchState = (extra: any = {}) => {
  const cwd = extra.cwd ?? mkdtempSync(join(tmpdir(), 'worker-launch-'));
  const task = {
    id: extra.id ?? 'launch',
    deliverable: 'launch behavior',
    cwd,
    acceptance: ['launch behaves'],
    checks: [],
    ...(extra.task ?? {}),
  };
  const state = createRunState(task, false, {
    admit: async () => ({ ok: true, grant: { waitedMs: 0, pool: null, release() {} } }),
    ...(extra.deps ?? {}),
  });
  state.prompt = 'launch fixture prompt';
  state.decision = { selected: extra.workflow ?? 'test_first' };
  state.isolationArgs = [];
  state.requested = { provider: 'openrouter', model: COMMODITY_MODEL };
  return state;
};

test('launch exposes copied Pi credentials as regular files rather than symlinks', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'worker-launch-'));
  const agent = join(cwd, 'source-agent');
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, 'auth.json'), JSON.stringify({ openrouter: { type: 'api_key', key: 'sk-or-fixture' } }));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  let observed: any;
  const state = launchState({
    cwd,
    deps: {
      env: { ...process.env, PI_CODING_AGENT_DIR: agent },
      spawnPi: (_command: string, _args: string[], options: any) => {
        const auth = join(options.env.PI_CODING_AGENT_DIR, 'auth.json');
        observed = { exists: existsSync(auth), symlink: lstatSync(auth).isSymbolicLink() };
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  });
  await launch(state);
  assert.deepEqual(observed, { exists: true, symlink: false });
});

test('launch removes copied Pi credentials after the Pi process ends', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'worker-launch-'));
  const agent = join(cwd, 'source-agent');
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, 'auth.json'), JSON.stringify({ openrouter: { type: 'api_key', key: 'sk-or-fixture' } }));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  let overlay = '';
  const state = launchState({
    cwd,
    deps: {
      env: { ...process.env, PI_CODING_AGENT_DIR: agent },
      spawnPi: (_command: string, _args: string[], options: any) => {
        overlay = options.env.PI_CODING_AGENT_DIR;
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  });
  await launch(state);
  assert.equal(existsSync(join(overlay, 'auth.json')), false);
});

test('a contract budget stops a streamed run with budget_exceeded', async (t) => {
  const fake = fakeChild();
  const state = launchState({
    task: { budget: { maxToolCalls: 1, mode: 'enforce' }, execution: { continuations: 0 } },
    deps: { spawnChild: () => fake.child },
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  const running = launch(state);
  await spawned();
  fake.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'true' } });
  fake.emit({ type: 'tool_execution_start', toolCallId: 'c2', toolName: 'bash', args: { command: 'true' } });
  fake.end(0);
  await running;
  assert.equal(state.streamResult.stopReason, 'budget_exceeded');
});

test('an evaluate run without a contract budget passes the report defaults to the stream', async (t) => {
  const fake = fakeChild();
  const state = launchState({ workflow: 'evaluate', deps: { spawnChild: () => fake.child } });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  const running = launch(state);
  await spawned();
  completeStream(fake);
  await running;
  assert.deepEqual(state.streamResult.budget.requested, { maxToolCalls: 25, maxTotalTokens: 400000, mode: 'enforce' });
});

const failedFetchChild = () => {
  const fake = fakeChild();
  fake.stderr.write('fetch failed\n');
  setImmediate(() => fake.end(1));
  return fake.child;
};

/** A manual clock (started at real time, so wall deadlines stay sane) whose
 * sleeps are observable: `slept` resolves with the delay of the first sleep. */
const retryClock = () => {
  const clock = createManualClock(Date.now());
  const sleeps: number[] = [];
  let sawSleep!: (ms: number) => void;
  const slept = new Promise<number>((resolve) => { sawSleep = resolve; });
  const sleep = clock.sleep;
  clock.sleep = (ms: number, signal?: AbortSignal) => { sleeps.push(ms); sawSleep(ms); return sleep(ms, signal); };
  return { clock, sleeps, slept };
};

test('a retryable fetch failure without assistant messages retries the segment exactly once', async (t) => {
  let spawns = 0;
  const { clock, sleeps, slept } = retryClock();
  const state = launchState({
    deps: {
      clock,
      spawnChild: () => {
        spawns += 1;
        return failedFetchChild();
      },
    },
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  const running = launch(state);
  assert.equal(await slept, 2000);
  assert.equal(spawns, 1);
  // The retry waits on the run clock: nothing respawns until 2000 ms pass.
  await clock.advanceAsync(1999);
  assert.equal(spawns, 1);
  await clock.advanceAsync(1);
  await running;
  assert.equal(spawns, 2);
  assert.deepEqual(sleeps, [2000]);
});

test('a retried Pi failure is recorded with retried true', async (t) => {
  const { clock, slept } = retryClock();
  const state = launchState({ deps: { clock, spawnChild: failedFetchChild } });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  const running = launch(state);
  await clock.advanceAsync(await slept);
  await running;
  assert.equal(state.workerFailure.retried, true);
});

test('createRunState defaults the run clock to the system clock', (t) => {
  const state = launchState();
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  assert.equal(state.clock, systemClock);
});

test('createRunState starts the wall deadline from the injected clock', (t) => {
  const start = Date.parse('2026-01-02T03:04:05.000Z');
  const clock = createManualClock(start);
  const state = launchState({ deps: { clock }, task: { execution: { deadlineMs: 120000 } } });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  assert.equal(state.clock, clock);
  assert.equal(state.runStartedAt, start);
  assert.equal(state.deadlineAt, start + 120000);
  assert.equal(state.dir.endsWith(String(start)), true);
});

test('remainingMs and outOfTime follow the run clock to the deadline', (t) => {
  const clock = createManualClock(1_000_000);
  const state = launchState({ deps: { clock }, task: { execution: { deadlineMs: 500 } } });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  clock.advance(499);
  assert.equal(remainingMs(state), 1);
  assert.equal(outOfTime(state), false);
  clock.advance(1);
  assert.equal(remainingMs(state), 0);
  assert.equal(outOfTime(state), true);
});

test('a launch whose worker deadline passed on the run clock never spawns Pi', async (t) => {
  let spawns = 0;
  const clock = createManualClock(Date.now());
  const state = launchState({ deps: { clock, spawnChild: () => { spawns += 1; return failedFetchChild(); } } });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  clock.set(state.deadlineAt);
  await launch(state);
  assert.equal(spawns, 0);
  assert.equal(state.streamResult.stopReason, 'deadline_exceeded');
});

test('Jev key resolution returns the direct auth-file key before consulting AuthStorage', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'worker-launch-key-'));
  const agent = join(root, 'agent');
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, 'auth.json'), JSON.stringify({ openrouter: { type: 'api_key', key: 'sk-or-direct-file' } }));
  const sdkPath = join(root, 'fake-sdk.mjs');
  writeFileSync(sdkPath, 'export function readStoredCredential(){ return { type:"api_key", key:"sk-or-sdk-wrong" }; }\n');
  const previousEnv = { ...process.env };
  t.after(() => {
    process.env = previousEnv;
    chmodSync(agent, 0o700);
    rmSync(root, { recursive: true, force: true });
  });
  process.env = { ...previousEnv, PI_CODING_AGENT_DIR: agent, PI_SDK_MODULE: sdkPath };
  delete process.env.OPENROUTER_API_KEY;
  chmodSync(agent, 0o500);
  assert.equal(await resolveOpenRouterKey(), 'sk-or-direct-file');
});

test('Jev key resolution creates no file in a read-only Pi agent directory', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'worker-launch-key-'));
  const agent = join(root, 'agent');
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, 'auth.json'), JSON.stringify({ openrouter: { type: 'api_key', key: 'sk-or-direct-file' } }));
  const previousEnv = { ...process.env };
  t.after(() => {
    process.env = previousEnv;
    chmodSync(agent, 0o700);
    rmSync(root, { recursive: true, force: true });
  });
  process.env = { ...previousEnv, PI_CODING_AGENT_DIR: agent };
  delete process.env.OPENROUTER_API_KEY;
  chmodSync(agent, 0o500);
  await resolveOpenRouterKey();
  assert.deepEqual(readdirSync(agent), ['auth.json']);
});


test('launch hands the contract commandPolicy to the Pi guard environment', async (t) => {
  let seen: any;
  const state = launchState({
    task: { commandPolicy: { enforce: true, rules: [{ match: ['git'], placement: 'local' }] } },
    deps: { spawnPi: (_c: string, _a: string[], options: any) => { seen = options.env.JUNIOR_COMMAND_POLICY; return { status: 0, stdout: '', stderr: '' }; } },
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  assert.deepEqual(JSON.parse(seen), { enforce: true, rules: [{ match: ['git'], placement: 'local' }], guards: { noBuild: 'refuse', hookBypass: 'refuse' } });
});

test('launch sets no command policy for a contract without commandPolicy', async (t) => {
  let seen: any = 'unset';
  const state = launchState({
    deps: { env: { ...process.env, JUNIOR_COMMAND_POLICY: '{"enforce":true}' }, spawnPi: (_c: string, _a: string[], options: any) => { seen = options.env.JUNIOR_COMMAND_POLICY; return { status: 0, stdout: '', stderr: '' }; } },
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  assert.equal(seen, undefined);
});

test('a budget stop does not start a continuation segment', async (t) => {
  let spawns = 0;
  const state = launchState({
    task: { budget: { maxToolCalls: 1, mode: 'enforce' }, execution: { continuations: 1 } },
    deps: {
      spawnChild: () => {
        spawns++;
        const fake = fakeChild();
        setImmediate(() => {
          fake.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'true' } });
          fake.emit({ type: 'tool_execution_start', toolCallId: 'c2', toolName: 'bash', args: { command: 'true' } });
          fake.end(0);
        });
        return fake.child;
      },
    },
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  assert.equal(spawns, 1);
});

test('a budget stop is not reported as a Pi failure', async (t) => {
  const fake = fakeChild();
  const state = launchState({
    task: { budget: { maxToolCalls: 1, mode: 'enforce' }, execution: { continuations: 0 } },
    deps: { spawnChild: () => fake.child },
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  // Pi traps SIGTERM and exits 143, as the real CLI does when Junior stops it.
  fake.child.kill = () => { fake.end(143); return true; };
  const running = launch(state);
  await spawned();
  fake.stderr.write('Warning: Model "m" not found for provider "openrouter". Using custom model id.\n');
  fake.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'true' } });
  fake.emit({ type: 'tool_execution_start', toolCallId: 'c2', toolName: 'bash', args: { command: 'true' } });
  await running;
  assert.equal(state.workerFailure ?? null, null);
});

test('eventErrorMessages collects Pi event errors and ignores tool output (#203)', async () => {
  const { eventErrorMessages } = await import('./worker-launch.ts');
  const lines = [
    JSON.stringify({ type: 'tool_execution_end', result: { content: [{ type: 'text', text: "EPERM mkdir 'x/auth.json.lock'" }] } }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', errorMessage: "Credential store read failed for openrouter: EROFS: read-only file system, mkdir '/home/u/.pi/agent/auth.json.lock'" } }),
    JSON.stringify({ type: 'auto_retry_end', success: false, finalError: 'Connection error.' }),
    'not json with an error word',
  ].join('\n');
  assert.deepEqual(eventErrorMessages(lines), [
    "Credential store read failed for openrouter: EROFS: read-only file system, mkdir '/home/u/.pi/agent/auth.json.lock'",
    'Connection error.',
  ]);
});

// --- machine admission (#277, M2) -------------------------------------------

const admissionWait = (overrides: any = {}) => ({
  reason: 'slots', detail: 'slots 4/4 held by r-1', pool: null, since: '2026-01-01T00:00:00.000Z', ...overrides,
});

const granted = (overrides: any = {}) => ({ waitedMs: 0, pool: null, release() {}, ...overrides });

test('a streamed worker acquires admission before Pi starts', async (t) => {
  const order: string[] = [];
  const fake = fakeChild();
  const state = launchState({
    deps: {
      admit: async (req: any) => { order.push(req.kind); return { ok: true, grant: granted() }; },
      spawnChild: () => { order.push('spawn'); setImmediate(() => completeStream(fake)); return fake.child; },
    },
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  assert.deepEqual(order, ['worker', 'spawn']);
});

test('a streamed worker releases its admission slot when Pi exits', async (t) => {
  let released = false;
  const fake = fakeChild();
  const state = launchState({
    deps: {
      admit: async () => ({ ok: true, grant: granted({ release: () => { released = true; } }) }),
      spawnChild: () => { setImmediate(() => completeStream(fake)); return fake.child; },
    },
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  assert.equal(released, true);
});

test('a waiting worker reports the admission phase and wait reason in its heartbeat', async (t) => {
  let live: any;
  const fake = fakeChild();
  const state = launchState({
    deps: {
      admit: async (req: any) => {
        req.onWait(admissionWait());
        const snapshot = state.heartbeat.snapshot();
        live = { phase: snapshot.phase, reason: snapshot.admission?.reason };
        return { ok: true, grant: granted({ waitedMs: 10 }) };
      },
      spawnChild: () => { setImmediate(() => completeStream(fake)); return fake.child; },
    },
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  assert.deepEqual(live, { phase: 'admission', reason: 'slots' });
});

test('a waiting worker emits the admission detail', async (t) => {
  const lines: string[] = [];
  const fake = fakeChild();
  const state = launchState({
    deps: {
      admit: async (req: any) => { req.onWait(admissionWait({ detail: 'available 512 MB < 2,048 MB' })); return { ok: true, grant: granted() }; },
      spawnChild: () => { setImmediate(() => completeStream(fake)); return fake.child; },
    },
  });
  state.emit = (line: string) => lines.push(line);
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  assert.deepEqual(lines.filter((line) => line.startsWith('waiting for admission')), ['waiting for admission: available 512 MB < 2,048 MB']);
});

test('a worker admission timeout prevents Pi from starting', async (t) => {
  let spawns = 0;
  const state = launchState({
    deps: {
      admit: async () => ({ ok: false, error: 'E_ADMISSION_TIMEOUT', wait: admissionWait(), waitedMs: 250 }),
      spawnChild: () => { spawns += 1; return fakeChild().child; },
    },
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  assert.equal(spawns, 0);
});

test('a worker admission timeout is recorded as a worker timeout', async (t) => {
  const state = launchState({
    deps: { admit: async () => ({ ok: false, error: 'E_ADMISSION_TIMEOUT', wait: admissionWait(), waitedMs: 250 }) },
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  assert.deepEqual(state.admissionTimeout, { kind: 'worker', waitedMs: 250, wait: admissionWait() });
});

/** A run whose worker deadline is one clock tick away at launch: the
 * pre-launch check sees time left, admission sees none. */
const noAdmissionBudgetState = (spawnChild: () => any) => {
  const state = launchState({ deps: { spawnChild } });
  const base = 1_000_000;
  let calls = 0;
  state.clock = { ...systemClock, now: () => base + calls++ };
  state.deadlineAt = base + state.settings.checkReserveMs + 1;
  return state;
};

test('a worker with no admission budget does not spawn Pi', async (t) => {
  let spawns = 0;
  const fake = fakeChild();
  const state = noAdmissionBudgetState(() => {
    spawns += 1;
    setImmediate(() => completeStream(fake));
    return fake.child;
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  assert.equal(spawns, 0);
});

test('a worker with no admission budget records an admission timeout', async (t) => {
  const fake = fakeChild();
  const state = noAdmissionBudgetState(() => {
    setImmediate(() => completeStream(fake));
    return fake.child;
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  assert.deepEqual(state.admissionTimeout, { kind: 'worker', waitedMs: 0, wait: null });
});

test('worker admission receives the injected state directory and proc root', async (t) => {
  let observed: any;
  const fake = fakeChild();
  const state = launchState({
    deps: {
      admissionStateDir: '/fixture/admission',
      procRoot: '/fixture/proc',
      admit: async (req: any) => { observed = { stateDir: req.stateDir, procRoot: req.procRoot }; return { ok: true, grant: granted() }; },
      spawnChild: () => { setImmediate(() => completeStream(fake)); return fake.child; },
    },
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  assert.deepEqual(observed, { stateDir: '/fixture/admission', procRoot: '/fixture/proc' });
});

test('worker admission waits no longer than the worker deadline allows', async (t) => {
  let observed: number | undefined;
  const clock = createManualClock(Date.now());
  const fake = fakeChild();
  const state = launchState({
    task: { execution: { deadlineMs: 120000, checkReserveMs: 100000 } },
    deps: {
      clock,
      admit: async (req: any) => { observed = req.config.admissionTimeoutMs; return { ok: true, grant: granted() }; },
      spawnChild: () => { setImmediate(() => completeStream(fake)); return fake.child; },
    },
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  assert.equal(observed, 20000);
});

test('a disabled machine config starts the worker without waiting for admission', async (t) => {
  let spawns = 0;
  const fake = fakeChild();
  const state = launchState({
    task: { machine: { enabled: false } },
    deps: {
      admit: undefined,
      spawnChild: () => { spawns += 1; setImmediate(() => completeStream(fake)); return fake.child; },
    },
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  assert.equal(spawns, 1);
});

test('an interrupted worker admission does not record a timeout', async (t) => {
  const state = launchState({
    deps: { admit: async () => ({ ok: false, error: 'E_ADMISSION_INTERRUPTED', wait: admissionWait(), waitedMs: 25 }) },
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  assert.equal(state.admissionTimeout, undefined);
});

test('a worker admission timeout ends the run admission_timeout', async (t) => {
  const state = launchState({
    deps: { admit: async () => ({ ok: false, error: 'E_ADMISSION_TIMEOUT', wait: admissionWait(), waitedMs: 250 }) },
  });
  state.before = { changedFiles: [] };
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  const result = await finish(state);
  assert.equal(result.status, 'admission_timeout');
});

test('an admitted worker wait is recorded with its waited time', async (t) => {
  const fake = fakeChild();
  const state = launchState({
    deps: {
      admit: async (req: any) => { req.onWait(admissionWait()); return { ok: true, grant: granted({ waitedMs: 42 }) }; },
      spawnChild: () => { setImmediate(() => completeStream(fake)); return fake.child; },
    },
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  assert.deepEqual(state.admissionWaits, [{ ...admissionWait(), waitedMs: 42 }]);
});
