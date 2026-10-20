// ---------------------------------------------------------------------------
// Harness readiness for the frontier model.
//
// `junior doctor` already reports each setup surface separately (Pi auth and
// model, the Junior skill, companion skills, managed tools, MCP registration
// and the cached update summary). This module composes those read-only pieces
// into one answer for the *active harness*: is this checkout fully set up for
// Junior and every companion that harness can read?
//
// It is intentionally offline and synchronous. It never installs, never writes
// and never probes a registry: the update summary is read from the on-disk
// cache that `cachedUpdateSummary` maintains, so `doctor` stays a read-only,
// network-free command. MCP registration and updates are recommendations and
// never make the report unready; a missing Junior skill or managed tool does.
// ---------------------------------------------------------------------------

import { detectHarness, harnessSkillRoots, type Harness } from './harness.ts';
import { inspectSkill } from './setup.ts';
import { inspectCompanionSkills, COMPANIONS, type CompanionDeps } from './companions.ts';
import { inspectMcpRegistration, buildMcpServers, registerMcpServers, type McpServerEntry } from './mcp.ts';
import { inspectIntegrations, type IntegrationsResult, type InstallerDeps } from './installer.ts';
import { VERIFIED_VERSIONS } from './companion-shapes.ts';
import { updateCheckCachePath, type UpdateSummary } from './update-check.ts';
import { readFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { join, resolve, dirname, delimiter } from 'node:path';
import { ensureLocalExcludes } from './isolation.ts';

export type ReadinessItemKind = 'skill' | 'mcp' | 'tool' | 'update' | 'shape';
export type ReadinessItem = {
  id: string;
  kind: ReadinessItemKind;
  name: string;
  status: string;
  /** A required item that is not `present` makes readiness false. */
  required: boolean;
  fix?: string;
};
export type ReadinessResult = {
  harness: Harness;
  /** Environment variable names that identified the harness, never values. */
  evidence: string[];
  ready: boolean;
  items: ReadinessItem[];
  /** `junior setup` plus an explicit `--harness` when anything is fixable. */
  fixCommand?: string;
  summary: string;
};

/** Exec seam shared by the composed inspectors; tests never spawn a process. */
export type ReadinessExec = (
  command: string,
  args: string[],
  options?: { timeout?: number; env?: NodeJS.ProcessEnv; cwd?: string },
) => { status: number | null; stdout?: string; stderr?: string; error?: string };

/** Injected, read-only view. `integrations` and `updateSummary` let tests
 * exercise readiness without touching the real tools directory or network. */
export type ReadinessDeps = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean;
  readFile?: (path: string, encoding?: string) => string;
  /** Packaged skill source override; tests inject a fixture. */
  skillSource?: string;
  /** Managed prebuilt-tool root. */
  toolsRoot?: string;
  exec?: ReadinessExec;
  hopPath?: string;
  /** Pre-computed managed-tool report; defaults to `inspectIntegrations`. */
  integrations?: IntegrationsResult;
  /** Pre-read cache summary; when omitted the on-disk cache is read. */
  updateSummary?: UpdateSummary | null;
};

export type ReadinessOptions = { cwd: string; harness?: string };

function readText(deps: ReadinessDeps, path: string): string {
  return (deps.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(path, 'utf8');
}

function exists(deps: ReadinessDeps, path: string): boolean {
  return (deps.exists ?? existsSync)(path);
}

/** The one command that repairs anything fixable in this report. */
function setupCommand(harness: Harness): string {
  return harness === 'unknown' ? 'junior setup' : `junior setup --harness ${harness}`;
}

/** Map the harness to the skill-manager target whose installers write its
 * roots. Cursor reads both Claude Code and Codex skill directories. */
function harnessTarget(harness: Harness): 'claude' | 'codex' | 'both' {
  if (harness === 'claude') return 'claude';
  if (harness === 'codex') return 'codex';
  return 'both';
}

/** Combine per-root skill statuses: readable when any root is current. */
function combineSkillStatuses(statuses: string[]): 'present' | 'outdated' | 'customized' | 'missing' {
  if (statuses.some((status) => status === 'current')) return 'present';
  if (statuses.some((status) => status === 'outdated')) return 'outdated';
  if (statuses.some((status) => status === 'customized')) return 'customized';
  return 'missing';
}

/** Read the cached update summary synchronously, exactly like
 * `cachedUpdateSummary` does when its cache is fresh, but never refreshing it;
 * `plain doctor` therefore makes no network call. */
function readCachedSummary(deps: ReadinessDeps, env: NodeJS.ProcessEnv, home: string): UpdateSummary | null {
  if (deps.updateSummary !== undefined) return deps.updateSummary;
  const path = updateCheckCachePath(env, home || undefined);
  if (!exists(deps, path)) return null;
  try {
    const parsed = JSON.parse(readText(deps, path));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.outdated)) return null;
    const outdated = parsed.outdated.filter((value: unknown): value is string => typeof value === 'string');
    return { checkedAt: typeof parsed.checkedAt === 'number' ? parsed.checkedAt : 0, outdated };
  } catch {
    return null;
  }
}

