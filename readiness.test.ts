// Behavioral tests for the harness readiness report.
//
// Every scenario is offline and hermetic: the environment, the filesystem
// probes, the packaged skill source, the managed-tool report and the update
// cache are all injected. Nothing touches the real home directory or network,
// and each test asserts exactly one observable outcome.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectReadiness, type ReadinessDeps } from './readiness.ts';
import { doctor } from './setup.ts';

const SOURCE = '# junior delegation skill\n';
const CLAUDE_SKILL = '/repo/.claude/skills/junior/SKILL.md';
const CACHE_PATH = '/home/u/.junior/update-check.json';

/** Every managed tool present, so readiness is gated only by what a scenario
 * is about. */
function readyIntegrations(): any {
  return {
    ready: true,
    statePath: '/tmp/junior/installed.json',
    supported: [],
    tools: ['fmeca', 'cpm', 'crossmatrix', 'scientific-process', 'elicitation'].map((tool) => ({
      tool,
      repo: `praxec/${tool}`,
      installed: true,
      usable: true,
      verified: true,
      executable: true,
      version: '1.0.0',
      tag: 'v1.0.0',
      path: `/tmp/junior/tools/${tool}`,
      provenance: 'test',
      note: 'present',
    })),
  };
}

type World = {
  files?: Record<string, string>;
  binaries?: string[];
  env?: NodeJS.ProcessEnv;
  integrations?: any;
};

function deps(world: World = {}): ReadinessDeps {
  const files: Record<string, string> = { '/pkg/SKILL.md': SOURCE, ...(world.files ?? {}) };
  const env: NodeJS.ProcessEnv = { PATH: '/bin', HOME: '/home/u', ...(world.env ?? {}) };
  const binaries = world.binaries ?? [];
  return {
    env,
    home: env.HOME,
    exists: (path: string) => path in files || binaries.some((binary) => path === `/bin/${binary}`),
    readFile: (path: string) => {
      if (path in files) return files[path];
      throw new Error(`ENOENT: ${path}`);
    },
    skillSource: '/pkg/SKILL.md',
    integrations: world.integrations ?? readyIntegrations(),
  };
}

/** Doctor deps that make Pi execution ready while readiness is governed by the
 * injected expertise surface. */
function doctorDeps(env: NodeJS.ProcessEnv = {}): any {
  const cwd = mkdtempSync(join(tmpdir(), 'junior-readiness-'));
  const agent = join(cwd, 'agent');
  const modelPath = join(agent, 'models-store.json');
  return {
    cwd,
    env: { PATH: '/bin', HOME: '/home/u', PI_CODING_AGENT_DIR: agent, OPENROUTER_API_KEY: 'test-key', ...env },
    nodeVersion: '24.0.0',
    execPath: '/bin/node',
    toolsRoot: join(cwd, 'tools'),
    exists: (path: string) => path === '/bin/pi' || path === modelPath,
    exec: () => ({ status: 0, stdout: '0.1.0' }),
    readFile: (path: string) =>
      path === modelPath ? JSON.stringify({ openrouter: { models: [{ id: 'deepseek/deepseek-v4.1-flash' }] } }) : '',
    readMounts: () => '',
    skillSource: '/pkg/SKILL.md',
  };
}

// --- harness detection ------------------------------------------------------

test('inspectReadiness detects the harness from the environment', () => {
  const result = inspectReadiness(deps({ env: { CODEX_THREAD_ID: 'thread' } }), { cwd: '/repo' });
  assert.equal(result.harness, 'codex');
});

test('inspectReadiness honours an explicit harness override', () => {
  const result = inspectReadiness(deps({ env: { CLAUDECODE: '1' } }), { cwd: '/repo', harness: 'codex' });
  assert.equal(result.harness, 'codex');
});

// --- Junior and companion skills -------------------------------------------

test('inspectReadiness marks a missing companion skill as required', () => {
  const result = inspectReadiness(deps({ binaries: ['cpm'] }), { cwd: '/repo', harness: 'claude' });
  assert.equal(result.items.find((item) => item.id === 'skill:cpm')?.required, true);
});

test('inspectReadiness gives a missing companion skill a fix', () => {
  const result = inspectReadiness(deps({ binaries: ['cpm'] }), { cwd: '/repo', harness: 'claude' });
  assert.ok(result.items.find((item) => item.id === 'skill:cpm')?.fix);
});

test('inspectReadiness finds the Junior skill in the harness skill root', () => {
  const result = inspectReadiness(deps({ files: { [CLAUDE_SKILL]: SOURCE } }), { cwd: '/repo', harness: 'claude' });
  assert.equal(result.items.find((item) => item.id === 'skill:junior')?.status, 'present');
});

// --- MCP registration is recommended ---------------------------------------

test('an unregistered MCP server leaves readiness ready', () => {
  const result = inspectReadiness(deps({ files: { [CLAUDE_SKILL]: SOURCE } }), { cwd: '/repo', harness: 'claude' });
  assert.equal(result.ready, true);
});

test('an unregistered MCP server is a recommended item', () => {
  const result = inspectReadiness(deps({ files: { [CLAUDE_SKILL]: SOURCE } }), { cwd: '/repo', harness: 'claude' });
  assert.equal(result.items.find((item) => item.kind === 'mcp')?.required, false);
});

// --- managed tools gate readiness ------------------------------------------

test('a missing managed tool makes readiness not ready', () => {
  const integrations = readyIntegrations();
  integrations.ready = false;
  integrations.tools = integrations.tools.map((tool: any, index: number) =>
    index === 0 ? { ...tool, installed: false, usable: false } : tool);
  const result = inspectReadiness(
    deps({ files: { [CLAUDE_SKILL]: SOURCE }, integrations }),
    { cwd: '/repo', harness: 'claude' },
  );
  assert.equal(result.ready, false);
});

// --- cached updates ---------------------------------------------------------

test('an outdated package from the cached summary appears as an update item', () => {
  const result = inspectReadiness(
    deps({ files: { [CACHE_PATH]: JSON.stringify({ checkedAt: 1, outdated: ['fmeca'] }) } }),
    { cwd: '/repo', harness: 'claude' },
  );
  assert.equal(result.items.find((item) => item.id === 'update:fmeca')?.status, 'available');
});

test('readiness never runs npm while reading the update cache', () => {
  const calls: string[] = [];
  const injected = deps({ files: { [CACHE_PATH]: JSON.stringify({ checkedAt: 1, outdated: ['fmeca'] }) } });
  injected.exec = (command: string) => {
    calls.push(command);
    return { status: 0, stdout: '' };
  };
  inspectReadiness(injected, { cwd: '/repo', harness: 'claude' });
  assert.equal(calls.includes('npm'), false);
});

// --- fix command ------------------------------------------------------------

test('fixCommand names junior setup with the detected harness', () => {
  const result = inspectReadiness(deps(), { cwd: '/repo', harness: 'codex' });
  assert.equal(result.fixCommand, 'junior setup --harness codex');
});

// --- doctor wiring ----------------------------------------------------------

test('doctor reports readiness detected from the environment', () => {
  const result = doctor(doctorDeps({ CODEX_THREAD_ID: 'thread' }));
  assert.equal(result.readiness.harness, 'codex');
});

test('doctor honours the harness override in readiness', () => {
  const result = doctor(doctorDeps(), { harness: 'codex' });
  assert.equal(result.readiness.harness, 'codex');
});

test('doctor ok is unchanged when readiness is not ready', () => {
  const result = doctor(doctorDeps(), { harness: 'claude' });
  assert.equal(result.ok, true);
});
