// Behavioral tests for the harness readiness report.
//
// Every scenario is offline and hermetic: the environment, the filesystem
// probes, the packaged skill source, the managed-tool report and the update
// cache are all injected. Nothing touches the real home directory or network,
// and each test asserts exactly one observable outcome.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectReadiness,
  planSetup,
  runSetup,
  type ReadinessDeps,
  type ReadinessItem,
  type ReadinessResult,
} from './readiness.ts';
import type { Harness } from './harness.ts';
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

// --- setup planning ---------------------------------------------------------

/** Write a minimal valid HOP on disk so `planSetup` can derive MCP argv. */
function hopOnDisk(dir: string, opts: { secret?: string } = {}): string {
  const hopPath = join(dir, '.delivery', 'setup', 'hop.json');
  mkdirSync(join(dir, '.delivery', 'setup'), { recursive: true });
  const tool = (command: string, env: Record<string, string> = {}) => ({ command, args: [], env, sourceVersion: '1.0.0', sourceSha: '' });
  writeFileSync(hopPath, JSON.stringify({
    schemaVersion: 1,
    projectId: 'prj_test',
    revision: 0,
    managerAcceptance: 'pending',
    timeoutMs: 1000,
    lockTimeoutMs: 1000,
    tools: {
      fmeca: tool('fmeca-mcp', opts.secret ? { FMECA_TOKEN: opts.secret } : {}),
      cpm: tool('cpm'),
      crossmatrix: tool('crossmatrix-mcp'),
    },
    native: {
      fmeca: { statePath: '.fmeca/state' },
      cpm: { statePath: '.cpm/planner.db' },
      crossmatrix: { statePath: '.crossmatrix/model.json' },
    },
    snapshots: [],
    evidence: [],
    unresolved: [],
  }, null, 2));
  return hopPath;
}

