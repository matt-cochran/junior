// ---------------------------------------------------------------------------
// Behavioral tests for the published npm package.
//
// The suite packs and installs the tarball once with lifecycle scripts ignored
// (so no install-time source build), then exercises the installed `junior` shim
// and the compiled CLI in external temporary working directories. Each test
// asserts exactly one observable outcome through the public package interface.
// POSIX process-group behavior is covered by the existing worker suite, which
// runs on Ubuntu; these package tests are OS-agnostic.
// ---------------------------------------------------------------------------

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = import.meta.dirname;
const NODE = process.execPath;
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const DIST_CLI = join(ROOT, 'dist', 'junior.js');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

let tmpRoot: string;
let prefix: string;
let pkgDir: string;
let binPath: string;
let binDir: string;
let packedFiles: string[];

function packMeta(): any {
  const raw = execFileSync(NPM, ['pack', '--ignore-scripts', '--json', '--pack-destination', tmpRoot], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed[0] : parsed[pkg.name];
}

before(() => {
  if (!existsSync(DIST_CLI)) execFileSync(NODE, [join(ROOT, 'scripts', 'build.mjs')], { encoding: 'utf8' });
  tmpRoot = mkdtempSync(join(tmpdir(), 'junior-pkg-'));
  const meta = packMeta();
  packedFiles = meta.files.map((f: any) => f.path);
  prefix = join(tmpRoot, 'prefix');
  execFileSync(NPM, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, join(tmpRoot, meta.filename)], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  pkgDir = join(prefix, 'node_modules', '@matt-cochran', 'junior');
  binPath = process.platform === 'win32'
    ? join(prefix, 'node_modules', '.bin', 'junior.cmd')
    : join(prefix, 'node_modules', '.bin', 'junior');
  binDir = join(tmpRoot, 'bin');
  mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') writeFileSync(join(binDir, 'node.cmd'), `@echo off\r\n"${NODE}" %*\r\n`);
  else symlinkSync(NODE, join(binDir, 'node'));
});

after(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

/** A PATH with only node on it, so the installed CLI never resolves the real
 * `pi` and doctor stays hermetic. */
function installedPath(): string {
  return process.platform === 'win32' ? `${binDir};${process.env.PATH}` : `${binDir}:/usr/bin:/bin`;
}

function runBin(args: string[], opts: any = {}) {
  const home = join(tmpRoot, 'home');
  return spawnSync(binPath, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...opts,
    env: {
      ...process.env,
      PATH: installedPath(),
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: join(tmpRoot, 'agent'),
      ...(opts.env ?? {}),
    },
  });
}

function workdir(): string {
  return mkdtempSync(join(tmpRoot, 'cwd-'));
}

function taskFile(dir: string, over: any = {}): string {
  const p = join(dir, 'task.json');
  writeFileSync(p, JSON.stringify({
    id: 'pkg-handoff',
    deliverable: 'Packaged handoff',
    cwd: dir,
    acceptance: ['The mock handoff completes'],
    isolation: 'none',
    checks: [{ command: NODE, args: ['-e', 'process.exit(0)'] }],
    ...over,
  }));
  return p;
}

// --- package metadata -------------------------------------------------------

test('The package is published under the scoped junior name', () => assert.equal(pkg.name, '@matt-cochran/junior'));
test('The package version is pinned to 0.1.0', () => assert.equal(pkg.version, '0.1.0'));
test('The package is not marked private', () => assert.notEqual(pkg.private, true));
test('The package exposes the junior bin at the compiled entry', () => assert.equal(pkg.bin.junior, 'dist/junior.js'));
test('The package supports Node 24 and newer', () => assert.equal(pkg.engines.node, '>=24'));
test('The package declares the MIT license', () => assert.equal(pkg.license, 'MIT'));
test('The package records the author contact', () => assert.equal(pkg.author.email, 'matthew@cochranweb.com'));
test('The package repository points at the GitHub project', () => assert.equal(pkg.repository.url, 'git+https://github.com/matt-cochran/junior.git'));
test('The package has no runtime npm dependencies', () => assert.deepEqual(pkg.dependencies ?? {}, {}));

// --- compiled CLI -----------------------------------------------------------

test('The compiled CLI exits successfully for --version', () => {
  assert.equal(spawnSync(NODE, [DIST_CLI, '--version'], { encoding: 'utf8' }).status, 0);
});
test('The compiled CLI prints the package version', () => {
  assert.equal(spawnSync(NODE, [DIST_CLI, '--version'], { encoding: 'utf8' }).stdout.trim(), pkg.version);
});
test('The compiled CLI exits successfully for --help', () => {
  assert.equal(spawnSync(NODE, [DIST_CLI, '--help'], { encoding: 'utf8' }).status, 0);
});
test('The compiled CLI prints concise usage for --help', () => {
  const lines = spawnSync(NODE, [DIST_CLI, '--help'], { encoding: 'utf8' }).stdout.trim().split('\n');
  assert.ok(lines.length <= 12);
});

// --- library import side effects -------------------------------------------

test('Importing the compiled worker module has no side effects', () => {
  const url = pathToFileURL(join(ROOT, 'dist', 'worker.js')).href;
  const r = spawnSync(NODE, ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`], { encoding: 'utf8' });
  assert.equal(r.stdout, '');
});
test('Importing the compiled CLI module has no side effects', () => {
  const url = pathToFileURL(DIST_CLI).href;
  const r = spawnSync(NODE, ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`], { encoding: 'utf8' });
  assert.equal(r.stdout, '');
});

