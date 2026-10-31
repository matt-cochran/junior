// ---------------------------------------------------------------------------
// Harness detection.
//
// Junior may be driven by a manager's coding agent: Claude Code, Cursor or
// Codex. Each harness exposes different environment variables and keeps its
// skills and MCP configuration in different places. This module is a pure,
// read-only description of that surface: it detects which harness is running
// from the environment (or an explicit override) and reports the skill roots
// and MCP config locations that harness reads.
//
// Nothing here touches the filesystem or the real environment on its own;
// callers inject the environment and an `exists` probe so the module stays
// testable and side-effect free.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import { join } from 'node:path';

export type Harness = 'claude' | 'cursor' | 'codex' | 'unknown';
export type KnownHarness = Exclude<Harness, 'unknown'>;

/** Injected filesystem view: a home directory and a path-existence probe. */
export type HarnessFileSystem = { home: string; exists: (path: string) => boolean };
/** Directories a harness resolves skill roots against. */
export type HarnessContext = { cwd: string; home: string };
export type DetectResult = { harness: Harness; evidence: string[] };
/** One MCP config file; `key` names the table holding the servers when the
 * format nests them (`.claude.json` under `mcpServers`, TOML under
 * `mcp_servers`). */
export type McpConfigLocation = { path: string; key?: string };
export type HarnessMcpConfig = { cli: string | null; locations: McpConfigLocation[] };

/** Detection order doubles as precedence: the first harness with a matching
 * variable wins, though every match is reported as evidence. */
