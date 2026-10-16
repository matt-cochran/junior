// ---------------------------------------------------------------------------
// `junior mcp register` — register the FMECA / CPM / Crossmatrix MCP servers
// in an agent host with the same per-project native state `junior tools call`
// uses.
//
// The servers are derived from a HOP manifest so `FMECA_STATE_DIR` and
// `CPM_PLANNER_DB` anchor to the manifest folder (via `buildToolEnv`), never a
// global default. Registration is explicit: `init` never calls this module.
//
// Targets:
//   claude → <project>/.mcp.json        (merged under `mcpServers`)
//   cursor → <project>/.cursor/mcp.json (merged under `mcpServers`)
//   print  → the MCP config JSON on stdout, no writes
//   codex  → a TOML `[mcp_servers.<name>]` snippet on stdout (Codex config is
//            TOML, so it is never written automatically)
//
// Existing unrelated servers and top-level keys are preserved. A same-name
// entry with different content is a conflict: it is reported and left unchanged
// unless `--force` replaces it.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { harnessMcpConfig, type Harness } from './harness.ts';
import { buildToolEnv, loadHop, TOOL_NAMES, type ToolName } from './tools/tools.ts';

/** Stable MCP server names, matching each tool's own launcher. */
const MCP_SERVER_NAMES: Record<ToolName, string> = {
  fmeca: 'fmeca-mcp',
  cpm: 'cpm-planner',
  crossmatrix: 'crossmatrix-mcp',
};

export type McpTarget = 'claude' | 'cursor' | 'print' | 'codex';

export interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpRegisterReport {
  target: McpTarget;
  path: string | null;
  dryRun: boolean;
  added: string[];
  unchanged: string[];
  conflicts: string[];
  written: boolean;
}

export interface RegisterOptions {
  hopPath: string;
  target: McpTarget;
  /** Project directory the host config is written in (default: process.cwd()). */
  projectDir?: string;
  force?: boolean;
  dryRun?: boolean;
}

export type McpRegistrationStatus = 'present' | 'missing' | 'differs' | 'unknown';
export type McpRegistrationScope = 'project' | 'user' | 'local';

/** One expected server and where it was found, if anywhere. `detail` never
 * carries env values or other secrets. */
export interface InspectedMcpServer {
  name: string;
  status: McpRegistrationStatus;
  location?: string;
  scope?: McpRegistrationScope;
  detail?: string;
}

/** One host config file the harness reads, with its parse outcome. */
export interface InspectedMcpConfig {
  path: string;
  exists: boolean;
  parsed: boolean;
}

export interface McpRegistrationInspection {
  harness: Harness;
  servers: InspectedMcpServer[];
  configs: InspectedMcpConfig[];
}

/** Injected, read-only view of the filesystem the inspector observes. */
export interface InspectMcpDeps {
  cwd: string;
  home: string;
  hopPath?: string;
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
}

/** A server entry reduced to the command (and args) the host recorded; env is dropped. */
type RecordedServer = { command?: string; args?: string[] };

/** Server tables read from a TOML config. */
interface ParsedToml {
  servers: Record<string, RecordedServer>;
  parsed: boolean;
}

function isUnder(dir: string, target: string): boolean {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return target === dir || target.startsWith(prefix);
}

/** Reduce a `mcpServers` object to name → command only, never env. */
function extractServers(value: unknown): Record<string, RecordedServer> | undefined {
  if (!isRecord(value)) return undefined;
  const servers: Record<string, RecordedServer> = {};
  for (const [name, entry] of Object.entries(value)) {
    servers[name] = isRecord(entry) && typeof entry.command === 'string' ? { command: entry.command } : {};
  }
  return servers;
}

function readTomlString(value: string): string | undefined {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return undefined;
  return value
    .slice(1, -1)
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function readTomlArray(value: string): string[] | undefined {
  if (!value.startsWith('[') || !value.endsWith(']')) return undefined;
  const inner = value.slice(1, -1).trim();
  if (inner === '') return [];
  const quoted = inner.match(/"(?:[^"\\]|\\.)*"/g);
  if (!quoted || quoted.length === 0) return undefined;
  const parsed = quoted.map((item) => readTomlString(item));
  if (parsed.some((item) => item === undefined)) return undefined;
  return parsed as string[];
}