function isPresent(item: ReadinessItem): boolean {
  return item.status === 'present';
}

/** Compose the existing read-only inspectors into one harness readiness report. */
export function inspectReadiness(deps: ReadinessDeps = {}, opts: ReadinessOptions): ReadinessResult {
  const env = deps.env ?? process.env;
  const cwd = opts.cwd;
  const home = deps.home ?? env.HOME ?? env.USERPROFILE ?? '';
  const detected = detectHarness(env, opts.harness);
  const roots = harnessSkillRoots(detected.harness, { cwd, home });
  const target = harnessTarget(detected.harness);
  const fix = setupCommand(detected.harness);
  const items: ReadinessItem[] = [];

  const skill = inspectSkill(deps, { target, scope: 'project', roots });
  const juniorStatus = combineSkillStatuses(skill.targets.map((entry) => entry.status));
  items.push({
    id: 'skill:junior',
    kind: 'skill',
    name: 'junior',
    status: juniorStatus,
    required: true,
    ...(juniorStatus === 'present' ? {} : { fix }),
  });

  const companionDeps: CompanionDeps = { env, exists: deps.exists, readFile: deps.readFile, exec: deps.exec };
  const companionSkills = inspectCompanionSkills(companionDeps, { target, scope: 'project', cwd, home, roots });
  for (const check of companionSkills.skills) {
    if (check.status === 'not_installed') continue;
    const status = check.status === 'present' ? 'present' : check.status;
    items.push({
      id: `skill:${check.id}`,
      kind: 'skill',
      name: check.id,
      status,
      required: true,
      ...(status === 'present' ? {} : { fix: check.remediation ?? fix }),
    });
  }

  const hopPath = deps.hopPath ?? join(cwd, '.delivery', 'setup', 'hop.json');
  const mcp = inspectMcpRegistration(detected.harness, {
    cwd,
    home,
    hopPath,
    readFile: (path: string) => readText(deps, path),
    exists: (path: string) => exists(deps, path),
  });
  for (const server of mcp.servers) {
    items.push({
      id: `mcp:${server.name}`,
      kind: 'mcp',
      name: server.name,
      status: server.status,
      required: false,
      ...(server.status === 'present' ? {} : { fix }),
    });
  }

  const integrations = deps.integrations ?? inspectIntegrations({
    env,
    cwd,
    installRoot: deps.toolsRoot,
  } as InstallerDeps);
  for (const tool of integrations.tools) {
    const status = tool.usable ? 'present' : 'missing';
    items.push({
      id: `tool:${tool.tool}`,
      kind: 'tool',
      name: tool.tool,
      status,
      required: true,
      ...(status === 'present' ? {} : { fix }),
    });
  }

  // Whether this Junior release has verified the responses of an installed
  // companion version is advisory: an unverified version never gates readiness
  // and never becomes a `junior setup` action.
  for (const tool of integrations.tools) {
    if (!tool.usable || tool.version === null) continue;
    const verified = VERIFIED_VERSIONS[tool.tool];
    if (!verified) continue;
    const status = verified.includes(tool.version) ? 'verified' : 'unverified';
    items.push({
      id: `shape:${tool.tool}`,
      kind: 'shape',
      name: tool.tool,
      status,
      required: false,
      ...(status === 'verified'
        ? {}
        : {
            fix: `Junior has not verified ${tool.tool} ${tool.version} responses; run \`junior update\` for a newer Junior, or report it with \`junior report-issue ${tool.tool}\``,
          }),
    });
  }

  const summary = readCachedSummary(deps, env, home);
  for (const name of summary?.outdated ?? []) {
    items.push({
      id: `update:${name}`,
      kind: 'update',
      name,
      status: 'available',
      required: false,
      fix,
    });
  }

  const unreadyRequired = items.filter((item) => item.required && !isPresent(item));
  const ready = unreadyRequired.length === 0;
  const fixable = items.some((item) => item.kind !== 'shape' && !isPresent(item));
  const overall = ready
    ? 'ready: the harness can use Junior and every companion'
    : `not ready: ${unreadyRequired.map((item) => item.name).join(', ')}`;
  return {
    harness: detected.harness,
    evidence: detected.evidence,
    ready,
    items,
    ...(fixable ? { fixCommand: fix } : {}),
    summary: overall,
  };
}

