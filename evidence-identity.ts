// Governed evidence identity for check results (#280), lane E1.
//
// A check result proves something only about the inputs it ran on. The
// identity names those inputs: the touched projects' working-tree contents,
// the check command and its filter, the dependency lockfiles and the
// toolchain. `junior land` reuses a lane's evidence only when the identity it
// recomputes on the integration worktree is equal.

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isBuildCommand } from './command-guards.ts';
import { stripCommandPrefixes } from './command-policy.ts';
import { runSync } from './spawn-sync.ts';
import type { CheckPhase, CheckTiming, EvidenceIdentity } from './worker-receipt.ts';

export interface CheckIdentityInput {
  /** Repository checkout the check ran in (the worktree for an isolated run). */
  cwd: string;
  check: { command: string; args?: string[]; cwd?: string };
  /** Files the run changed, relative to `cwd`; defaults to the Git working-tree changes. */
  touchedFiles?: string[];
  /** Injected for tests: resolves a tool's version string. */
  toolVersion?: (tool: string) => string | null;
}

const PROJECT_MARKERS = [
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
];

const LOCKFILES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'packages.lock.json',
  'global.json',
  'Directory.Packages.props',
];

const TEST_FILE = /(?:^|\/)(?:[^/]*\.(?:test|spec)\.[^/]+|test_[^/]*\.[^/]+|[^/]*(?:_test|Tests?)\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|cs|php|rs)|(?:tests?|__tests__)\/[^/]+)$/;

const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn']);

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function firstLine(value: string | null | undefined): string {
  return String(value ?? '').split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
}

function normalizePath(path: string): string {
  return path.split(sep).join('/');
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  return runSync('git', args, { cwd, env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
}

function failureReason(result: { status: number | null; stderr?: string; error?: Error }, command: string): string {
  const detail = firstLine(result.stderr) || result.error?.message || (result.status === null ? `${command} did not run` : `${command} exited ${result.status}`);
  return detail.replace(/\s+/g, ' ').trim() || `${command} failed`;
}

function hasMarker(dir: string): boolean {
  if (PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)))) return true;
  try {
    return readdirSync(dir).some((name) =>
      name.endsWith('.csproj') || name.endsWith('.fsproj') || name.startsWith('build.gradle'));
  } catch {
    return false;
  }
}

/** The nearest project directory, as a repo-relative path (`.` for the root). */
function projectFor(start: string, repositoryRoot: string): string {
  let dir = isWithin(repositoryRoot, start) ? start : repositoryRoot;
  for (;;) {
    if (hasMarker(dir) || dir === repositoryRoot) {
      const rel = normalizePath(relative(repositoryRoot, dir));
      return rel === '' ? '.' : rel;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '.';
}

function projectForFile(file: string, repositoryRoot: string): string | null {
  const absolute = resolve(file);
  if (!isWithin(repositoryRoot, absolute)) return null;
  return projectFor(dirname(absolute), repositoryRoot);
}

function parseStatusZ(stdout: string): string[] {
  const parts = stdout.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (status[0] === 'R' || status[0] === 'C') {
      const original = parts[index + 1];
      if (original) {
        paths.push(original);
        index += 1;
      }
    }
  }
  return paths;
}

function defaultTouchedFiles(cwd: string, repositoryRoot: string): string[] {
  const status = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.status !== 0) return [];
  // Porcelain paths are repository-root relative, even when Git runs in a subdirectory.
  return parseStatusZ(status.stdout).map((path) => resolve(repositoryRoot, path));
}

function firstNonOption(tokens: string[]): string | undefined {
  for (const token of tokens) {
    if (token === '--') continue;
    if (!token.startsWith('-')) return token;
  }
  return undefined;
}

function optionValue(argv: string[], option: string): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === option) {
      const value = argv[index + 1];
      if (value !== undefined && value !== '--') return value;
    }
    const prefix = `${option}=`;
    if (token.startsWith(prefix)) return token.slice(prefix.length);
  }
  return null;
}

function extractFilter(argv: string[]): string | null {
  const normalized = stripCommandPrefixes([...argv]);
  const tokens = normalized.argv;
  const values: string[] = [];
  for (const option of ['--filter', '-t', '--testNamePattern', '-k']) {
    const value = optionValue(tokens, option);
    if (value !== null) values.push(value);
  }
  for (const token of tokens) {
    if (!token.startsWith('-') && TEST_FILE.test(token)) values.push(token);
  }
  return values.length > 0 ? values.join(' ') : null;
}