/**
 * Minimal TOML reader for Codex's `[mcp_servers.<name>]` tables: table headers
 * plus the `command` and `args` keys. Nested `[...env]` tables are skipped so
 * env values never enter the report. Anything outside that shape that looks
 * like TOML is treated as unparseable.
 */
function parseTomlServerTables(text: string): ParsedToml {
  const servers: Record<string, RecordedServer> = {};
  let current: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      const name = header[1];
      const rest = name.startsWith('mcp_servers.') ? name.slice('mcp_servers.'.length) : null;
      if (rest && rest.length > 0 && !rest.includes('.')) {
        current = rest;
        if (!(current in servers)) servers[current] = {};
      } else {
        current = null;
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) return { servers, parsed: false };
    if (current === null) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'command') {
      const command = readTomlString(value);
      if (command === undefined) return { servers, parsed: false };
      servers[current].command = command;
    } else if (key === 'args') {
      const args = readTomlArray(value);
      if (args === undefined) return { servers, parsed: false };
      servers[current].args = args;
    }
  }
  return { servers, parsed: true };
}

/**
 * Read-only inspection of where the Junior MCP servers are registered for a
 * harness. It never writes and never throws: an existing config that cannot be
 * parsed is reported as unparseable and its servers become `unknown`.
 */
export function inspectMcpRegistration(harness: Harness, deps: InspectMcpDeps): McpRegistrationInspection {
  const expected: Array<{ name: string; command?: string }> = [];
  if (deps.hopPath) {
    try {
      for (const server of buildMcpServers(deps.hopPath)) {
        expected.push({ name: server.name, command: server.command });
      }
    } catch {
      // A hop that cannot be read still yields the known server names.
    }
  }
  for (const name of [...Object.values(MCP_SERVER_NAMES), 'jevitate']) {
    if (!expected.some((server) => server.name === name)) expected.push({ name });
  }

  const configs: InspectedMcpConfig[] = [];
  const sources: Array<{ path: string; scope: McpRegistrationScope; servers: Record<string, RecordedServer> }> = [];
  const parseFailures: string[] = [];
  const claudeUserPath = path.join(deps.home, '.claude.json');

  for (const location of harnessMcpConfig(harness, { cwd: deps.cwd, home: deps.home }).locations) {
    if (!deps.exists(location.path)) {
      configs.push({ path: location.path, exists: false, parsed: false });
      continue;
    }

    let text: string;
    try {
      text = deps.readFile(location.path);
    } catch {
      configs.push({ path: location.path, exists: true, parsed: false });
      parseFailures.push(location.path);
      continue;
    }

    if (location.path.endsWith('.toml')) {
      const result = parseTomlServerTables(text);
      configs.push({ path: location.path, exists: true, parsed: result.parsed });
      if (!result.parsed) {
        parseFailures.push(location.path);
        continue;
      }
      sources.push({ path: location.path, scope: 'user', servers: result.servers });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!isRecord(parsed)) {
      configs.push({ path: location.path, exists: true, parsed: false });
      parseFailures.push(location.path);
      continue;
    }
    configs.push({ path: location.path, exists: true, parsed: true });

    if (location.path === claudeUserPath) {
      const userServers = extractServers(parsed.mcpServers);
      if (userServers) sources.push({ path: location.path, scope: 'user', servers: userServers });
      const projects = isRecord(parsed.projects) ? parsed.projects : undefined;
      const local = projects && isRecord(projects[deps.cwd]) ? projects[deps.cwd] : undefined;
      const localServers = local && isRecord(local.mcpServers) ? extractServers(local.mcpServers) : undefined;
      if (localServers) sources.push({ path: location.path, scope: 'local', servers: localServers });
      continue;
    }

    const servers = extractServers(parsed.mcpServers);
    if (servers) {
      sources.push({ path: location.path, scope: isUnder(deps.cwd, location.path) ? 'project' : 'user', servers });
    }
  }

  const servers: InspectedMcpServer[] = expected.map((server) => {
    for (const source of sources) {
      if (!(server.name in source.servers)) continue;
      const recorded = source.servers[server.name];
      if (server.command !== undefined && recorded.command !== server.command) {
        return {
          name: server.name,
          status: 'differs',
          location: source.path,
          scope: source.scope,
          detail: 'command does not match the hop manifest',
        };
      }
      return { name: server.name, status: 'present', location: source.path, scope: source.scope };
    }
    if (parseFailures.length > 0) {
      return { name: server.name, status: 'unknown', detail: `${parseFailures[0]} could not be parsed` };
    }
    return { name: server.name, status: 'missing' };
  });

  return { harness, servers, configs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural equality independent of object key order. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return false;
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * One MCP server entry per HOP tool. `env` is exactly the merge `callHop` uses:
 * the manifest's per-tool env with `buildToolEnv`'s anchored paths overriding.
 */
export function buildMcpServers(hopPath: string): McpServerEntry[] {
  const hop = loadHop(hopPath);
  return TOOL_NAMES.map((tool) => {
    const cfg = hop.tools[tool];
    return {
      name: MCP_SERVER_NAMES[tool],
      command: cfg.command,
      args: [...cfg.args],
      env: { ...(cfg.env ?? {}), ...buildToolEnv(hopPath, tool, hop) },
    };
  });
}

/** Project a server list into the host config shape. */
export function toMcpConfig(servers: McpServerEntry[]): McpConfig {
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const server of servers) {
    mcpServers[server.name] = { command: server.command, args: server.args, env: server.env };
  }
  return { mcpServers };
}

/** The config file a JSON host target writes, anchored to the HOP's project. */
export function mcpConfigPath(projectDir: string, target: 'claude' | 'cursor'): string {
  return target === 'claude'
    ? path.join(projectDir, '.mcp.json')
    : path.join(projectDir, '.cursor', 'mcp.json');
}

function writeFileAtomic(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

/** Read an existing host config, refusing anything that is not a JSON object. */
function readExistingConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${configPath} must contain a JSON object`);
  }
  if ('mcpServers' in parsed && !isRecord(parsed.mcpServers)) {
    throw new Error(`${configPath}: mcpServers must be a JSON object`);
  }
  return parsed;
}

/**
 * Merge the HOP's servers into a JSON host config. `print`/`codex` render only
 * and never touch disk; `claude`/`cursor` write unless `dryRun` is set or no
 * server is added or replaced (only unchanged and/or conflicting entries).
 */
export function registerMcpServers(options: RegisterOptions): McpRegisterReport {
  const servers = buildMcpServers(options.hopPath);
  const projectDir = path.resolve(options.projectDir ?? process.cwd());

  if (options.target === 'print' || options.target === 'codex') {
    return {
      target: options.target,
      path: null,
      dryRun: !!options.dryRun,
      added: servers.map((s) => s.name),
      unchanged: [],
      conflicts: [],
      written: false,
    };
  }

  const configPath = mcpConfigPath(projectDir, options.target);
  const existing = readExistingConfig(configPath);

  const existingServers = isRecord(existing.mcpServers) ? { ...existing.mcpServers } : {};
  const added: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];

  for (const server of servers) {
    const desired: McpServerConfig = { command: server.command, args: server.args, env: server.env };
    const current = existingServers[server.name];
    if (current === undefined) {
      existingServers[server.name] = desired;
      added.push(server.name);
    } else if (deepEqual(current, desired)) {
      unchanged.push(server.name);
    } else if (options.force) {
      existingServers[server.name] = desired;
      added.push(server.name);
    } else {
      conflicts.push(server.name);
    }
  }

  const written = !options.dryRun && added.length > 0;
  if (written) {
    const merged = { ...existing, mcpServers: existingServers };
    writeFileAtomic(configPath, JSON.stringify(merged, null, 2) + '\n');
  }

  return {
    target: options.target,
    path: configPath,
    dryRun: !!options.dryRun,
    added,
    unchanged,
    conflicts,
    written,
  };
}

function tomlString(value: string): string {
  return (
    '"' +
    value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t') +
    '"'
  );
}

function tomlArray(values: string[]): string {
  return '[' + values.map(tomlString).join(', ') + ']';
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/** Render the Codex TOML snippet a manager pastes into their config. */
export function renderCodexToml(servers: McpServerEntry[]): string {
  const blocks: string[] = [];
  for (const server of servers) {
    const lines = [
      `[mcp_servers.${server.name}]`,
      `command = ${tomlString(server.command)}`,
      `args = ${tomlArray(server.args)}`,
    ];
    const envKeys = Object.keys(server.env);
    if (envKeys.length) {
      lines.push('');
      lines.push(`[mcp_servers.${server.name}.env]`);
      for (const key of envKeys) lines.push(`${tomlKey(key)} = ${tomlString(server.env[key])}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const MCP_USAGE = [
  'Usage: junior mcp <command> [args]',
  '  register --hop <hop.json> --target claude|cursor|print|codex [--project <dir>] [--dry-run] [--force]',
].join('\n');

const TARGETS: McpTarget[] = ['claude', 'cursor', 'print', 'codex'];

function wantsHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

function fail(message: string): number {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'USAGE', message } }, null, 2) + '\n');
  return 1;
}

