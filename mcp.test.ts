// ---------------------------------------------------------------------------
// Behavioral tests for `junior mcp register`.
//
// Every scenario drives the public library/CLI in its own temp directory and
// asserts exactly one observable outcome. The wrapped servers must use the same
// per-project native state that `junior tools call` uses.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMcpServers, inspectMcpRegistration, toMcpConfig } from './mcp.ts';
import { initHop } from './tools/tools.ts';

const ROOT = import.meta.dirname;
const JUNIOR = join(ROOT, 'junior.ts');
const NODE = process.execPath;

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-mcp-'));
}

function makeHop(dir: string, options: Record<string, unknown> = {}): string {
  const hopPath = join(dir, 'hop.json');
  initHop(hopPath, options);
  return hopPath;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value));
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function runJunior(args: string[], cwd: string) {
  return spawnSync(NODE, [JUNIOR, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, JUNIOR_TOOLS_ROOT: join(tmpdir(), 'junior-mcp-no-managed') },
  });
}

// --- buildMcpServers --------------------------------------------------------

test('buildMcpServers exposes one server per hop tool', () => {
  const hop = makeHop(workdir());
  assert.deepEqual(
    buildMcpServers(hop).map((s) => s.name),
    ['fmeca-mcp', 'cpm-planner', 'crossmatrix-mcp'],
  );
});

test('buildMcpServers reflects the hop command and args', () => {
  const hop = makeHop(workdir(), { tools: { fmeca: { command: 'custom-fmeca', args: ['--flag'] } } });
  const fmeca = buildMcpServers(hop).find((s) => s.name === 'fmeca-mcp')!;
  assert.deepEqual({ command: fmeca.command, args: fmeca.args }, { command: 'custom-fmeca', args: ['--flag'] });
});

test('buildMcpServers anchors the cpm state env to the hop directory', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  const cpm = buildMcpServers(hop).find((s) => s.name === 'cpm-planner')!;
  assert.equal(cpm.env.CPM_PLANNER_DB, join(dir, 'cpm-planner.db'));
});

test('buildMcpServers anchors the fmeca state env to the hop directory', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  const fmeca = buildMcpServers(hop).find((s) => s.name === 'fmeca-mcp')!;
  assert.equal(fmeca.env.FMECA_STATE_DIR, join(dir, 'fmeca-state'));
});

test('buildMcpServers env matches the merged per-project state tools call uses', () => {
  const dir = workdir();
  const hop = makeHop(dir, {
    tools: { cpm: { command: 'cpm-planner', args: [], env: { EXTRA: '1', CPM_PLANNER_DB: 'placeholder' } } },
  });
  const cpm = buildMcpServers(hop).find((s) => s.name === 'cpm-planner')!;
  assert.deepEqual(cpm.env, { EXTRA: '1', CPM_PLANNER_DB: join(dir, 'cpm-planner.db') });
});

// --- register / merge -------------------------------------------------------

test('junior mcp register writes all servers into .mcp.json for claude', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  runJunior(['mcp', 'register', '--hop', hop, '--target', 'claude'], dir);
  assert.deepEqual(Object.keys(readJson(join(dir, '.mcp.json')).mcpServers).sort(), [
    'cpm-planner',
    'crossmatrix-mcp',
    'fmeca-mcp',
  ]);
});

test('junior mcp register writes .cursor/mcp.json for cursor', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  runJunior(['mcp', 'register', '--hop', hop, '--target', 'cursor'], dir);
  assert.ok(existsSync(join(dir, '.cursor', 'mcp.json')));
});

test('junior mcp register preserves an unrelated existing server', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  const unrelated = { command: 'other', args: ['--x'], env: { K: 'v' } };
  writeJson(join(dir, '.mcp.json'), { mcpServers: { unrelated } });
  runJunior(['mcp', 'register', '--hop', hop, '--target', 'claude'], dir);
  assert.deepEqual(readJson(join(dir, '.mcp.json')).mcpServers.unrelated, unrelated);
});

test('junior mcp register preserves unrelated top-level keys', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  writeJson(join(dir, '.mcp.json'), { mcpServers: {}, customTop: { keep: true } });
  runJunior(['mcp', 'register', '--hop', hop, '--target', 'claude'], dir);
  assert.deepEqual(readJson(join(dir, '.mcp.json')).customTop, { keep: true });
});

test('junior mcp register leaves a same-name conflict unchanged without --force', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  const conflicting = { command: 'other', args: [], env: {} };
  writeJson(join(dir, '.mcp.json'), { mcpServers: { 'cpm-planner': conflicting } });
  runJunior(['mcp', 'register', '--hop', hop, '--target', 'claude'], dir);
  assert.deepEqual(readJson(join(dir, '.mcp.json')).mcpServers['cpm-planner'], conflicting);
});

test('junior mcp register reports a same-name conflict without --force', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  writeJson(join(dir, '.mcp.json'), { mcpServers: { 'cpm-planner': { command: 'other', args: [], env: {} } } });
  const report = JSON.parse(runJunior(['mcp', 'register', '--hop', hop, '--target', 'claude'], dir).stdout);
  assert.deepEqual(report.conflicts, ['cpm-planner']);
});