// ---------------------------------------------------------------------------
// `junior setup` — turn a readiness report into an ordered, previewed plan and
// apply it through each surface's own installer or CLI.
//
// Planning is pure apart from reading the HOP manifest for MCP argv. Running
// never shells out: every action is either an argv executed through the
// injected exec seam or a Junior-owned file edit (the Cursor MCP config).
// ---------------------------------------------------------------------------

export type SetupActionKind = 'tool' | 'skill' | 'mcp' | 'update';
export type SetupAction = {
  id: string;
  kind: SetupActionKind;
  description: string;
  /** argv, no shell; `null` when Junior applies the action in-process. */
  command: string[] | null;
  /** Project-relative file the action writes (Cursor MCP config). */
  writes?: string;
};

/** `juniorCommand` is the argv prefix that runs this Junior (default `junior`);
 * the CLI passes the running entry point so a source checkout works too. */
export type PlanSetupOptions = { harness?: string; hopPath?: string; cwd?: string; juniorCommand?: string[] };

/** The project's existing HOP, the same default `inspectReadiness` and
 * `inspectIntegrations` use. */
export function defaultHopPath(cwd: string): string {
  return join(cwd, '.delivery', 'setup', 'hop.json');
}

/** Cursor reads `.agents/skills`, the Codex target. */
function setupSkillTarget(harness: Harness): 'claude' | 'codex' | 'both' {
  if (harness === 'claude') return 'claude';
  if (harness === 'cursor' || harness === 'codex') return 'codex';
  return 'both';
}

function companionBinary(id: string): string {
  return COMPANIONS.find((companion) => companion.id === id)?.binary ?? id;
}

function envPairs(flag: string, env: Record<string, string>): string[] {
  const pairs: string[] = [];
  for (const key of Object.keys(env)) pairs.push(flag, `${key}=${env[key]}`);
  return pairs;
}

function mcpAddCommand(harness: 'claude' | 'codex', server: McpServerEntry): string[] {
  const head = harness === 'claude'
    ? ['claude', 'mcp', 'add', server.name, '--scope', 'project']
    : ['codex', 'mcp', 'add', server.name];
  const envFlag = harness === 'claude' ? '-e' : '--env';
  return [...head, ...envPairs(envFlag, server.env), '--', server.command, ...server.args];
}

/** Derive the ordered repair actions for one readiness report. */
export function planSetup(readiness: ReadinessResult, opts: PlanSetupOptions = {}): SetupAction[] {
  const harness = (opts.harness as Harness | undefined) ?? readiness.harness;
  const cwd = opts.cwd ?? process.cwd();
  const hopPath = opts.hopPath ? resolve(cwd, opts.hopPath) : defaultHopPath(cwd);
  const items = readiness.items;
  const juniorArgv = opts.juniorCommand?.length ? opts.juniorCommand : ['junior'];
  const actions: SetupAction[] = [];

  const missingTools = items.filter((item) => item.kind === 'tool' && item.status !== 'present').map((item) => item.name);
  if (missingTools.length) {
    actions.push({
      id: 'tool:managed',
      kind: 'tool',
      description: `install managed tools (${missingTools.join(', ')})`,
      command: [...juniorArgv, 'init', '--install'],
    });
  }

  const target = setupSkillTarget(harness);
  const junior = items.find((item) => item.id === 'skill:junior');
  if (junior && junior.status !== 'present') {
    actions.push({
      id: 'skill:junior',
      kind: 'skill',
      description: `install the Junior skill for ${harness}`,
      command: [...juniorArgv, 'init', '--target', target, '--project', '--no-install', '--no-companions'],
    });
  }
  for (const item of items) {
    if (item.kind !== 'skill' || item.id === 'skill:junior' || item.status === 'present') continue;
    actions.push({
      id: item.id,
      kind: 'skill',
      description: `install the ${item.name} companion skill`,
      command: [companionBinary(item.name), 'skills', 'install', '--target', target, '--project'],
    });
  }

  const missingMcp = items.filter((item) => item.kind === 'mcp' && item.status !== 'present');
  const jevitate = missingMcp.find((item) => item.name === 'jevitate');
  const hostServers = missingMcp.filter((item) => item.name !== 'jevitate');
  if (harness === 'claude' || harness === 'codex') {
    let servers: McpServerEntry[] = [];
    try {
      servers = buildMcpServers(hopPath);
    } catch {
      servers = [];
    }
    for (const item of hostServers) {
      const server = servers.find((entry) => entry.name === item.name);
      if (!server) continue;
      actions.push({
        id: item.id,
        kind: 'mcp',
        description: `register ${item.name} with ${harness}`,
        command: mcpAddCommand(harness, server),
      });
    }
  } else if (hostServers.length) {
    actions.push({
      id: 'mcp:cursor',
      kind: 'mcp',
      description: 'register MCP servers in .cursor/mcp.json',
      command: null,
      writes: join('.cursor', 'mcp.json'),
    });
  }
  if (jevitate) {
    actions.push({
      id: 'mcp:jevitate',
      kind: 'mcp',
      description: 'register the jevitate MCP server (jevitate init --skip-keys)',
      command: ['jevitate', 'init', '--skip-keys'],
    });
  }

  if (items.some((item) => item.kind === 'update' && item.status !== 'present')) {
    actions.push({
      id: 'update',
      kind: 'update',
      description: 'update outdated Junior components',
      command: [...juniorArgv, 'update'],
    });
  }
  return actions;
}

