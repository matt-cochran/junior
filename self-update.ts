// ---------------------------------------------------------------------------
// `junior update` self-update.
//
// `junior update` must adopt a newer Junior release before it updates the
// managed tools, so the new release's own update logic runs. The running
// package is classified from its resolved real path against `npm root -g`:
// an npm-global install can reinstall and re-execute itself, while a source
// checkout is left to `git pull`.
//
// Every external effect (npm and the re-exec) goes through an injectable
// `exec`, so the behavior is testable offline and no shell or network is
// involved. The re-executed child is told `JUNIOR_SELF_UPDATED` so it never
// tries to update itself again (no loop).
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, installationDisabled } from './companions.ts';

export const JUNIOR_PACKAGE = '@matthew-cochran/junior';
export const SELF_UPDATE_CHECK_TIMEOUT_MS = 15_000;
export const SELF_UPDATE_INSTALL_TIMEOUT_MS = 300_000;

export type InstallKind = 'npm-global' | 'source';

export type ExecResult = { status: number | null; stdout?: string; stderr?: string; error?: string };
export type ExecOptions = { timeout?: number; env?: NodeJS.ProcessEnv; cwd?: string; stdio?: 'pipe' | 'inherit' };
export type SelfUpdateExec = (command: string, args: string[], options?: ExecOptions) => ExecResult;

export type SelfUpdateDeps = {
  env?: NodeJS.ProcessEnv;
  exec?: SelfUpdateExec;
  realpath?: (path: string) => string;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  /** The running CLI module URL; defaults to this module's URL. */
  moduleUrl?: string;
  timeoutMs?: number;
};

export interface InstallInfo {
  kind: InstallKind;
  version: string;
  packageRoot: string;
  /** The resolved `npm root -g`, when npm could answer; null otherwise. */
  globalRoot: string | null;
}

export interface SelfUpdateCheck {
  installed: string;
  latest: string | null;
  outdated: boolean | null;
  kind: InstallKind;
}

export interface SelfStatus {
  status: 'updated' | 'current' | 'skipped' | 'failed' | 'disabled';
  from?: string;
  to?: string;
  version?: string;
  reason?: string;
  error?: string;
}

export interface SelfUpdateOutcome {
  self: SelfStatus;
  /** Present when the parent re-executed the child and must exit with its code. */
  exitCode?: number;
}

function defaultExec(command: string, args: string[], options: ExecOptions = {}): ExecResult {
  const inherited = options.stdio === 'inherit';
  const r = spawnSync(command, args, {
    ...(inherited ? { stdio: 'inherit' as const } : { encoding: 'utf8' as const }),
    timeout: options.timeout,
    env: options.env,
    cwd: options.cwd,
    shell: false,
  });
  return {
    status: r.status,
    stdout: inherited ? undefined : (r.stdout ?? undefined),
    stderr: inherited ? undefined : (r.stderr ?? undefined),
    error: r.error?.message,
  };
}

