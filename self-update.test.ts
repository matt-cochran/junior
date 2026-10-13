// ---------------------------------------------------------------------------
// Behavioral tests for `junior update` self-update.
//
// Every scenario is offline: `npm root -g`, `npm view` and `npm install` are
// injected through a scripted `exec`, the package layouts live in temporary
// directories, and no global install, network request or real npm runs. Each
// test asserts exactly one observable outcome through the public self-update
// interface.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detectInstall, checkSelfUpdate, selfUpdate } from './self-update.ts';

const PACKAGE = '@matthew-cochran/junior';

function tmp(prefix = 'junior-self-update-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write a package.json named PACKAGE plus a CLI entry, and return its URL. */
function makeInstall(root: string, version: string): string {
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: PACKAGE, version }));
  const entry = join(root, 'dist', 'junior.js');
  writeFileSync(entry, '// cli entry\n');
  return pathToFileURL(entry).href;
}

type ExecCall = { command: string; args: string[]; options?: { stdio?: string } };

/** A scripted `exec` that answers npm probes and records every command. */
function npmExec(globalRoot: string, latest: string | null, installStatus = 0, reexecStatus = 0) {
  const calls: ExecCall[] = [];
  const exec = (command: string, args: string[], options?: { stdio?: string }) => {
    calls.push({ command, args, options });
    if (command === 'npm' && args[0] === 'root' && args[1] === '-g') return { status: 0, stdout: `${globalRoot}\n` };
    if (command === 'npm' && args[0] === 'view') {
      return latest === null ? { status: 1, stderr: 'registry unavailable' } : { status: 0, stdout: `${latest}\n` };
    }
    if (command === 'npm' && args[0] === 'install') return { status: installStatus, stderr: installStatus === 0 ? '' : 'install failed' };
    return { status: reexecStatus };
  };
  return { exec, calls };
}

function globalInstall(version: string, globalRoot: string): string {
  return makeInstall(join(globalRoot, '@matthew-cochran', 'junior'), version);
}

// --- detectInstall ----------------------------------------------------------

test('detectInstall classifies a package inside the npm global root as npm-global', () => {
  const globalRoot = tmp();
  const moduleUrl = globalInstall('1.2.3', globalRoot);
  const { exec } = npmExec(globalRoot, null);
  assert.equal(detectInstall(moduleUrl, { exec }).kind, 'npm-global');
});

test('detectInstall classifies a checkout outside the npm global root as source', () => {
  const globalRoot = tmp();
  const moduleUrl = makeInstall(tmp(), '1.2.3');
  const { exec } = npmExec(globalRoot, null);
  assert.equal(detectInstall(moduleUrl, { exec }).kind, 'source');
});

test('detectInstall resolves the running package version from its package.json', () => {
  const globalRoot = tmp();
  const moduleUrl = globalInstall('3.4.5', globalRoot);
  const { exec } = npmExec(globalRoot, null);
  assert.equal(detectInstall(moduleUrl, { exec }).version, '3.4.5');
});

// --- checkSelfUpdate --------------------------------------------------------

test('checkSelfUpdate marks an older installed release outdated', () => {
  const globalRoot = tmp();
  const moduleUrl = globalInstall('1.0.0', globalRoot);
  const { exec } = npmExec(globalRoot, '2.0.0');
  assert.equal(checkSelfUpdate({ exec, moduleUrl }).outdated, true);
});

test('checkSelfUpdate reports a null latest when npm cannot answer', () => {
  const globalRoot = tmp();
  const moduleUrl = globalInstall('1.0.0', globalRoot);
  const { exec } = npmExec(globalRoot, null);
  assert.equal(checkSelfUpdate({ exec, moduleUrl }).latest, null);
});

// --- selfUpdate -------------------------------------------------------------

test('An outdated npm-global install installs the latest from npm at the latest tag', () => {
  const globalRoot = tmp();
  const moduleUrl = globalInstall('1.0.0', globalRoot);
  const { exec, calls } = npmExec(globalRoot, '2.0.0');
  selfUpdate({ argv: [], deps: { exec, moduleUrl, env: {} } });
  const install = calls.find((c) => c.command === 'npm' && c.args[0] === 'install');
  assert.deepEqual(install?.args, ['install', '-g', '--prefer-online', `${PACKAGE}@latest`]);
});