function toolFor(program: string): string {
  if (['node', 'npm', 'npx', 'pnpm', 'yarn', 'tsc', 'jest', 'vitest'].includes(program)) return 'node';
  if (program === 'mvnw') return 'mvn';
  if (program === 'gradlew') return 'gradle';
  return program;
}

function defaultToolVersion(tool: string): string | null {
  const version = runSync(tool, ['--version'], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (version.status !== 0) return null;
  return firstLine(version.stdout) || null;
}

function toolchainFor(argv: string[], toolVersion: (tool: string) => string | null): string {
  const normalized = stripCommandPrefixes([...argv]);
  const program = normalized.argv.length > 0 ? basename(normalized.argv[0]) : '';
  if (!program) return 'unknown';
  const tool = toolFor(program);
  try {
    const version = firstLine(toolVersion(tool));
    if (!version) return `${tool} unknown`;
    const lowerVersion = version.toLowerCase();
    const lowerTool = tool.toLowerCase();
    return lowerVersion === lowerTool || lowerVersion.startsWith(`${lowerTool} `)
      ? version
      : `${tool} ${version}`;
  } catch {
    return `${tool} unknown`;
  }
}

function lockfileHash(repositoryRoot: string, projects: string[]): string {
  const dirs = new Set<string>(['.', ...projects]);
  const paths = new Set<string>();
  for (const dir of dirs) {
    for (const name of LOCKFILES) {
      const absolute = resolve(repositoryRoot, dir, name);
      try {
        if (statSync(absolute).isFile()) paths.add(normalizePath(relative(repositoryRoot, absolute)));
      } catch {
        // A missing lockfile is not part of the identity.
      }
    }
  }
  const lines = [...paths].sort().map((path) => {
    try {
      return `${path}:${sha256(readFileSync(resolve(repositoryRoot, path)))}`;
    } catch {
      return `${path}:unreadable`;
    }
  });
  return sha256(lines.join('\n'));
}

function treeHashes(repositoryRoot: string, projects: string[]): string | null {
  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'junior-evidence-index-'));
    const env = { ...process.env, GIT_INDEX_FILE: join(tempDir, 'index') };
    const read = git(repositoryRoot, ['read-tree', 'HEAD'], env);
    if (read.status !== 0) return `unknown:${failureReason(read, 'git read-tree HEAD')}`;

    for (const project of projects) {
      const add = git(repositoryRoot, ['add', '-A', '--', project], env);
      if (add.status !== 0) return `unknown:${failureReason(add, `git add ${project}`)}`;
    }

    const write = git(repositoryRoot, ['write-tree'], env);
    if (write.status !== 0) return `unknown:${failureReason(write, 'git write-tree')}`;
    const tree = firstLine(write.stdout);
    if (!tree) return 'unknown:git write-tree produced no tree';

    const entries: string[] = [];
    for (const project of projects) {
      const rev = project === '.'
        ? { status: 0, stdout: tree, stderr: '', error: undefined }
        : git(repositoryRoot, ['rev-parse', `${tree}:${project}`], env);
      if (rev.status !== 0) return `unknown:${failureReason(rev, `git rev-parse ${project}`)}`;
      const projectTree = firstLine(rev.stdout);
      if (!projectTree) return `unknown:git rev-parse ${project} produced no tree`;
      entries.push(`${project}:${projectTree}`);
    }
    entries.sort();
    return sha256(entries.join('\n'));
  } catch (error) {
    return `unknown:${firstLine(error instanceof Error ? error.message : String(error)) || 'git failure'}`;
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // The temporary index is best-effort cleanup; it never affects identity.
      }
    }
  }
}

