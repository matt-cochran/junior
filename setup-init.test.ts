import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init } from './setup-init.ts';
import { INSTALL_TIMEOUT_MS, PI_PACKAGE, TESTED_PI_VERSION } from './setup-env.ts';

type ExecCall = { command: string; args: string[]; options: any };

const HELP = [
  '--no-extensions', '--no-skills', '--no-context-files',
  '--no-prompt-templates', '--no-approve', '--no-mcp', '--tools',
].join(' ');

function fixture(initialVersion: string | null = TESTED_PI_VERSION, npmResult: { status: number; stderr?: string } = { status: 0 }) {
  const cwd = mkdtempSync(join(tmpdir(), 'delivery-init-pi-'));
  const bin = join(cwd, 'bin');
  mkdirSync(bin, { recursive: true });
  if (initialVersion) writeFileSync(join(bin, 'pi'), '#!/bin/sh\n');
  let installed = initialVersion;
  const calls: ExecCall[] = [];
  const exec = (command: string, args: string[], options: any) => {
    calls.push({ command, args, options });
    if (command === 'npm') {
      if (npmResult.status === 0) {
        installed = TESTED_PI_VERSION;
        writeFileSync(join(bin, 'pi'), '#!/bin/sh\n');
      }
      return { status: npmResult.status, stdout: '', stderr: npmResult.stderr ?? '' };
    }
    if (command === 'pi' && args.includes('--version')) return { status: 0, stdout: `pi ${installed}\n`, stderr: '' };
    if (command === 'pi' && args.includes('--help')) return { status: 0, stdout: HELP, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const deps = {
    cwd,
    env: { PATH: bin, HOME: cwd },
    execPath: join(bin, 'node'),
    nodeVersion: '26.5.0',
    exec,
  };
  const opts = { install: true, matrix: false, target: 'none' as const };
  return { cwd, calls, deps, opts, npmCalls: () => calls.filter((call) => call.command === 'npm') };
}

test('missing Pi installs the exact tested package through npm', () => {
  const f = fixture(null);
  init(f.deps, f.opts);
  assert.deepEqual(f.npmCalls()[0].args, ['install', '-g', '--ignore-scripts', `${PI_PACKAGE}@${TESTED_PI_VERSION}`]);
});

test('missing Pi install uses the bounded install timeout', () => {
  const f = fixture(null);
  init(f.deps, f.opts);
  assert.equal(f.npmCalls()[0].options.timeout, INSTALL_TIMEOUT_MS);
});

test('missing Pi install reports the installed transition', () => {
  const f = fixture(null);
  const result = init(f.deps, f.opts);
  assert.deepEqual(result.install!.pi, { from: null, to: TESTED_PI_VERSION, action: 'installed' });
});

test('missing Pi install re-runs doctor against the installed version', () => {
  const f = fixture(null);
  const result = init(f.deps, f.opts);
  assert.equal(result.pi.version, TESTED_PI_VERSION);
});

test('older installed Pi upgrades to the tested version', () => {
  const f = fixture('0.9.0');
  const result = init(f.deps, f.opts);
  assert.deepEqual(result.install!.pi, { from: '0.9.0', to: TESTED_PI_VERSION, action: 'upgraded' });
});

test('older installed Pi upgrade invokes npm with the tested spec', () => {
  const f = fixture('0.9.0');
  init(f.deps, f.opts);
  assert.deepEqual(f.npmCalls()[0].args, ['install', '-g', '--ignore-scripts', `${PI_PACKAGE}@${TESTED_PI_VERSION}`]);
});

test('older installed Pi upgrade re-runs doctor against the tested version', () => {
  const f = fixture('0.9.0');
  const result = init(f.deps, f.opts);
  assert.equal(result.pi.version, TESTED_PI_VERSION);
});

test('equal installed Pi is not reinstalled', () => {
  const f = fixture(TESTED_PI_VERSION);
  init(f.deps, f.opts);
  assert.equal(f.npmCalls().length, 0);
});

test('equal installed Pi reports the current transition', () => {
  const f = fixture(TESTED_PI_VERSION);
  const result = init(f.deps, f.opts);
  assert.deepEqual(result.install!.pi, { from: TESTED_PI_VERSION, to: TESTED_PI_VERSION, action: 'current' });
});

test('newer installed Pi is never downgraded', () => {
  const f = fixture('9.9.9');
  init(f.deps, f.opts);
  assert.equal(f.npmCalls().length, 0);
});

test('newer installed Pi reports the newer transition', () => {
  const f = fixture('9.9.9');
  const result = init(f.deps, f.opts);
  assert.deepEqual(result.install!.pi, { from: '9.9.9', to: '9.9.9', action: 'newer' });
});

test('newer installed Pi result carries a note naming both versions', () => {
  const f = fixture('9.9.9');
  const result = init(f.deps, f.opts);
  assert.match(result.install!.note!, new RegExp(`9\\.9\\.9.*${TESTED_PI_VERSION.replaceAll('.', '\\.')}`));
});

test('JUNIOR_NO_INSTALL reports a disabled Pi install', () => {
  const f = fixture('0.9.0');
  const result = init({ ...f.deps, env: { ...f.deps.env, JUNIOR_NO_INSTALL: '1' } }, f.opts);
  assert.equal(result.install!.pi.action, 'disabled');
});

test('JUNIOR_NO_INSTALL does not invoke npm for an older Pi', () => {
  const f = fixture('0.9.0');
  init({ ...f.deps, env: { ...f.deps.env, JUNIOR_NO_INSTALL: '1' } }, f.opts);
  assert.equal(f.npmCalls().length, 0);
});

test('failed older Pi upgrade reports the npm error', () => {
  const f = fixture('0.9.0', { status: 1, stderr: 'npm registry unavailable' });
  const result = init(f.deps, f.opts);
  assert.equal(result.install!.error, 'npm registry unavailable');
});

test('failed older Pi upgrade reports failure in the Pi transition', () => {
  const f = fixture('0.9.0', { status: 1, stderr: 'npm registry unavailable' });
  const result = init(f.deps, f.opts);
  assert.equal(result.install!.pi.action, 'failed');
});

test('failed older Pi upgrade leaves the old Pi in place', () => {
  const f = fixture('0.9.0', { status: 1, stderr: 'npm registry unavailable' });
  const result = init(f.deps, f.opts);
  assert.equal(result.pi.version, '0.9.0');
});

function withConfig(testedVersion: string) {
  const f = fixture(TESTED_PI_VERSION);
  writeFileSync(join(f.cwd, 'delivery.config.json'), JSON.stringify({ provider: 'openrouter', model: 'x', pi: { name: PI_PACKAGE, testedVersion }, extra: { keep: true } }, null, 2) + '\n');
  return f;
}
const readConfig = (cwd: string) => JSON.parse(readFileSync(join(cwd, 'delivery.config.json'), 'utf8'));

test('update raises an older project Pi pin to the tested version and keeps other fields', () => {
  const f = withConfig('1.0.3');
  const r = init(f.deps, { ...f.opts, command: 'update' });
  assert.deepEqual(r.piPin, { from: '1.0.3', to: TESTED_PI_VERSION, action: 'raised' });
  assert.equal(readConfig(f.cwd).pi.testedVersion, TESTED_PI_VERSION);
  assert.deepEqual(readConfig(f.cwd).extra, { keep: true });
  assert.equal(r.pi.versionStatus, 'match');
});

test('update leaves a newer project Pi pin alone', () => {
  const f = withConfig('99.0.0');
  const r = init(f.deps, { ...f.opts, command: 'update' });
  assert.deepEqual(r.piPin, { from: '99.0.0', to: '99.0.0', action: 'newer' });
  assert.equal(readConfig(f.cwd).pi.testedVersion, '99.0.0');
});

test('update reports a current project Pi pin without rewriting it', () => {
  const f = withConfig(TESTED_PI_VERSION);
  assert.deepEqual(init(f.deps, { ...f.opts, command: 'update' }).piPin, { from: TESTED_PI_VERSION, to: TESTED_PI_VERSION, action: 'current' });
});

test('plain init never rewrites an existing project Pi pin', () => {
  const f = withConfig('1.0.3');
  const r = init(f.deps, f.opts);
  assert.equal(r.piPin, undefined);
  assert.equal(readConfig(f.cwd).pi.testedVersion, '1.0.3');
});
