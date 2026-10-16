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