// --- direct-entry guard -----------------------------------------------------

test('A symlinked CLI entry still runs the CLI', () => {
  const link = join(workdir(), 'junior');
  symlinkSync(DIST_CLI, link);
  const r = spawnSync(NODE, [link, '--version'], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), pkg.version);
});

// --- packed tarball contents ------------------------------------------------

test('The packed tarball includes the compiled CLI entry', () => assert.ok(packedFiles.includes('dist/junior.js')));
test('The packed tarball includes the packaged skill', () => assert.ok(packedFiles.includes('dist/skills/junior/SKILL.md')));
test('The packed tarball includes the license', () => assert.ok(packedFiles.includes('LICENSE')));
test('The packed tarball leaks no source, test, workspace or credential files', () => {
  const leaked = packedFiles.filter((p) =>
    p.endsWith('.ts') || p.includes('.delivery') || p.includes('.test.') ||
    p.includes('/tasks/') || p.includes('/research/') || p.includes('/logs/') ||
    p.includes('credentials') || p.includes('baseline') || p.includes('/.git/') || p.includes('node_modules'));
  assert.deepEqual(leaked, []);
});

// --- installed shim ---------------------------------------------------------

test('The installed shim runs --version successfully', () => assert.equal(runBin(['--version']).status, 0));
test('The installed shim reports the package version', () => assert.equal(runBin(['--version']).stdout.trim(), pkg.version));
test('The installed shim prints usage for --help', () => assert.match(runBin(['--help']).stdout, /^Usage: junior/));

// --- installed commands in external cwds ------------------------------------

test('The installed CLI validates a task in an external cwd', () => {
  const dir = workdir();
  assert.equal(JSON.parse(runBin(['validate', taskFile(dir)], { cwd: dir }).stdout).valid, true);
});
test('The installed CLI runs a mock handoff in an external cwd', () => {
  const dir = workdir();
  assert.equal(JSON.parse(runBin(['handoff', taskFile(dir), '--mock'], { cwd: dir }).stdout).outcome, 'simulation_passed');
});
test('The installed CLI reports status for a saved result', () => {
  const dir = workdir();
  const saved = JSON.parse(runBin(['handoff', taskFile(dir), '--mock'], { cwd: dir }).stdout);
  assert.equal(JSON.parse(runBin(['status', saved.artifacts.result], { cwd: dir }).stdout).id, 'pkg-handoff');
});
test('The installed CLI reports doctor readiness in an external cwd', () => {
  const dir = workdir();
  assert.equal(JSON.parse(runBin(['doctor'], { cwd: dir }).stdout).command, 'doctor');
});
test('The installed CLI installs the packaged skill into the target checkout', () => {
  const dir = workdir();
  runBin(['init', '--target=codex'], { cwd: dir });
  assert.ok(existsSync(join(dir, '.agents', 'skills', 'junior', 'SKILL.md')));
});
test('The installed skill manifest points at the packaged CLI', () => {
  const dir = workdir();
  runBin(['init', '--target=codex'], { cwd: dir });
  const manifest = JSON.parse(readFileSync(join(dir, '.agents', 'skills', '.junior-manifest.json'), 'utf8'));
  assert.equal(manifest.skills.junior.cli, join(pkgDir, 'dist', 'junior.js'));
});
test('Installed init never writes into the installed package', () => {
  const dir = workdir();
  runBin(['init', '--target=codex'], { cwd: dir });
  assert.ok(!existsSync(join(pkgDir, 'dist', 'skills', '.junior-manifest.json')));
});
test('The installed CLI inspects shared tool state in an external cwd', () => {
  const dir = workdir();
  const hop = join(dir, 'hop.json');
  runBin(['tools', 'init', hop], { cwd: dir });
  assert.ok(JSON.parse(runBin(['tools', 'inspect', hop], { cwd: dir }).stdout).projectId);
});

// --- release gates ----------------------------------------------------------

test('The release gate accepts a tag that matches the package version', () => {
  const r = spawnSync(NODE, [join(ROOT, 'scripts', 'verify-tag-version.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `v${pkg.version}` },
  });
  assert.equal(r.status, 0);
});
test('The release gate rejects a tag that does not match the package version', () => {
  const r = spawnSync(NODE, [join(ROOT, 'scripts', 'verify-tag-version.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v9.9.9' },
  });
  assert.equal(r.status, 1);
});