const HARNESS_VARIABLES: ReadonlyArray<{ harness: KnownHarness; variables: readonly string[] }> = [
  { harness: 'claude', variables: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'] },
  { harness: 'cursor', variables: ['CURSOR_AGENT', 'CURSOR_TRACE_ID'] },
  { harness: 'codex', variables: ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID'] },
];

const KNOWN_HARNESSES: readonly KnownHarness[] = ['claude', 'cursor', 'codex'];

/** CLAUDECODE is a boolean flag (`CLAUDECODE=1`); the rest are presence
 * markers whose value is irrelevant to detection. */
function variableSet(env: NodeJS.ProcessEnv, name: string): boolean {
  if (name === 'CLAUDECODE') return env[name] === '1';
  return env[name] !== undefined;
}

/** Project-relative skill directories each harness reads, in precedence order. */
function projectSkillDirs(harness: KnownHarness): string[][] {
  if (harness === 'claude') return [['.claude', 'skills']];
  if (harness === 'codex') return [['.agents', 'skills']];
  return [['.cursor', 'skills'], ['.agents', 'skills'], ['.claude', 'skills'], ['.codex', 'skills']];
}

/** Home-relative skill directories each harness reads, in precedence order. */
function userSkillDirs(harness: KnownHarness): string[][] {
  if (harness === 'claude') return [['.claude', 'skills']];
  if (harness === 'codex') return [['.codex', 'skills'], ['.agents', 'skills']];
  return [['.cursor', 'skills'], ['.agents', 'skills'], ['.claude', 'skills'], ['.codex', 'skills']];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Detect the running harness from `env`, unless an explicit harness override
 * is supplied. Evidence lists variable names only, never their values. */
export function detectHarness(env: NodeJS.ProcessEnv = process.env, override?: string): DetectResult {
  if (override === 'claude' || override === 'cursor' || override === 'codex') {
    return { harness: override, evidence: ['override'] };
  }
  const evidence: string[] = [];
  let harness: Harness = 'unknown';
  for (const candidate of HARNESS_VARIABLES) {
    const matched = candidate.variables.filter((name) => variableSet(env, name));
    if (matched.length === 0) continue;
    if (harness === 'unknown') harness = candidate.harness;
    evidence.push(...matched);
  }
  return { harness, evidence };
}

/** Which harness home directories exist: `~/.claude`, `~/.cursor`, `~/.codex`. */
export function installedHarnesses(deps: HarnessFileSystem): KnownHarness[] {
  return KNOWN_HARNESSES.filter((harness) => deps.exists(join(deps.home, `.${harness}`)));
}

/** Ordered project and user skill roots the harness reads. `unknown` returns
 * the deduplicated union of every harness. */
export function harnessSkillRoots(harness: Harness, ctx: HarnessContext): string[] {
  const harnesses = harness === 'unknown' ? KNOWN_HARNESSES : [harness];
  const roots: string[] = [];
  for (const candidate of harnesses) {
    for (const dir of projectSkillDirs(candidate)) roots.push(join(ctx.cwd, ...dir));
  }
  for (const candidate of harnesses) {
    for (const dir of userSkillDirs(candidate)) roots.push(join(ctx.home, ...dir));
  }
  return dedupe(roots);
}

/** MCP configuration files and CLI the harness exposes. `unknown` returns the
 * deduplicated union of every harness with no CLI. */
export function harnessMcpConfig(harness: Harness, ctx: HarnessContext): HarnessMcpConfig {
  if (harness === 'claude') {
    return {
      cli: 'claude mcp',
      locations: [
        { path: join(ctx.cwd, '.mcp.json') },
        { path: join(ctx.home, '.claude.json'), key: 'mcpServers' },
      ],
    };
  }
  if (harness === 'cursor') {
    return {
      cli: null,
      locations: [
        { path: join(ctx.cwd, '.cursor', 'mcp.json') },
        { path: join(ctx.home, '.cursor', 'mcp.json') },
      ],
    };
  }
  if (harness === 'codex') {
    return {
      cli: 'codex mcp',
      locations: [{ path: join(ctx.home, '.codex', 'config.toml'), key: 'mcp_servers' }],
    };
  }
  const locations: McpConfigLocation[] = [];
  for (const candidate of KNOWN_HARNESSES) {
    for (const location of harnessMcpConfig(candidate, ctx).locations) {
      if (!locations.some((existing) => existing.path === location.path)) locations.push(location);
    }
  }
  return { cli: null, locations };
}

// ---------------------------------------------------------------------------
// Crossmatrix store lockdown.
//
// The `.crossmatrix/` store is read only through the CLI/MCP. Claude Code can
// enforce that boundary with project deny rules; the helpers below merge those
// rules idempotently into `.claude/settings.json` and inspect them for doctor.
// Codex and Cursor have no equivalent project deny list, so `junior setup`
// leaves their files alone.
// ---------------------------------------------------------------------------

/** Claude Code project deny rules that close the raw store to file tools. */
export const CLAUDE_STORE_DENY_RULES: readonly string[] = [
  'Read(./.crossmatrix/**)',
  'Edit(./.crossmatrix/**)',
  'Write(./.crossmatrix/**)',
  'Bash(cat .crossmatrix:*)',
  'Bash(grep * .crossmatrix:*)',
  'Bash(jq * .crossmatrix:*)',
];

type JsonObject = Record<string, any>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson(value: unknown): JsonObject {
  if (value === undefined || value === null) return {};
  if (!isJsonObject(value)) throw new TypeError('settings must be a JSON object');
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/** Add the store deny rules to Claude settings, preserving every existing rule.
 * The input object is never mutated and a second merge adds nothing. */
export function mergeStoreDenyRules(settings: unknown): { settings: JsonObject; changed: boolean } {
  const merged = cloneJson(settings);
  const permissions = merged.permissions === undefined ? {} : merged.permissions;
  if (!isJsonObject(permissions)) throw new TypeError('settings.permissions must be a JSON object');
  const deny = permissions.deny === undefined ? [] : permissions.deny;
  if (!Array.isArray(deny)) throw new TypeError('settings.permissions.deny must be an array');
  const missing = CLAUDE_STORE_DENY_RULES.filter((rule) => !deny.includes(rule));
  if (missing.length === 0) return { settings: merged, changed: false };
  merged.permissions = { ...permissions, deny: [...deny, ...missing] };
  return { settings: merged, changed: true };
}

export type StoreDenyFileSystem = {
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: 'utf8') => string;
  writeFileSync?: (path: string, data: string) => void;
  mkdirSync?: (path: string, options: { recursive: true }) => void;
};

/** Read-only view of the store and its Claude deny rules. A store only counts
 * when `.crossmatrix` exists; the rules only count when all are present. */
export function inspectStoreDenyRules(
  projectDir: string,
  deps: StoreDenyFileSystem = {},
): { storeExists: boolean; present: boolean; path: string } {
  const exists = deps.existsSync ?? fs.existsSync;
  const read = deps.readFileSync ?? ((path: string, encoding: 'utf8') => fs.readFileSync(path, encoding));
  const path = join(projectDir, '.claude', 'settings.json');
  const storeExists = exists(join(projectDir, '.crossmatrix'));
  if (!storeExists || !exists(path)) return { storeExists, present: false, path };
  try {
    const parsed = JSON.parse(read(path, 'utf8'));
    const deny = parsed?.permissions?.deny;
    const present = Array.isArray(deny) && CLAUDE_STORE_DENY_RULES.every((rule) => deny.includes(rule));
    return { storeExists, present, path };
  } catch {
    return { storeExists, present: false, path };
  }
}

/** Install the Claude deny rules in the project settings when a store exists.
 * A missing settings file is created; an existing one is preserved. */
export function installStoreDenyRules(options: { projectDir: string; fs?: StoreDenyFileSystem }): {
  path: string;
  changed: boolean;
} {
  if (!isJsonObject(options) || typeof options.projectDir !== 'string' || !options.projectDir.trim()) {
    throw new TypeError('projectDir must be a non-empty string');
  }
  const files: Required<StoreDenyFileSystem> = {
    existsSync: options.fs?.existsSync ?? fs.existsSync,
    readFileSync: options.fs?.readFileSync ?? ((path, encoding) => fs.readFileSync(path, encoding)),
    writeFileSync: options.fs?.writeFileSync ?? ((path, data) => fs.writeFileSync(path, data)),
    mkdirSync: options.fs?.mkdirSync ?? ((path, opts) => fs.mkdirSync(path, opts)),
  };
  const path = join(options.projectDir, '.claude', 'settings.json');
  if (!files.existsSync(join(options.projectDir, '.crossmatrix'))) return { path, changed: false };
  let parsed: unknown = {};
  if (files.existsSync(path)) {
    try {
      parsed = JSON.parse(files.readFileSync(path, 'utf8'));
    } catch {
      throw new Error(`${path}: settings file is not valid JSON`);
    }
  }
  const result = mergeStoreDenyRules(parsed);
  if (!result.changed) return { path, changed: false };
  files.mkdirSync(join(options.projectDir, '.claude'), { recursive: true });
  files.writeFileSync(path, JSON.stringify(result.settings, null, 2) + '\n');
  return { path, changed: true };
}
