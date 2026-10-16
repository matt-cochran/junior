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
import { inspectCompanionSkills, type CompanionDeps } from './companions.ts';
import { inspectMcpRegistration } from './mcp.ts';
import { inspectIntegrations, type IntegrationsResult, type InstallerDeps } from './installer.ts';
import { updateCheckCachePath, type UpdateSummary } from './update-check.ts';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type ReadinessItemKind = 'skill' | 'mcp' | 'tool' | 'update';
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
  const fixable = items.some((item) => !isPresent(item));
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
