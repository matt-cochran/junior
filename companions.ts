// ---------------------------------------------------------------------------
// Companion tools: the npm-published FMECA, CPM Planner and jevitate CLIs and
// the agent skills each one ships.
//
// Junior's own delegated runs use the checksum-verified managed binaries in
// `~/.junior/tools` (see installer.ts). The companions are the same tools as
// global npm packages: they give the manager's agent (Claude Code, Codex, ...)
// the tools' own skills and an MCP server it can register for interactive use.
//
// Design rules:
//   • Inspection is offline unless `checkUpdates` is requested; the update
//     check is a read-only `npm view <pkg> version`.
//   • Installs use npm argv (no shell) at the `latest` dist-tag and only touch
//     a companion that is missing, or outdated when `update` is requested.
//   • Skills are installed by each tool's own installer so their files and
//     user-edit protection stay owned upstream. FMECA and CPM MCP servers are
//     never registered here; jevitate's own init registers its MCP server.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export type CompanionId = 'fmeca' | 'cpm' | 'jevitate' | 'triz';
export type SkillTarget = 'codex' | 'claude' | 'both' | 'none';
export type SkillScope = 'project' | 'user';

export type Companion = {
  id: CompanionId;
  package: string;
  binary: string;
  repo: string;
  /** One-line register command for interactive MCP use, printed, never run. */
  mcpRegister: string;
};

export const COMPANIONS: readonly Companion[] = [
  { id: 'fmeca', package: '@matthew-cochran/fmeca', binary: 'fmeca-mcp', repo: 'https://github.com/praxec/fmeca',
    mcpRegister: 'claude mcp add fmeca-mcp --scope user -- npx -y @matthew-cochran/fmeca' },
  { id: 'cpm', package: '@matthew-cochran/cpm', binary: 'cpm', repo: 'https://github.com/praxec/cpm-planner',
    mcpRegister: 'claude mcp add cpm-planner --scope user -- npx -y @matthew-cochran/cpm' },
  { id: 'jevitate', package: '@jevitate/cli', binary: 'jevitate', repo: 'https://github.com/matt-cochran/jevitate',
    mcpRegister: 'jevitate init --skip-keys (registers the jevitate MCP server)' },
  { id: 'triz', package: '@matthew-cochran/triz', binary: 'triz', repo: 'https://github.com/matt-cochran/triz',
    mcpRegister: 'none (CLI only)' },
];

export const COMPANION_TIMEOUT_MS = 15_000;
export const COMPANION_INSTALL_TIMEOUT_MS = 300_000;

/** True when JUNIOR_NO_INSTALL is set to `1` or `true`, disabling every
 * companion installer. Reads the injected environment when one exists,
 * otherwise the process environment. */
export function installationDisabled(env: NodeJS.ProcessEnv | undefined = process.env): boolean {
  const value = (env ?? process.env).JUNIOR_NO_INSTALL;
  return value === '1' || value === 'true';
}

export type ExecResult = { status: number | null; stdout?: string; stderr?: string; error?: string };
export type CompanionDeps = {
  env?: NodeJS.ProcessEnv;
  exec?: (command: string, args: string[], options?: { timeout?: number; env?: NodeJS.ProcessEnv; cwd?: string }) => ExecResult;
  exists?: (path: string) => boolean;
  /** Version from the installed package.json, for a CLI without `--version`. */
  packageVersion?: (executable: string, pkg: string) => string | null;
};

/** Walk up from the resolved CLI entry to the package.json named `pkg`. */
function defaultPackageVersion(executable: string, pkg: string): string | null {
  try {
    let dir = dirname(realpathSync(executable));
    for (let i = 0; i < 6; i++) {
      const file = join(dir, 'package.json');
      if (existsSync(file)) {
        const j = JSON.parse(readFileSync(file, 'utf8'));
        if (j?.name === pkg && typeof j.version === 'string') return j.version;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch { /* an unreadable install simply has no known version */ }
  return null;
}

function defaultExec(command: string, args: string[], options: { timeout?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {}): ExecResult {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: options.timeout, env: options.env, cwd: options.cwd, shell: false });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error?.message };
}

function run(deps: CompanionDeps, command: string, args: string[], timeout: number, cwd?: string): ExecResult {
  return (deps.exec ?? defaultExec)(command, args, { timeout, env: deps.env ?? process.env, ...(cwd ? { cwd } : {}) });
}

function which(deps: CompanionDeps, name: string): string | null {
  const env = deps.env ?? process.env;
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if ((deps.exists ?? existsSync)(candidate)) return candidate;
    }
  }
  return null;
}

function firstSemver(text: string | undefined): string | null {
  const m = String(text ?? '').match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return m ? m[0] : null;
}

/** Compare dotted versions; returns -1, 0 or 1. Pre-release tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(/[.-]/).slice(0, 3).map(Number), y = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}

/** Read-only `npm view <pkg> version`; null when npm or the registry is unavailable. */
export function latestVersion(deps: CompanionDeps, pkg: string): string | null {
  const r = run(deps, 'npm', ['view', pkg, 'version'], COMPANION_TIMEOUT_MS);
  return r.status === 0 ? firstSemver(r.stdout) : null;
}

export type CompanionStatus = {
  id: CompanionId;
  package: string;
  installed: boolean;
  executable: string | null;
  version: string | null;
  /** Present only when an update check ran; null when npm could not answer. */
  latest?: string | null;
  outdated?: boolean | null;
  mcpRegister: string;
};
export type CompanionsReport = { ready: boolean; checkedUpdates: boolean; companions: CompanionStatus[]; remediation: string[] };

