// Behavioral tests for companion tool management (fmeca, cpm, jevitate npm
// packages and their agent skills).
//
// Every scenario is offline: npm, the companion CLIs and PATH are injected
// through the exec/exists seams. Nothing is installed and no network request is
// made. Each test asserts exactly one observable outcome.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import {
  COMPANIONS,
  inspectCompanions,
  installCompanions,
  installCompanionSkills,
  type CompanionDeps,
} from './companions.ts';

type Call = { command: string; args: string[] };

/** A fake world: which binaries are on PATH, their versions, and npm's latest. */
function world(opts: {
  installed?: Record<string, string>;
  latest?: Record<string, string>;
  failInstall?: boolean;
  help?: Record<string, string>;
} = {}) {
  const installed = { ...(opts.installed ?? {}) };
  const latest = opts.latest ?? {};
  const calls: Call[] = [];
  const binToPkg = Object.fromEntries(COMPANIONS.map((c) => [c.binary, c.package]));
  const deps: CompanionDeps = {
    env: { PATH: '/bin' },
    exists: (p: string) => Object.keys(installed).some((pkg) => {
      const c = COMPANIONS.find((x) => x.package === pkg);
      return c !== undefined && p === join('/bin', c.binary);
    }),
    exec: (command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === 'npm' && args[0] === 'view') {
        const v = latest[args[1]];
        return v ? { status: 0, stdout: `${v}\n` } : { status: 1, stderr: 'E404' };
      }
      if (command === 'npm' && args[0] === 'install') {
        if (opts.failInstall) return { status: 1, stderr: 'EACCES' };
        const spec = args[args.length - 1];
        const pkg = spec.slice(0, spec.lastIndexOf('@'));
        installed[pkg] = latest[pkg] ?? '9.9.9';
        return { status: 0, stdout: '' };
      }
      const bin = command.split('/').pop() as string;
      if (args[0] === '--help' && opts.help?.[bin] !== undefined) return { status: 0, stdout: opts.help[bin] };
      const pkg = binToPkg[bin];
      if (pkg && args[0] === '--version') return { status: 0, stdout: `${command} ${installed[pkg]}\n` };
      return { status: 0, stdout: '{}' };
    },
  };
  return { deps, calls };
}

const FMECA = '@matthew-cochran/fmeca';
const CPM = '@matthew-cochran/cpm';
const JEV = '@jevitate/cli';
const TRIZ = '@matthew-cochran/triz';

test('the companion catalog covers fmeca, cpm, jevitate and triz', () => {
  assert.deepEqual(COMPANIONS.map((c) => c.id), ['fmeca', 'cpm', 'jevitate', 'triz']);
});

test('inspect reports a companion missing from PATH as not installed', () => {
  const { deps } = world();
  assert.equal(inspectCompanions(deps).companions.find((c) => c.id === 'jevitate')?.installed, false);
});

test('inspect reports the version printed by the companion CLI', () => {
  const { deps } = world({ installed: { [CPM]: '0.2.2' } });
  assert.equal(inspectCompanions(deps).companions.find((c) => c.id === 'cpm')?.version, '0.2.2');
});

test('inspect is offline unless an update check is requested', () => {
  const { deps, calls } = world({ installed: { [FMECA]: '0.1.0' } });
  inspectCompanions(deps);
  assert.equal(calls.some((c) => c.command === 'npm'), false);
});

test('an update check flags a companion behind the npm latest version as outdated', () => {
  const { deps } = world({ installed: { [FMECA]: '0.1.0' }, latest: { [FMECA]: '0.2.0' } });
  assert.equal(inspectCompanions(deps, { checkUpdates: true }).companions.find((c) => c.id === 'fmeca')?.outdated, true);
});

test('an update check that cannot reach npm leaves outdated unknown rather than false', () => {
  const { deps } = world({ installed: { [FMECA]: '0.1.0' } });
  assert.equal(inspectCompanions(deps, { checkUpdates: true }).companions.find((c) => c.id === 'fmeca')?.outdated, null);
});

test('readiness requires every companion to be installed', () => {
  const { deps } = world({ installed: { [FMECA]: '0.1.0', [CPM]: '0.2.2' } });
  assert.equal(inspectCompanions(deps).ready, false);
});

test('install fetches a missing companion with npm argv at the latest tag', () => {
  const { deps, calls } = world({ installed: { [FMECA]: '0.1.0', [CPM]: '0.2.2' }, latest: { [JEV]: '0.13.0' } });
  installCompanions(deps);
  assert.deepEqual(calls.find((c) => c.command === 'npm' && c.args[0] === 'install')?.args,
    ['install', '-g', '--prefer-online', `${JEV}@latest`]);
});

test('install leaves an already-present companion alone when no update is requested', () => {
  const { deps, calls } = world({ installed: { [FMECA]: '0.1.0', [CPM]: '0.2.2', [JEV]: '0.13.0', [TRIZ]: '0.1.0' } });
  installCompanions(deps);
  assert.equal(calls.some((c) => c.command === 'npm' && c.args[0] === 'install'), false);
});

test('update reinstalls only companions behind the npm latest version', () => {
  const { deps, calls } = world({
    installed: { [FMECA]: '0.1.0', [CPM]: '0.2.2', [JEV]: '0.13.0', [TRIZ]: '0.1.0' },
    latest: { [FMECA]: '0.2.0', [CPM]: '0.2.2', [JEV]: '0.13.0', [TRIZ]: '0.1.0' },
  });
  installCompanions(deps, { update: true });
  assert.deepEqual(calls.filter((c) => c.command === 'npm' && c.args[0] === 'install').map((c) => c.args[3]), [`${FMECA}@latest`]);
});