test('An outdated npm-global install re-executes the newly installed CLI with --no-self', () => {
  const globalRoot = tmp();
  const moduleUrl = globalInstall('1.0.0', globalRoot);
  const { exec, calls } = npmExec(globalRoot, '2.0.0');
  selfUpdate({ argv: ['--with-triz'], deps: { exec, moduleUrl, env: {} } });
  assert.ok(calls.some((c) => c.command === process.execPath && c.args.includes('--no-self')));
});

test('An outdated npm-global install passes the previous version to the re-executed child', () => {
  const globalRoot = tmp();
  const moduleUrl = globalInstall('1.0.0', globalRoot);
  const { exec, calls } = npmExec(globalRoot, '2.0.0');
  selfUpdate({ argv: [], deps: { exec, moduleUrl, env: {} } });
  const reexec = calls.find((c) => c.command === process.execPath);
  assert.equal(reexec?.options?.env?.JUNIOR_SELF_UPDATED, '1.0.0');
});

test('JUNIOR_SELF_UPDATED prevents a second self-update', () => {
  const globalRoot = tmp();
  const moduleUrl = globalInstall('1.0.0', globalRoot);
  const { exec, calls } = npmExec(globalRoot, '2.0.0');
  selfUpdate({ argv: [], deps: { exec, moduleUrl, env: { JUNIOR_SELF_UPDATED: '1.0.0' } } });
  assert.equal(calls.some((c) => c.command === 'npm' && c.args[0] === 'install'), false);
});

test('A re-executed child reports updated from the previous version to its own', () => {
  const globalRoot = tmp();
  const moduleUrl = globalInstall('2.0.0', globalRoot);
  const { exec } = npmExec(globalRoot, '2.0.0');
  const outcome = selfUpdate({ argv: [], deps: { exec, moduleUrl, env: { JUNIOR_SELF_UPDATED: '1.0.0' } } });
  assert.deepEqual(outcome.self, { status: 'updated', from: '1.0.0', to: '2.0.0' });
});

test('The parent exits with the re-executed child exit code', () => {
  const globalRoot = tmp();
  const moduleUrl = globalInstall('1.0.0', globalRoot);
  const { exec } = npmExec(globalRoot, '2.0.0', 0, 7);
  assert.equal(selfUpdate({ argv: [], deps: { exec, moduleUrl, env: {} } }).exitCode, 7);
});

test('JUNIOR_NO_INSTALL disables self-update', () => {
  const globalRoot = tmp();
  const moduleUrl = globalInstall('1.0.0', globalRoot);
  const { exec } = npmExec(globalRoot, '2.0.0');
  const outcome = selfUpdate({ argv: [], deps: { exec, moduleUrl, env: { JUNIOR_NO_INSTALL: '1' } } });
  assert.equal(outcome.self.status, 'disabled');
});

test('A source checkout is skipped without running npm install', () => {
  const globalRoot = tmp();
  const moduleUrl = makeInstall(tmp(), '1.0.0');
  const { exec, calls } = npmExec(globalRoot, '2.0.0');
  selfUpdate({ argv: [], deps: { exec, moduleUrl, env: {} } });
  assert.equal(calls.some((c) => c.command === 'npm' && c.args[0] === 'install'), false);
});

test('A current npm-global install reports current', () => {
  const globalRoot = tmp();
  const moduleUrl = globalInstall('1.0.0', globalRoot);
  const { exec } = npmExec(globalRoot, '1.0.0');
  assert.equal(selfUpdate({ argv: [], deps: { exec, moduleUrl, env: {} } }).self.status, 'current');
});

test('A failed npm install reports failed', () => {
  const globalRoot = tmp();
  const moduleUrl = globalInstall('1.0.0', globalRoot);
  const { exec } = npmExec(globalRoot, '2.0.0', 1);
  assert.equal(selfUpdate({ argv: [], deps: { exec, moduleUrl, env: {} } }).self.status, 'failed');
});

test('A failed npm install does not re-execute the CLI', () => {
  const globalRoot = tmp();
  const moduleUrl = globalInstall('1.0.0', globalRoot);
  const { exec, calls } = npmExec(globalRoot, '2.0.0', 1);
  selfUpdate({ argv: [], deps: { exec, moduleUrl, env: {} } });
  assert.equal(calls.some((c) => c.command === process.execPath), false);
});