/** Injected seams for `runSetup`; tests inject exec, TTY state, prompts and fs. */
export type SetupDeps = {
  env?: NodeJS.ProcessEnv;
  exec?: ReadinessExec;
  exists?: (path: string) => boolean;
  readFile?: (path: string, encoding?: string) => string;
  copyFile?: (from: string, to: string) => void;
  isTTY?: boolean;
  prompt?: (question: string) => string | Promise<string>;
  stderr?: (text: string) => void;
  stdout?: (text: string) => void;
  timeoutMs?: number;
  /** Pre-computed readiness, when the caller already inspected it. */
  readiness?: ReadinessResult;
  /** Readiness probe re-run after the actions; defaults to `inspectReadiness`. */
  inspect?: (opts: { cwd: string; harness?: string; hopPath?: string }) => ReadinessResult;
  /** Cursor MCP write seam; defaults to `registerMcpServers`. */
  registerMcp?: (opts: { hopPath: string; projectDir: string }) => void;
};

export type RunSetupOptions = {
  cwd: string;
  harness?: string;
  hopPath?: string;
  yes?: boolean;
  dryRun?: boolean;
  juniorCommand?: string[];
};

export type SetupFailure = { id: string; error: string };
export type SetupSkip = { id: string; reason: string };
export type SetupReport = {
  harness: Harness;
  applied: string[];
  failed: SetupFailure[];
  skipped: SetupSkip[];
  readyBefore: boolean;
  readyAfter: boolean;
};
export type RunSetupResult = { exitCode: number; report?: SetupReport };

function defaultSetupExec(
  command: string,
  args: string[],
  options?: { timeout?: number; env?: NodeJS.ProcessEnv; cwd?: string },
): { status: number | null; stdout?: string; stderr?: string; error?: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: options?.timeout, env: options?.env, cwd: options?.cwd });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
}

async function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

/** Repo-relative untracked files, or null outside a Git checkout (a git
 * failure is treated as "not a repository" so exclusion stays silent). */
function gitUntracked(cwd: string): string[] | null {
  const r = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
}

function binaryOnPath(deps: SetupDeps, name: string): boolean {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) if (exists(join(dir, name + ext))) return true;
  }
  return false;
}

/** Render a command for the preview, showing env variable names but never
 * their values. */
function redactCommand(command: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const token = command[i];
    if ((token === '-e' || token === '--env') && i + 1 < command.length) {
      const pair = command[i + 1];
      const eq = pair.indexOf('=');
      out.push(token, eq === -1 ? pair : `${pair.slice(0, eq)}=***`);
      i++;
      continue;
    }
    out.push(token);
  }
  return out.join(' ');
}

function formatPlan(actions: SetupAction[]): string {
  return actions
    .map((action, index) => `${index + 1}. ${action.description}${action.command ? `\n   ${redactCommand(action.command)}` : ''}`)
    .join('\n');
}