function readinessWith(items: Array<Partial<ReadinessItem>>, harness: Harness = 'codex'): ReadinessResult {
  return {
    harness,
    evidence: [],
    ready: false,
    items: items.map((item, index) => ({
      id: item.id ?? `item:${index}`,
      kind: item.kind ?? 'mcp',
      name: item.name ?? `name-${index}`,
      status: item.status ?? 'missing',
      required: item.required ?? false,
    })),
    summary: 'not ready',
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-setup-'));
}

const SILENT = { stderr: () => {}, stdout: () => {} };

test('planSetup turns a missing Codex MCP server into a codex mcp add command', () => {
  const dir = tempDir();
  const hopPath = hopOnDisk(dir);
  const readiness = readinessWith([{ id: 'mcp:fmeca-mcp', kind: 'mcp', name: 'fmeca-mcp', status: 'missing' }], 'codex');
  const action = planSetup(readiness, { harness: 'codex', hopPath, cwd: dir }).find((entry) => entry.id === 'mcp:fmeca-mcp');
  assert.deepEqual(action?.command, [
    'codex', 'mcp', 'add', 'fmeca-mcp',
    '--env', `FMECA_STATE_DIR=${join(dir, '.delivery', 'setup', '.fmeca', 'state')}`,
    '--', 'fmeca-mcp',
  ]);
});

test('planSetup registers a missing Claude MCP server with project scope', () => {
  const dir = tempDir();
  const hopPath = hopOnDisk(dir);
  const readiness = readinessWith([{ id: 'mcp:fmeca-mcp', kind: 'mcp', name: 'fmeca-mcp', status: 'missing' }], 'claude');
  const action = planSetup(readiness, { harness: 'claude', hopPath, cwd: dir }).find((entry) => entry.id === 'mcp:fmeca-mcp');
  assert.deepEqual(action?.command?.slice(0, 6), ['claude', 'mcp', 'add', 'fmeca-mcp', '--scope', 'project']);
});

test('runSetup backs up .cursor/mcp.json before the cursor registration writes it', async () => {
  const dir = tempDir();
  const hopPath = hopOnDisk(dir);
  mkdirSync(join(dir, '.cursor'), { recursive: true });
  writeFileSync(join(dir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const readiness = readinessWith([{ id: 'mcp:fmeca-mcp', kind: 'mcp', name: 'fmeca-mcp', status: 'missing' }], 'cursor');
  await runSetup(
    { readiness, inspect: () => readinessWith([], 'cursor'), exec: () => ({ status: 0 }), env: { PATH: '', HOME: dir }, ...SILENT },
    { cwd: dir, harness: 'cursor', hopPath, yes: true },
  );
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.cursor', 'mcp.json.bak'), 'utf8')), { mcpServers: {} });
});

test('runSetup --dry-run runs no commands', async () => {
  const dir = tempDir();
  const calls: string[] = [];
  const readiness = readinessWith([{ id: 'tool:fmeca', kind: 'tool', name: 'fmeca', status: 'missing', required: true }], 'codex');
  await runSetup(
    { readiness, exec: (command) => { calls.push(command); return { status: 0 }; }, ...SILENT },
    { cwd: dir, harness: 'codex', hopPath: hopOnDisk(dir), dryRun: true },
  );
  assert.deepEqual(calls, []);
});

test('runSetup exits 2 without confirmation on a non-TTY', async () => {
  const dir = tempDir();
  const readiness = readinessWith([{ id: 'tool:fmeca', kind: 'tool', name: 'fmeca', status: 'missing', required: true }], 'codex');
  const result = await runSetup(
    { readiness, isTTY: false, exec: () => ({ status: 0 }), ...SILENT },
    { cwd: dir, harness: 'codex', hopPath: hopOnDisk(dir) },
  );
  assert.equal(result.exitCode, 2);
});

test('runSetup runs no commands without confirmation on a non-TTY', async () => {
  const dir = tempDir();
  const calls: string[] = [];
  const readiness = readinessWith([{ id: 'tool:fmeca', kind: 'tool', name: 'fmeca', status: 'missing', required: true }], 'codex');
  await runSetup(
    { readiness, isTTY: false, exec: (command) => { calls.push(command); return { status: 0 }; }, ...SILENT },
    { cwd: dir, harness: 'codex', hopPath: hopOnDisk(dir) },
  );
  assert.deepEqual(calls, []);
});

test('runSetup reports the action id that --yes applied', async () => {
  const dir = tempDir();
  const readiness = readinessWith([{ id: 'tool:fmeca', kind: 'tool', name: 'fmeca', status: 'missing', required: true }], 'codex');
  const result = await runSetup(
    { readiness, inspect: () => readinessWith([], 'codex'), exec: () => ({ status: 0 }), ...SILENT },
    { cwd: dir, harness: 'codex', hopPath: hopOnDisk(dir), yes: true },
  );
  assert.ok(result.report?.applied.includes('tool:managed'));
});

test('runSetup reports the action id of a command that failed', async () => {
  const dir = tempDir();
  const readiness = readinessWith([{ id: 'tool:fmeca', kind: 'tool', name: 'fmeca', status: 'missing', required: true }], 'codex');
  const result = await runSetup(
    { readiness, inspect: () => readinessWith([], 'codex'), exec: () => ({ status: 1, stderr: 'boom' }), ...SILENT },
    { cwd: dir, harness: 'codex', hopPath: hopOnDisk(dir), yes: true },
  );
  assert.deepEqual(result.report?.failed.map((entry) => entry.id), ['tool:managed']);
});

test('runSetup prints nothing to do when the harness is already ready', async () => {
  const dir = tempDir();
  const ready = readinessWith([], 'codex');
  ready.ready = true;
  let err = '';
  await runSetup(
    { readiness: ready, exec: () => ({ status: 0 }), stderr: (text) => { err += text; }, stdout: () => {} },
    { cwd: dir, harness: 'codex', hopPath: hopOnDisk(dir), yes: true },
  );
  assert.match(err, /nothing to do/);
});

test('runSetup never prints an MCP env value in the dry-run preview', async () => {
  const dir = tempDir();
  const secret = 'super-secret-token';
  const readiness = readinessWith([{ id: 'mcp:fmeca-mcp', kind: 'mcp', name: 'fmeca-mcp', status: 'missing' }], 'codex');
  let err = '';
  await runSetup(
    { readiness, exec: () => ({ status: 0 }), stderr: (text) => { err += text; }, stdout: () => {} },
    { cwd: dir, harness: 'codex', hopPath: hopOnDisk(dir, { secret }), dryRun: true },
  );
  assert.doesNotMatch(err, new RegExp(secret));
});

test('runSetup previews an MCP env value as a redacted variable name', async () => {
  const dir = tempDir();
  const readiness = readinessWith([{ id: 'mcp:fmeca-mcp', kind: 'mcp', name: 'fmeca-mcp', status: 'missing' }], 'codex');
  let err = '';
  await runSetup(
    { readiness, exec: () => ({ status: 0 }), stderr: (text) => { err += text; }, stdout: () => {} },
    { cwd: dir, harness: 'codex', hopPath: hopOnDisk(dir, { secret: 'super-secret-token' }), dryRun: true },
  );
  assert.match(err, /FMECA_TOKEN=\*\*\*/);
});

test('planSetup runs the given Junior command for its own actions', () => {
  const actions = planSetup(
    { harness: 'claude', evidence: [], ready: false, items: [{ id: 'tool:elicitation', kind: 'tool', name: 'elicitation', status: 'missing', required: true }], fixCommand: 'junior setup', summary: '' } as any,
    { harness: 'claude', cwd: '/p', juniorCommand: ['/usr/bin/node', '/src/junior.ts'] },
  );
  assert.deepEqual(actions[0].command?.slice(0, 2), ['/usr/bin/node', '/src/junior.ts']);
});
