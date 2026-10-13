// ---------------------------------------------------------------------------
// `junior matrix init`: create a project's committed Crossmatrix store.
//
// Crossmatrix 0.3.0+ owns persistence through a `<project>/.crossmatrix/`
// store. This wrapper resolves the `crossmatrix-mcp` companion (PATH first,
// then the managed binary recorded in `~/.junior/tools/installed.json`),
// refuses a binary older than 0.3.0, and runs `crossmatrix-mcp init --dir
// <project>` with argv (no shell). It prints `{dir, created, output}` and never
// creates the store itself.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMPANION_INSTALL_TIMEOUT_MS, COMPANION_TIMEOUT_MS, compareVersions, type ExecResult } from './companions.ts';

/** The Crossmatrix release that introduced the project store this command sets up. */
export const MIN_CROSSMATRIX_VERSION = '0.3.0';
export const CROSSMATRIX_BINARY = 'crossmatrix-mcp';
export const MATRIX_INIT_USAGE = 'Usage: junior matrix init [--dir <project>]';

export type MatrixInitDeps = {
  env?: NodeJS.ProcessEnv;
  exec?: (command: string, args: string[], options?: { timeout?: number; env?: NodeJS.ProcessEnv; cwd?: string }) => ExecResult;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  /** Managed install manifest; defaults to `~/.junior/tools/installed.json`. */
  statePath?: string;
  cwd?: string;
};

export type MatrixInitResult = {
  dir: string;
  /** Store paths this run created; `['.crossmatrix']` on first init, else empty. */
  created: string[];
  /** Raw stdout from `crossmatrix-mcp init`. */
  output: string;
};

function defaultManagedStatePath(): string {
  return join(homedir(), '.junior', 'tools', 'installed.json');
}

function defaultExec(command: string, args: string[], options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): ExecResult {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: options.timeout, env: options.env, shell: false });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error?.message };
}

function run(deps: MatrixInitDeps, command: string, args: string[], timeout: number): ExecResult {
  return (deps.exec ?? defaultExec)(command, args, { timeout, env: deps.env ?? process.env });
}

function firstSemver(text: string | undefined): string | null {
  const m = String(text ?? '').match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return m ? m[0] : null;
}

function which(deps: MatrixInitDeps, name: string): string | null {
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

/** The binary last recorded by the managed installer, when it is still present. */
function managedBinary(deps: MatrixInitDeps): string | null {
  const exists = deps.exists ?? existsSync;
  const statePath = deps.statePath ?? defaultManagedStatePath();
  if (!exists(statePath)) return null;
  try {
    const read = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
    const parsed = JSON.parse(read(statePath));
    const path = parsed?.tools?.crossmatrix?.path;
    return typeof path === 'string' && path && exists(path) ? path : null;
  } catch {
    return null;
  }
}

/** PATH first, then the managed install recorded in the installer manifest. */
function resolveBinary(deps: MatrixInitDeps): string {
  const binary = which(deps, CROSSMATRIX_BINARY) ?? managedBinary(deps);
  if (!binary) {
    throw new Error(`${CROSSMATRIX_BINARY} was not found on PATH or in the managed tools directory; run \`junior init\` to install the Crossmatrix companion.`);
  }
  return binary;
}

/** Refuse anything older than 0.3.0 so the store is never created by a legacy server. */
function requireSupportedVersion(deps: MatrixInitDeps, binary: string): string {
  const r = run(deps, binary, ['--version'], COMPANION_TIMEOUT_MS);
  const version = r.status === 0 ? firstSemver(r.stdout) : null;
  if (version === null || !meetsMinimum(version, MIN_CROSSMATRIX_VERSION)) {
    throw new Error(`crossmatrix-mcp ${version ?? 'version unknown'} is below the required ${MIN_CROSSMATRIX_VERSION}; run \`junior update\` to install a newer Crossmatrix.`);
  }
  return version;
}

/** Numeric comparison with prereleases sorting below the matching release. */
function meetsMinimum(version: string, minimum: string): boolean {
  const numeric = compareVersions(version, minimum);
  if (numeric !== 0) return numeric > 0;
  return !/-/.test(version);
}

/** Run `crossmatrix-mcp init --dir <project>` and report what it created. */
export function matrixInit(deps: MatrixInitDeps = {}, opts: { dir?: string } = {}): MatrixInitResult {
  const dir = opts.dir ?? deps.cwd ?? process.cwd();
  const binary = resolveBinary(deps);
  requireSupportedVersion(deps, binary);
  const exists = deps.exists ?? existsSync;
  const store = join(dir, '.crossmatrix');
  const hadStore = exists(store);
  const r = run(deps, binary, ['init', '--dir', dir], COMPANION_INSTALL_TIMEOUT_MS);
  if (r.status !== 0) {
    throw new Error(`crossmatrix-mcp init failed: ${(r.error || r.stderr || `exited ${r.status}`).trim().slice(0, 500)}`);
  }
  const created = !hadStore && exists(store) ? ['.crossmatrix'] : [];
  return { dir, created, output: r.stdout ?? '' };
}

export function parseMatrixInitArgs(argv: string[]): { dir?: string } {
  let dir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') {
      const value = argv[++i];
      if (value === undefined || value === '') throw new Error('Option --dir requires a value');
      dir = value;
    } else if (arg.startsWith('--dir=')) {
      const value = arg.slice('--dir='.length);
      if (!value) throw new Error('Option --dir requires a value');
      dir = value;
    } else {
      throw new Error(`Unknown option for matrix init: ${arg}`);
    }
  }
  return { dir };
}

/** CLI entry: parse, run, print `{dir, created, output}` or a clear error. */
export function runMatrixInit(argv: string[], deps: MatrixInitDeps = {}): number {
  try {
    const { dir } = parseMatrixInitArgs(argv);
    process.stdout.write(`${JSON.stringify(matrixInit(deps, { dir }), null, 2)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