function run(deps: SelfUpdateDeps, command: string, args: string[], timeout: number, options: ExecOptions = {}): ExecResult {
  return (deps.exec ?? defaultExec)(command, args, {
    timeout,
    env: options.env ?? deps.env ?? process.env,
    ...(options.stdio ? { stdio: options.stdio } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
}

function firstSemver(text: string | undefined): string | null {
  const m = String(text ?? '').match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return m ? m[0] : null;
}

/** True when `child` is `parent` itself or a descendant directory. */
function isInside(child: string, parent: string): boolean {
  const a = resolve(child);
  const b = resolve(parent);
  if (process.platform === 'win32') {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x === y || x.startsWith(y + sep.toLowerCase());
  }
  return a === b || a.startsWith(b + sep);
}

function npmGlobalRoot(deps: SelfUpdateDeps): string | null {
  const r = run(deps, 'npm', ['root', '-g'], deps.timeoutMs ?? SELF_UPDATE_CHECK_TIMEOUT_MS);
  if (r.status !== 0) return null;
  const raw = String(r.stdout ?? '').trim().split('\n').map((l) => l.trim()).filter(Boolean).pop();
  if (!raw) return null;
  try {
    return (deps.realpath ?? realpathSync)(raw);
  } catch {
    return raw;
  }
}

/**
 * Classify the running install from its resolved real path. The package root is
 * the nearest ancestor directory whose package.json is named for Junior; it is
 * npm-global when that root lives inside `npm root -g`, otherwise a source
 * checkout.
 */
export function detectInstall(moduleUrl: string, deps: SelfUpdateDeps = {}): InstallInfo {
  const realpath = deps.realpath ?? realpathSync;
  const exists = deps.exists ?? existsSync;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));

  const entry = fileURLToPath(moduleUrl);
  let dir: string;
  try {
    dir = dirname(realpath(entry));
  } catch {
    dir = dirname(entry);
  }

  let packageRoot: string | null = null;
  let version = '0.0.0';
  let current = dir;
  for (let i = 0; i < 8; i++) {
    const candidate = join(current, 'package.json');
    if (exists(candidate)) {
      try {
        const pkg = JSON.parse(readFile(candidate));
        if (pkg?.name === JUNIOR_PACKAGE) {
          packageRoot = current;
          if (typeof pkg.version === 'string' && pkg.version) version = pkg.version;
          break;
        }
      } catch {
        /* an unreadable package.json is not Junior's */
      }
    }
    const up = dirname(current);
    if (up === current) break;
    current = up;
  }

  const root = packageRoot ?? dir;
  const globalRoot = npmGlobalRoot(deps);
  const kind: InstallKind = globalRoot && isInside(root, globalRoot) ? 'npm-global' : 'source';
  return { kind, version, packageRoot: root, globalRoot };
}

/** Read-only `npm view <pkg> version`; null when npm or the registry is unavailable. */
function latestJuniorVersion(deps: SelfUpdateDeps): string | null {
  const r = run(deps, 'npm', ['view', JUNIOR_PACKAGE, 'version'], deps.timeoutMs ?? SELF_UPDATE_CHECK_TIMEOUT_MS);
  return r.status === 0 ? firstSemver(r.stdout) : null;
}

/** Report Junior's own installed version, npm latest and whether it is behind. */
export function checkSelfUpdate(deps: SelfUpdateDeps = {}): SelfUpdateCheck {
  const info = detectInstall(deps.moduleUrl ?? import.meta.url, deps);
  const latest = latestJuniorVersion(deps);
  const outdated = latest ? compareVersions(info.version, latest) < 0 : null;
  return { installed: info.version, latest, outdated, kind: info.kind };
}

/**
 * Self-update Junior before the tool updates run. Returns the reported `self`
 * status; when `exitCode` is present the parent has already re-executed the new
 * CLI (inheriting stdio) and the caller must stop without updating tools.
 */
export function selfUpdate(opts: { argv?: string[]; deps?: SelfUpdateDeps } = {}): SelfUpdateOutcome {
  const deps = opts.deps ?? {};
  const argv = opts.argv ?? [];
  const env = deps.env ?? process.env;
  const moduleUrl = deps.moduleUrl ?? import.meta.url;

  const info = detectInstall(moduleUrl, deps);

  // A re-executed child has already adopted the new release; never loop.
  const previous = env.JUNIOR_SELF_UPDATED;
  if (previous) {
    return { self: { status: 'updated', from: previous, to: info.version } };
  }
  if (installationDisabled(env)) {
    return { self: { status: 'disabled', reason: 'JUNIOR_NO_INSTALL' } };
  }
  if (argv.includes('--no-self')) {
    return { self: { status: 'disabled', reason: 'self-update disabled by --no-self' } };
  }
  if (info.kind !== 'npm-global') {
    return { self: { status: 'skipped', reason: 'source checkout: update with git pull' } };
  }

  const latest = latestJuniorVersion(deps);
  if (!latest) {
    return { self: { status: 'skipped', reason: 'could not resolve the latest npm version' } };
  }
  if (compareVersions(info.version, latest) >= 0) {
    return { self: { status: 'current', version: info.version } };
  }

  const install = run(deps, 'npm', ['install', '-g', '--prefer-online', `${JUNIOR_PACKAGE}@latest`], SELF_UPDATE_INSTALL_TIMEOUT_MS);
  if (install.status !== 0) {
    return { self: { status: 'failed', error: install.error || install.stderr || `npm install exited ${install.status}` } };
  }

  const childEnv = { ...env, JUNIOR_SELF_UPDATED: info.version };
  const child = run(
    deps,
    process.execPath,
    [fileURLToPath(moduleUrl), 'update', ...argv, '--no-self'],
    SELF_UPDATE_INSTALL_TIMEOUT_MS,
    { env: childEnv, stdio: 'inherit' },
  );
  return { self: { status: 'updated', from: info.version, to: latest }, exitCode: child.status ?? 1 };
}