test('junior mcp register --force replaces a same-name conflict', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  writeJson(join(dir, '.mcp.json'), { mcpServers: { 'cpm-planner': { command: 'other', args: [], env: {} } } });
  runJunior(['mcp', 'register', '--hop', hop, '--target', 'claude', '--force'], dir);
  assert.equal(readJson(join(dir, '.mcp.json')).mcpServers['cpm-planner'].env.CPM_PLANNER_DB, join(dir, 'cpm-planner.db'));
});

// --- print / codex / dry-run ------------------------------------------------

test('junior mcp register --target print writes no config file', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  runJunior(['mcp', 'register', '--hop', hop, '--target', 'print'], dir);
  assert.equal(existsSync(join(dir, '.mcp.json')), false);
});

test('junior mcp register --target print prints the MCP config JSON', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  const out = runJunior(['mcp', 'register', '--hop', hop, '--target', 'print'], dir);
  assert.deepEqual(Object.keys(JSON.parse(out.stdout).mcpServers).sort(), [
    'cpm-planner',
    'crossmatrix-mcp',
    'fmeca-mcp',
  ]);
});

test('junior mcp register --target codex prints a TOML mcp_servers snippet', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  const out = runJunior(['mcp', 'register', '--hop', hop, '--target', 'codex'], dir);
  assert.match(out.stdout, /\[mcp_servers\.fmeca-mcp\]/);
});

test('junior mcp register --dry-run writes no config file', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  runJunior(['mcp', 'register', '--hop', hop, '--target', 'claude', '--dry-run'], dir);
  assert.equal(existsSync(join(dir, '.mcp.json')), false);
});

test('junior mcp register --dry-run reports planned additions', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  const report = JSON.parse(runJunior(['mcp', 'register', '--hop', hop, '--target', 'claude', '--dry-run'], dir).stdout);
  assert.equal(report.added.length, 3);
});

// --- project directory ------------------------------------------------------

test('junior mcp register writes into the --project directory, not the hop directory', () => {
  const project = workdir();
  const hop = join(project, '.delivery', 'setup', 'hop.json');
  initHop(hop);
  runJunior(['mcp', 'register', '--hop', hop, '--project', project, '--target', 'claude'], project);
  assert.ok(existsSync(join(project, '.mcp.json')));
});

// --- stable configs are not rewritten ---------------------------------------

test('junior mcp register leaves config bytes untouched when every server already matches', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  const config = JSON.stringify(toMcpConfig(buildMcpServers(hop)));
  const configPath = join(dir, '.mcp.json');
  writeFileSync(configPath, config);
  runJunior(['mcp', 'register', '--hop', hop, '--project', dir, '--target', 'claude'], dir);
  assert.equal(readFileSync(configPath, 'utf8'), config);
});

test('junior mcp register reports written false when only conflicting servers exist', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  writeJson(join(dir, '.mcp.json'), {
    mcpServers: {
      'fmeca-mcp': { command: 'other', args: [], env: {} },
      'cpm-planner': { command: 'other', args: [], env: {} },
      'crossmatrix-mcp': { command: 'other', args: [], env: {} },
    },
  });
  const report = JSON.parse(runJunior(['mcp', 'register', '--hop', hop, '--project', dir, '--target', 'claude'], dir).stdout);
  assert.equal(report.written, false);
});

// --- malformed configs are refused ------------------------------------------

test('junior mcp register refuses a config whose JSON is not an object', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify(['unexpected']));
  const out = JSON.parse(runJunior(['mcp', 'register', '--hop', hop, '--project', dir, '--target', 'claude'], dir).stdout);
  assert.equal(out.error.code, 'MCP_REGISTER_ERROR');
});

test('junior mcp register leaves a non-object config byte-identical', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  const configPath = join(dir, '.mcp.json');
  const raw = JSON.stringify(['unexpected']);
  writeFileSync(configPath, raw);
  runJunior(['mcp', 'register', '--hop', hop, '--project', dir, '--target', 'claude'], dir);
  assert.equal(readFileSync(configPath, 'utf8'), raw);
});

test('junior mcp register refuses a config whose mcpServers is not an object', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  writeJson(join(dir, '.mcp.json'), { mcpServers: 'unexpected' });
  const out = JSON.parse(runJunior(['mcp', 'register', '--hop', hop, '--project', dir, '--target', 'claude'], dir).stdout);
  assert.equal(out.error.code, 'MCP_REGISTER_ERROR');
});

test('junior mcp register leaves an mcpServers-not-object config byte-identical', () => {
  const dir = workdir();
  const hop = makeHop(dir);
  const configPath = join(dir, '.mcp.json');
  const raw = JSON.stringify({ mcpServers: 'unexpected' });
  writeFileSync(configPath, raw);
  runJunior(['mcp', 'register', '--hop', hop, '--project', dir, '--target', 'claude'], dir);
  assert.equal(readFileSync(configPath, 'utf8'), raw);
});