/** Print the plan, confirm it, apply each action and print a JSON report. */
export async function runSetup(deps: SetupDeps = {}, opts: RunSetupOptions): Promise<RunSetupResult> {
  const stderr = deps.stderr ?? ((text: string) => { process.stderr.write(text.endsWith('\n') ? text : `${text}\n`); });
  const stdout = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const env = deps.env ?? process.env;
  const cwd = opts.cwd;
  const hopPath = opts.hopPath ? resolve(cwd, opts.hopPath) : defaultHopPath(cwd);
  const timeoutMs = deps.timeoutMs ?? 300_000;
  const exists = deps.exists ?? existsSync;
  const exec = deps.exec ?? defaultSetupExec;

  const inspect = (): ReadinessResult => deps.inspect
    ? deps.inspect({ cwd, harness: opts.harness, hopPath })
    : deps.readiness ?? inspectReadiness(
      { env: deps.env, exists: deps.exists, readFile: deps.readFile, exec: deps.exec, hopPath },
      { cwd, harness: opts.harness },
    );

  const before = deps.readiness ?? inspect();
  const actions = planSetup(before, { harness: opts.harness, hopPath, cwd, juniorCommand: opts.juniorCommand });

  if (actions.length === 0) {
    stderr('nothing to do');
    return {
      exitCode: 0,
      report: { harness: before.harness, applied: [], failed: [], skipped: [], readyBefore: before.ready, readyAfter: before.ready },
    };
  }

  stderr(formatPlan(actions));
  if (opts.dryRun) return { exitCode: 0 };

  if (!opts.yes) {
    const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
    if (!isTTY) {
      stderr(`refusing to apply ${actions.length} changes without confirmation; rerun with --yes`);
      return { exitCode: 2 };
    }
    const answer = await (deps.prompt ?? defaultPrompt)(`Apply ${actions.length} changes? [y/N] `);
    if (!/^y(es)?$/i.test(String(answer).trim())) {
      stderr('aborted; nothing changed');
      return { exitCode: 0 };
    }
  }

  const applied: string[] = [];
  const failed: SetupFailure[] = [];
  const skipped: SetupSkip[] = [];
  const copyFile = deps.copyFile ?? ((from: string, to: string) => { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); });
  const registerMcp = deps.registerMcp ?? ((write: { hopPath: string; projectDir: string }) => {
    registerMcpServers({ hopPath: write.hopPath, projectDir: write.projectDir, target: 'cursor' });
  });

  for (const action of actions) {
    if (action.command === null) {
      if (action.kind === 'mcp' && action.writes) {
        try {
          const configPath = resolve(cwd, action.writes);
          if (exists(configPath)) copyFile(configPath, `${configPath}.bak`);
          registerMcp({ hopPath, projectDir: cwd });
          applied.push(action.id);
        } catch (err) {
          failed.push({ id: action.id, error: err instanceof Error ? err.message : String(err) });
        }
      } else {
        skipped.push({ id: action.id, reason: 'no command' });
      }
      continue;
    }
    if (action.id === 'mcp:jevitate' && !binaryOnPath(deps, 'jevitate')) {
      skipped.push({ id: action.id, reason: 'jevitate is not on PATH' });
      continue;
    }
    const [command, ...args] = action.command;
    // A companion skill installer writes new skill files; record exactly the
    // paths it created in the repo-local exclude, as `junior init` does.
    const tracksSkills = action.kind === 'skill' && action.id !== 'skill:junior';
    const untrackedBefore = tracksSkills ? gitUntracked(cwd) : null;
    const result = exec(command, args, { timeout: timeoutMs, env, cwd });
    if (result.status === 0) {
      applied.push(action.id);
      if (tracksSkills && untrackedBefore) {
        const untrackedAfter = gitUntracked(cwd);
        if (untrackedAfter) {
          const created = untrackedAfter.filter((path) => !untrackedBefore.includes(path));
          if (created.length) ensureLocalExcludes(cwd, created.map((path) => `/${path}`));
        }
      }
    } else {
      failed.push({ id: action.id, error: result.error || result.stderr || `exited ${result.status}` });
    }
  }

  const after = inspect();
  const report: SetupReport = {
    harness: after.harness,
    applied,
    failed,
    skipped,
    readyBefore: before.ready,
    readyAfter: after.ready,
  };
  stdout(`${JSON.stringify(report, null, 2)}\n`);
  return { exitCode: failed.length ? 1 : 0, report };
}