/** Report which companions are on PATH and their versions; optionally compare with npm latest. */
export function inspectCompanions(deps: CompanionDeps = {}, opts: { checkUpdates?: boolean } = {}): CompanionsReport {
  const companions = COMPANIONS.map((c): CompanionStatus => {
    const executable = which(deps, c.binary);
    const version = executable
      ? firstSemver(run(deps, executable, ['--version'], COMPANION_TIMEOUT_MS).stdout) ?? (deps.packageVersion ?? defaultPackageVersion)(executable, c.package)
      : null;
    const status: CompanionStatus = { id: c.id, package: c.package, installed: executable !== null, executable, version, mcpRegister: c.mcpRegister };
    if (opts.checkUpdates) {
      const latest = latestVersion(deps, c.package);
      status.latest = latest;
      status.outdated = latest && version ? compareVersions(version, latest) < 0 : latest && !version ? true : null;
    }
    return status;
  });
  const remediation: string[] = [];
  const missing = companions.filter((c) => !c.installed).map((c) => c.package);
  const outdated = companions.filter((c) => c.outdated === true).map((c) => c.package);
  if (missing.length) remediation.push(`Install the missing companion tools with \`junior init\` (or \`npm install -g ${missing.map((p) => `${p}@latest`).join(' ')}\`).`);
  if (outdated.length) remediation.push(`Update the outdated companion tools with \`junior update\` (${outdated.join(', ')}).`);
  return { ready: missing.length === 0, checkedUpdates: !!opts.checkUpdates, companions, remediation };
}

export type CompanionInstallOutcome = {
  id: CompanionId;
  status: 'installed' | 'updated' | 'current' | 'failed' | 'skipped';
  command?: string[];
  version?: string | null;
  detail?: string;
  error?: string;
};
export type CompanionInstallReport = { ok: boolean; outcomes: CompanionInstallOutcome[] };

/** Install missing companions; with `update`, also reinstall ones behind npm latest. */
export function installCompanions(deps: CompanionDeps = {}, opts: { update?: boolean } = {}): CompanionInstallReport {
  if (installationDisabled(deps.env)) {
    return { ok: true, outcomes: COMPANIONS.map((c): CompanionInstallOutcome => ({ id: c.id, status: 'skipped', detail: 'JUNIOR_NO_INSTALL' })) };
  }
  const before = inspectCompanions(deps, { checkUpdates: !!opts.update });
  const outcomes = before.companions.map((s): CompanionInstallOutcome => {
    const needed = !s.installed || (opts.update && s.outdated === true);
    if (!needed) return { id: s.id, status: 'current', version: s.version };
    const args = ['install', '-g', '--prefer-online', `${s.package}@latest`];
    const r = run(deps, 'npm', args, COMPANION_INSTALL_TIMEOUT_MS);
    if (r.status !== 0) return { id: s.id, status: 'failed', command: ['npm', ...args], error: r.error || r.stderr || `npm install exited ${r.status}` };
    return { id: s.id, status: s.installed ? 'updated' : 'installed', command: ['npm', ...args] };
  });
  const after = inspectCompanions(deps);
  for (const o of outcomes) if (o.status !== 'failed' && o.status !== 'current') o.version = after.companions.find((c) => c.id === o.id)?.version ?? null;
  return { ok: outcomes.every((o) => o.status !== 'failed'), outcomes };
}

export type CompanionSkillResult = { id: CompanionId; status: 'installed' | 'skipped' | 'failed'; command?: string[]; detail?: string };
export type CompanionSkillReport = { ok: boolean; results: CompanionSkillResult[] };

/** The skill-install argv for one companion, or null when it does not apply. */
function skillArgs(id: CompanionId, target: Exclude<SkillTarget, 'none'>, scope: SkillScope, cwd: string): string[] {
  if (id === 'jevitate') {
    const targets = target === 'both' ? 'claude-code,codex' : target === 'claude' ? 'claude-code' : 'codex';
    return ['init', '--json', '--skip-keys', '--skip-project', '--targets', targets];
  }
  const t = target === 'both' ? 'all' : target;
  return ['skills', 'install', '--target', t, ...(scope === 'user' ? ['--user'] : ['--project', cwd])];
}

/** Install each installed companion's agent skills with its own installer. */
export function installCompanionSkills(
  deps: CompanionDeps,
  opts: { target: SkillTarget; scope: SkillScope; cwd: string },
): CompanionSkillReport {
  if (opts.target === 'none') return { ok: true, results: [] };
  if (installationDisabled(deps.env)) {
    return { ok: true, results: COMPANIONS.map((c): CompanionSkillResult => ({ id: c.id, status: 'skipped', detail: 'JUNIOR_NO_INSTALL' })) };
  }
  const target = opts.target;
  const results = COMPANIONS.map((c): CompanionSkillResult => {
    const executable = which(deps, c.binary);
    if (!executable) return { id: c.id, status: 'skipped', detail: `${c.binary} is not on PATH` };
    if (c.id === 'triz') {
      const help = run(deps, executable, ['--help'], COMPANION_TIMEOUT_MS, opts.cwd);
      if (!/\bskills\b/.test(`${help.stdout ?? ''}\n${help.stderr ?? ''}`)) {
        return { id: c.id, status: 'skipped', detail: 'triz does not ship agent skills yet' };
      }
    }
    const args = skillArgs(c.id, target, opts.scope, opts.cwd);
    const r = run(deps, executable, args, COMPANION_INSTALL_TIMEOUT_MS, opts.cwd);
    if (r.status !== 0) return { id: c.id, status: 'failed', command: [c.binary, ...args], detail: (r.error || r.stderr || `exited ${r.status}`).trim().slice(0, 500) };
    return { id: c.id, status: 'installed', command: [c.binary, ...args] };
  });
  return { ok: results.every((r) => r.status !== 'failed'), results };
}