// --- no automatic registration ----------------------------------------------

test('junior init does not register an MCP config', () => {
  const dir = workdir();
  runJunior(['init', '--no-install', '--no-companions'], dir);
  assert.equal(existsSync(join(dir, '.mcp.json')), false);
});

// --- inspectMcpRegistration -------------------------------------------------

const PROJ = '/virtual/project';
const HOME = '/virtual/home';

function fixtureReader(files: Record<string, string>) {
  return {
    readFile: (file: string): string => {
      const content = files[file];
      if (content === undefined) throw new Error(`ENOENT: ${file}`);
      return content;
    },
    exists: (file: string): boolean => file in files,
  };
}

function inspectClaude(files: Record<string, string>, hopPath?: string) {
  return inspectMcpRegistration('claude', { cwd: PROJ, home: HOME, hopPath, ...fixtureReader(files) });
}

function statusOf(report: { servers: Array<{ name: string; status: string }> }, name: string): string | undefined {
  return report.servers.find((server) => server.name === name)?.status;
}

test('inspect reports a server in the project .mcp.json as present', () => {
  const path = join(PROJ, '.mcp.json');
  const report = inspectClaude({
    [path]: JSON.stringify({ mcpServers: { 'cpm-planner': { command: 'x', args: [], env: {} } } }),
  });
  assert.equal(statusOf(report, 'cpm-planner'), 'present');
});

test('inspect labels a server found in the project .mcp.json with scope project', () => {
  const path = join(PROJ, '.mcp.json');
  const report = inspectClaude({
    [path]: JSON.stringify({ mcpServers: { 'cpm-planner': { command: 'x', args: [], env: {} } } }),
  });
  assert.equal(report.servers.find((server) => server.name === 'cpm-planner')?.scope, 'project');
});

test('inspect reports a server in ~/.claude.json local project scope as present', () => {
  const path = join(HOME, '.claude.json');
  const report = inspectClaude({
    [path]: JSON.stringify({
      projects: { [PROJ]: { mcpServers: { 'fmeca-mcp': { command: 'x', args: [], env: {} } } } },
    }),
  });
  assert.equal(statusOf(report, 'fmeca-mcp'), 'present');
});

test('inspect labels a ~/.claude.json local project server with scope local', () => {
  const path = join(HOME, '.claude.json');
  const report = inspectClaude({
    [path]: JSON.stringify({
      projects: { [PROJ]: { mcpServers: { 'fmeca-mcp': { command: 'x', args: [], env: {} } } } },
    }),
  });
  assert.equal(report.servers.find((server) => server.name === 'fmeca-mcp')?.scope, 'local');
});

test('inspect finds a Codex [mcp_servers.cpm-planner] table', () => {
  const path = join(HOME, '.codex', 'config.toml');
  const report = inspectMcpRegistration('codex', {
    cwd: PROJ,
    home: HOME,
    ...fixtureReader({ [path]: '[mcp_servers.cpm-planner]\ncommand = "cpm-planner"\nargs = []\n' }),
  });
  assert.equal(statusOf(report, 'cpm-planner'), 'present');
});

test('inspect reports a server with a different command than the hop expects as differs', () => {
  const dir = workdir();
  const hopPath = makeHop(dir, { tools: { cpm: { command: 'expected-cpm', args: [] } } });
  const path = join(PROJ, '.mcp.json');
  const report = inspectMcpRegistration('claude', {
    cwd: PROJ,
    home: HOME,
    hopPath,
    ...fixtureReader({ [path]: JSON.stringify({ mcpServers: { 'cpm-planner': { command: 'other-cpm', args: [], env: {} } } }) }),
  });
  assert.equal(statusOf(report, 'cpm-planner'), 'differs');
});

test('inspect reports unknown when a server config file cannot be parsed', () => {
  const path = join(PROJ, '.mcp.json');
  const report = inspectClaude({ [path]: '{ this is not JSON' });
  assert.equal(statusOf(report, 'fmeca-mcp'), 'unknown');
});

test('inspect never includes env values in the report', () => {
  const path = join(PROJ, '.mcp.json');
  const secret = 'super-secret-value';
  const report = inspectClaude({
    [path]: JSON.stringify({ mcpServers: { 'cpm-planner': { command: 'x', args: [], env: { TOKEN: secret } } } }),
  });
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('inspect marks an existing config location as exists', () => {
  const path = join(PROJ, '.mcp.json');
  const report = inspectClaude({ [path]: '{}' });
  assert.equal(report.configs.find((config) => config.path === path)?.exists, true);
});

test('inspect marks a parseable config location as parsed', () => {
  const path = join(PROJ, '.mcp.json');
  const report = inspectClaude({ [path]: '{}' });
  assert.equal(report.configs.find((config) => config.path === path)?.parsed, true);
});

test('inspect expects the jevitate server without a hop manifest', () => {
  const report = inspectClaude({});
  assert.ok(report.servers.some((server) => server.name === 'jevitate'));
});