/** Compute the identity of one check. Never throws: on a git error the tree is `unknown:<reason>`, which never equals anything. */
export function checkIdentity(input: CheckIdentityInput): EvidenceIdentity | null {
  const argv = [input.check.command, ...(input.check.args ?? [])];
  const command = argv.join(' ');
  const filter = extractFilter(argv);
  const version = input.toolVersion ?? ((tool: string) => defaultToolVersion(tool));
  let repositoryRoot = resolve(input.cwd);
  let rootFailure: string | null = null;

  try {
    const root = git(repositoryRoot, ['rev-parse', '--show-toplevel']);
    const discovered = firstLine(root.stdout);
    if (root.status === 0 && discovered) {
      repositoryRoot = resolve(discovered);
    } else {
      rootFailure = failureReason(root, 'git rev-parse --show-toplevel');
    }
  } catch (error) {
    rootFailure = firstLine(error instanceof Error ? error.message : String(error)) || 'git failure';
  }

  let touchedFiles: string[];
  try {
    touchedFiles = input.touchedFiles ?? defaultTouchedFiles(input.cwd, repositoryRoot);
  } catch {
    touchedFiles = [];
  }

  let projects: string[];
  try {
    const projectSet = new Set<string>();
    for (const file of touchedFiles) {
      const project = projectForFile(resolve(input.cwd, file), repositoryRoot);
      if (project) projectSet.add(project);
    }
    if (projectSet.size === 0) {
      const checkCwd = resolve(input.cwd, input.check.cwd ?? '.');
      projectSet.add(projectFor(checkCwd, repositoryRoot));
    }
    projects = [...projectSet].sort();
  } catch {
    projects = ['.'];
  }

  let tree: string;
  if (rootFailure) {
    tree = `unknown:${rootFailure}`;
  } else {
    tree = treeHashes(repositoryRoot, projects) ?? 'unknown:git failure';
  }

  let dependencyLock: string;
  try {
    dependencyLock = lockfileHash(repositoryRoot, projects);
  } catch {
    dependencyLock = sha256('unavailable');
  }

  return {
    schema_version: 1,
    tree,
    projects,
    command,
    filter,
    dependencyLock,
    toolchain: toolchainFor(argv, version),
  };
}

/** True only when every field of both identities is equal and neither tree is `unknown:`. */
export function identityEqual(a: EvidenceIdentity | null | undefined, b: EvidenceIdentity | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.tree.startsWith('unknown:') || b.tree.startsWith('unknown:')) return false;
  return a.schema_version === b.schema_version
    && a.tree === b.tree
    && a.projects.length === b.projects.length
    && a.projects.every((project, index) => project === b.projects[index])
    && a.command === b.command
    && a.filter === b.filter
    && a.dependencyLock === b.dependencyLock
    && a.toolchain === b.toolchain;
}

function isTestCommand(argv: string[]): boolean {
  if (argv.length === 0) return false;
  const normalized = stripCommandPrefixes([...argv]);
  const tokens = normalized.argv;
  if (tokens.length === 0) return false;
  const program = basename(tokens[0]);
  const rest = tokens.slice(1);
  const first = firstNonOption(rest);

  if (program === 'node') return rest.includes('--test');
  if (program === 'npx') return first === 'jest' || first === 'vitest';
  if (program === 'pytest' || program === 'jest' || program === 'vitest') return true;
  if (program === 'python' || program === 'python3') {
    const moduleIndex = rest.indexOf('-m');
    return moduleIndex >= 0 && rest[moduleIndex + 1] === 'pytest';
  }
  if (program === 'dotnet' || program === 'cargo' || program === 'go') return first === 'test';
  if (program === 'mvn' || program === 'mvnw') {
    return rest.some((token) => !token.startsWith('-') && token === 'test');
  }
  if (program === 'gradle' || program === 'gradlew') {
    return rest.some((token) => !token.startsWith('-') && token === 'test');
  }
  if (SCRIPT_RUNNERS.has(program)) {
    if (rest[0] === 'run' || rest[0] === 'run-script') {
      const script = rest.slice(1).find((token) => token !== '--' && !token.startsWith('-'));
      return typeof script === 'string' && script.startsWith('test');
    }
    return first === 'test';
  }
  return false;
}

function isExplicitBuildCommand(argv: string[]): boolean {
  if (argv.length === 0) return false;
  const normalized = stripCommandPrefixes([...argv]);
  const tokens = normalized.argv;
  if (tokens.length === 0) return false;
  const program = basename(tokens[0]);
  const rest = tokens.slice(1);
  const first = firstNonOption(rest);

  if (program === 'tsc') return rest.includes('--noEmit');
  if (program === 'dotnet') return first === 'build';
  if (program === 'cargo') return first === 'check';
  return false;
}

/** Classify a check argv as build, test or other. */
export function classifyCheck(argv: string[]): CheckPhase {
  if (isBuildCommand(argv) || isExplicitBuildCommand(argv)) return 'build';
  if (isTestCommand(argv)) return 'test';
  return 'other';
}

/** Sum check durations by phase. `warm` is passed through from the run's warm-start result. */
export function checkTiming(checks: { phase?: CheckPhase; durationMs?: number }[], warm: boolean | null): CheckTiming {
  const timing: CheckTiming = { buildMs: 0, testMs: 0, otherMs: 0, warm };
  for (const check of checks) {
    const duration = typeof check.durationMs === 'number' && Number.isFinite(check.durationMs) ? check.durationMs : 0;
    if (check.phase === 'build') timing.buildMs += duration;
    else if (check.phase === 'test') timing.testMs += duration;
    else timing.otherMs += duration;
  }
  return timing;
}
