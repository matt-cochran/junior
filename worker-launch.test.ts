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
import { createRunState } from './worker-preflight.ts';
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
  const state = createRunState(task, false, extra.deps ?? {});
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
  completeStream(fake);
  await running;
  assert.deepEqual(state.streamResult.budget.requested, { maxToolCalls: 25, maxTotalTokens: 400000, mode: 'enforce' });
});

test('a retryable fetch failure without assistant messages retries the segment exactly once', async (t) => {
  let spawns = 0;
  const makeFailed = () => {
    const fake = fakeChild();
    fake.stderr.write('fetch failed\n');
    setImmediate(() => fake.end(1));
    return fake.child;
  };
  const state = launchState({
    deps: {
      spawnChild: () => {
        spawns += 1;
        return makeFailed();
      },
    },
  });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  assert.equal(spawns, 2);
});

test('a retried Pi failure is recorded with retried true', async (t) => {
  const makeFailed = () => {
    const fake = fakeChild();
    fake.stderr.write('fetch failed\n');
    setImmediate(() => fake.end(1));
    return fake.child;
  };
  const state = launchState({ deps: { spawnChild: makeFailed } });
  t.after(() => rmSync(state.sourceCwd, { recursive: true, force: true }));
  await launch(state);
  assert.equal(state.workerFailure.retried, true);
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