test('a failed npm install is reported as not ok', () => {
  const { deps } = world({ failInstall: true });
  assert.equal(installCompanions(deps).ok, false);
});

test('fmeca skills install uses its own installer with the project directory', () => {
  const { deps, calls } = world({ installed: { [FMECA]: '0.1.0' } });
  installCompanionSkills(deps, { target: 'claude', scope: 'project', cwd: '/repo' });
  assert.deepEqual(calls.find((c) => c.command.endsWith('fmeca-mcp') && c.args[0] === 'skills')?.args,
    ['skills', 'install', '--target', 'claude', '--project', '/repo']);
});

test('cpm skills install targets both managers as one "all" install', () => {
  const { deps, calls } = world({ installed: { [CPM]: '0.2.2' } });
  installCompanionSkills(deps, { target: 'both', scope: 'user', cwd: '/repo' });
  assert.deepEqual(calls.find((c) => c.command.endsWith('cpm') && c.args[0] === 'skills')?.args,
    ['skills', 'install', '--target', 'all', '--user']);
});

test('jevitate skills install skips keys and project scaffolding and maps the targets', () => {
  const { deps, calls } = world({ installed: { [JEV]: '0.13.0' } });
  installCompanionSkills(deps, { target: 'both', scope: 'project', cwd: '/repo' });
  assert.deepEqual(calls.find((c) => c.command.endsWith('jevitate'))?.args,
    ['init', '--json', '--skip-keys', '--skip-project', '--targets', 'claude-code,codex']);
});

test('skill install is skipped entirely for target none', () => {
  const { deps, calls } = world({ installed: { [FMECA]: '0.1.0', [CPM]: '0.2.2', [JEV]: '0.13.0' } });
  installCompanionSkills(deps, { target: 'none', scope: 'project', cwd: '/repo' });
  assert.equal(calls.length, 0);
});

test('skill install skips a companion that is not installed', () => {
  const { deps } = world({ installed: { [FMECA]: '0.1.0' } });
  assert.equal(installCompanionSkills(deps, { target: 'claude', scope: 'project', cwd: '/repo' }).results.find((r) => r.id === 'cpm')?.status, 'skipped');
});

test('triz skill install is skipped when triz --help has no skills command', () => {
  const { deps } = world({ installed: { [TRIZ]: '0.1.0' } });
  const report = installCompanionSkills(deps, { target: 'claude', scope: 'project', cwd: '/repo' });
  assert.equal(report.results.find((r) => r.id === 'triz')?.detail, 'triz does not ship agent skills yet');
});

test('triz skill install runs its skills installer when triz --help advertises one', () => {
  const { deps, calls } = world({
    installed: { [TRIZ]: '0.1.0' },
    help: { triz: 'Usage: triz <command>\n  skills   manage agent skills\n' },
  });
  installCompanionSkills(deps, { target: 'claude', scope: 'project', cwd: '/repo' });
  assert.deepEqual(calls.find((c) => c.command.endsWith('triz') && c.args[0] === 'skills')?.args,
    ['skills', 'install', '--target', 'claude', '--project', '/repo']);
});

test('inspect falls back to the installed package version when the CLI has no --version', () => {
  const { deps } = world({ installed: { '@matthew-cochran/triz': '' } });
  deps.packageVersion = (_executable: string, pkg: string) => (pkg === '@matthew-cochran/triz' ? '0.2.1' : null);
  assert.equal(inspectCompanions(deps).companions.find((c) => c.id === 'triz')?.version, '0.2.1');
});

// --- JUNIOR_NO_INSTALL guard (issue #28) -------------------------------------

test('installCompanions with JUNIOR_NO_INSTALL invokes no command', () => {
  const { deps, calls } = world({ installed: { [FMECA]: '0.1.0' } });
  deps.env = { ...deps.env, JUNIOR_NO_INSTALL: '1' };
  installCompanions(deps);
  assert.equal(calls.length, 0);
});

test('installCompanions with JUNIOR_NO_INSTALL reports every companion skipped', () => {
  const { deps } = world({ installed: { [FMECA]: '0.1.0' } });
  deps.env = { ...deps.env, JUNIOR_NO_INSTALL: '1' };
  assert.deepEqual(installCompanions(deps).outcomes.map((o) => o.status), COMPANIONS.map(() => 'skipped'));
});

test('installCompanionSkills with JUNIOR_NO_INSTALL invokes no command', () => {
  const { deps, calls } = world({ installed: { [FMECA]: '0.1.0' } });
  deps.env = { ...deps.env, JUNIOR_NO_INSTALL: 'true' };
  installCompanionSkills(deps, { target: 'claude', scope: 'project', cwd: '/repo' });
  assert.equal(calls.length, 0);
});

test('installCompanionSkills with JUNIOR_NO_INSTALL reports every companion skipped', () => {
  const { deps } = world({ installed: { [FMECA]: '0.1.0' } });
  deps.env = { ...deps.env, JUNIOR_NO_INSTALL: '1' };
  assert.deepEqual(installCompanionSkills(deps, { target: 'claude', scope: 'project', cwd: '/repo' }).results.map((r) => r.status), COMPANIONS.map(() => 'skipped'));
});