interface RegisterArgs {
  hopPath: string | undefined;
  target: string | undefined;
  projectDir: string | undefined;
  dryRun: boolean;
  force: boolean;
}

function parseRegisterArgs(args: string[]): RegisterArgs {
  const parsed: RegisterArgs = { hopPath: undefined, target: undefined, projectDir: undefined, dryRun: false, force: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (name === '--dry-run' || name === '--force') {
      if (inline !== undefined) throw Error(`Option ${name} does not take a value`);
      if (name === '--dry-run') parsed.dryRun = true;
      else parsed.force = true;
      continue;
    }
    if (name === '--hop' || name === '--target' || name === '--project') {
      let value = inline;
      if (value === undefined) value = args[++i];
      if (value === undefined || value === '' || value.startsWith('-')) throw Error(`Option ${name} requires a value`);
      if (name === '--hop') parsed.hopPath = value;
      else if (name === '--target') parsed.target = value;
      else parsed.projectDir = value;
      continue;
    }
    throw Error(`Unknown option for mcp register: ${arg}`);
  }
  return parsed;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(MCP_USAGE + '\n');
    return 0;
  }
  if (command !== 'register') {
    return fail(`Unknown mcp command: ${command}\n${MCP_USAGE}`);
  }
  if (wantsHelp(rest)) {
    process.stdout.write(MCP_USAGE + '\n');
    return 0;
  }

  let parsed: RegisterArgs;
  try {
    parsed = parseRegisterArgs(rest);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (!parsed.hopPath) return fail(`Option --hop is required\n${MCP_USAGE}`);
  if (!parsed.target) return fail(`Option --target is required\n${MCP_USAGE}`);
  if (!TARGETS.includes(parsed.target as McpTarget)) {
    return fail(`Invalid --target value: ${parsed.target} (expected ${TARGETS.join('|')})`);
  }
  const target = parsed.target as McpTarget;

  try {
    if (target === 'print') {
      const config = toMcpConfig(buildMcpServers(parsed.hopPath));
      process.stdout.write(JSON.stringify(config, null, 2) + '\n');
      return 0;
    }
    if (target === 'codex') {
      process.stdout.write(renderCodexToml(buildMcpServers(parsed.hopPath)) + '\n');
      return 0;
    }
    const report = registerMcpServers({
      hopPath: parsed.hopPath,
      projectDir: parsed.projectDir ?? process.cwd(),
      target,
      force: parsed.force,
      dryRun: parsed.dryRun,
    });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 0;
  } catch (err) {
    process.stdout.write(
      JSON.stringify(
        { ok: false, error: { code: 'MCP_REGISTER_ERROR', message: err instanceof Error ? err.message : String(err) } },
        null,
        2,
      ) + '\n',
    );
    return 1;
  }
}
