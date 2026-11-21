// Behavioral tests for doctor readiness verification and install summaries.
//
// Every scenario is offline: managed state, the Pi installation and the
// filesystem are confined to temporary fixtures. Each test asserts exactly one
// observable outcome through the public doctor or installer interface.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { inspectIntegrations, TOOL_REPOS } from './installer.ts';
import { checkPi, doctor as productionDoctor, summarizeInstall } from './setup.ts';
import { createManualClock } from './clock.ts';
import { sha, tmp, stateWith, fmecaAsset, doctorFixture } from './dependencies-helpers.test.ts';

// Doctor exercises the live admission snapshot unless a test injects one. The
// shared fixture points every live read at empty temporary roots, so no test
// reads the host /proc or ~/.junior. Tests that assert forwarding pass their
// own explicit seams to the production function directly.
const doctorStateDir = tmp('junior-doctor-state-');
const doctorProcRoot = tmp('junior-doctor-proc-');
mkdirSync(doctorProcRoot, { recursive: true });
writeFileSync(join(doctorProcRoot, 'meminfo'), 'MemAvailable: 8388608 kB\n');
writeFileSync(join(doctorProcRoot, 'vmstat'), 'pswpout 0\n');
function doctor(deps: any = {}, opts: any = {}) {
  return productionDoctor({
    ...deps,
    stateDir: deps.stateDir ?? doctorStateDir,
    procRoot: deps.procRoot ?? doctorProcRoot,
    readMounts: deps.readMounts ?? (() => ''),
  }, opts);
}

test('Doctor reports integrations readiness separately from execution readiness', async () => {
  const cwd = tmp('junior-doc-');
  const d = doctor({
    cwd,
    env: { PATH: '', HOME: cwd, PROCESSOR_ARCHITECTURE: 'x64' },
    toolsRoot: tmp('junior-doc-tools-'),
  } as any);
  assert.equal(d.integrationsReady, false);
});
test('An offline integration inspection performs no network request', async () => {
  const installRoot = tmp('junior-offline-');
  let requested = false;
  const report = inspectIntegrations({
    installRoot,
    statePath: join(installRoot, 'installed.json'),
    fetch: (async () => {
      requested = true;
      return response(500, '');
    }) as any,
  });
  assert.equal(report.ready || requested, false);
});
test('A malformed managed state is reported without throwing', () => {
  const installRoot = tmp('junior-bad-state-');
  const statePath = join(installRoot, 'installed.json');
  writeFileSync(statePath, '{not json');
  const report = inspectIntegrations({ installRoot, statePath });
  assert.equal(report.ready, false);
});
test('Doctor reports a managed binary with a mismatched digest as not usable', () => {
  const installRoot = tmp('junior-doc-digest-');
  const binaryPath = join(installRoot, 'fmeca', 'fmeca-mcp');
  mkdirSync(join(installRoot, 'fmeca'), { recursive: true });
  writeFileSync(binaryPath, 'BINARY');
  chmodSync(binaryPath, 0o755);
  const statePath = stateWith(installRoot, 'fmeca', {
    repo: TOOL_REPOS.fmeca.repo, tag: 'v1.2.3', version: '1.2.3', asset: fmecaAsset,
    assetDigest: 'sha256:' + '0'.repeat(64), binaryDigest: 'sha256:' + '0'.repeat(64),
    path: binaryPath, installedAt: new Date().toISOString(),
  });
  const report = inspectIntegrations({ installRoot, statePath });
  assert.equal(report.tools.find((t) => t.tool === 'fmeca')?.usable, false);
});
test('Doctor reports a managed binary with a matching digest and executable bit as usable', () => {
  const installRoot = tmp('junior-doc-ok-');
  const binaryPath = join(installRoot, 'fmeca', 'fmeca-mcp');
  mkdirSync(join(installRoot, 'fmeca'), { recursive: true });
  writeFileSync(binaryPath, 'BINARY');
  chmodSync(binaryPath, 0o755);
  const statePath = stateWith(installRoot, 'fmeca', {
    repo: TOOL_REPOS.fmeca.repo, tag: 'v1.2.3', version: '1.2.3', asset: fmecaAsset,
    assetDigest: 'sha256:' + '0'.repeat(64), binaryDigest: 'sha256:' + sha(Buffer.from('BINARY')),
    path: binaryPath, installedAt: new Date().toISOString(),
  });
  const report = inspectIntegrations({ installRoot, statePath });
  assert.equal(report.tools.find((t) => t.tool === 'fmeca')?.usable, true);
});
test('Doctor reports a managed binary without its executable bit as not usable', () => {
  const installRoot = tmp('junior-doc-noexec-');
  const binaryPath = join(installRoot, 'fmeca', 'fmeca-mcp');
  mkdirSync(join(installRoot, 'fmeca'), { recursive: true });
  writeFileSync(binaryPath, 'BINARY');
  chmodSync(binaryPath, 0o644);
  const statePath = stateWith(installRoot, 'fmeca', {
    repo: TOOL_REPOS.fmeca.repo, tag: 'v1.2.3', version: '1.2.3', asset: fmecaAsset,
    assetDigest: 'sha256:' + '0'.repeat(64), binaryDigest: 'sha256:' + sha(Buffer.from('BINARY')),
    path: binaryPath, installedAt: new Date().toISOString(),
  });
  const report = inspectIntegrations({ installRoot, statePath });
  assert.equal(report.tools.find((t) => t.tool === 'fmeca')?.usable, false);
});
test('Doctor reports a configured local HOP binary as usable unverified provenance', async () => {
  const cwd = tmp('junior-doc-hop-');
  const hopPath = join(cwd, '.delivery', 'setup', 'hop.json');
  const binaryPath = join(cwd, 'local', 'fmeca-mcp');
  mkdirSync(join(cwd, 'local'), { recursive: true });
  writeFileSync(binaryPath, 'LOCAL');
  chmodSync(binaryPath, 0o755);
  const tools = await import('./tools/tools.ts');
  const hop = tools.initHop(hopPath, { projectId: 'local-project' });
  hop.tools.fmeca = { command: binaryPath, args: [], env: {}, sourceVersion: '0.0.1', sourceSha: 'c'.repeat(40) };
  tools.saveHop(hopPath, hop);
  const installRoot = tmp('junior-doc-hop-root-');
  const report = inspectIntegrations({ installRoot, statePath: join(installRoot, 'installed.json'), hopPath, cwd });
  assert.equal(report.tools.find((t) => t.tool === 'fmeca')?.usable, true);
});
test('A version probe that exits 0 with a spurious EPERM reports ok with its version and isolation flags', () => {
 const cwd = tmp('junior-probe-spurious-');
 const bin = join(cwd, 'bin');
 mkdirSync(bin, { recursive: true });
 writeFileSync(join(bin, 'pi'), '#!/bin/sh\n');
 const exec = (_command: string, args: string[]) => ({
  status: 0,
  stdout: args.includes('--version') ? 'pi 1.5.2\n' : '--no-extensions --no-skills --no-context-files --no-prompt-templates --no-approve --no-mcp --tools\n',
  stderr: '',
  error: 'spawnSync pi EPERM',
 });
 const probe = checkPi({ env: { PATH: bin }, execPath: join(bin, 'node'), exec });
 assert.deepEqual({ probeStatus: probe.probeStatus, version: probe.version, supported: probe.isolation.supported, missing: probe.isolation.missing }, { probeStatus: 'ok', version: '1.5.2', supported: true, missing: [] });
});
test('A refused EPERM spawn without an exit status reports a blocked probe', () => {
 const cwd = tmp('junior-probe-refused-');
 const bin = join(cwd, 'bin');
 mkdirSync(bin, { recursive: true });
 writeFileSync(join(bin, 'pi'), '#!/bin/sh\n');
 const probe = checkPi({ env: { PATH: bin }, execPath: join(bin, 'node'), exec: () => ({ status: null, stdout: '', stderr: '', error: 'spawnSync pi EPERM' }) });
 assert.equal(probe.probeBlocked, true);
});
test('A version probe that exits non-zero with EPERM on stderr stays a blocked probe', () => {
 const cwd = tmp('junior-probe-stderr-eperm-');
 const bin = join(cwd, 'bin');
 mkdirSync(bin, { recursive: true });
 writeFileSync(join(bin, 'pi'), '#!/bin/sh\n');
 const probe = checkPi({ env: { PATH: bin }, execPath: join(bin, 'node'), exec: () => ({ status: 1, stdout: '', stderr: "Error: EPERM: operation not permitted, open '/home/u/.pi/agent/settings.json'" }) });
 assert.equal(probe.probeBlocked, true);
});
test('An EACCES spawn without an exit status is a failed probe, not a blocked one', () => {
 const cwd = tmp('junior-probe-eacces-');
 const bin = join(cwd, 'bin');
 mkdirSync(bin, { recursive: true });
 writeFileSync(join(bin, 'pi'), '#!/bin/sh\n');
 const probe = checkPi({ env: { PATH: bin }, execPath: join(bin, 'node'), exec: () => ({ status: null, stdout: '', stderr: '', error: 'spawnSync pi EACCES' }) });
 assert.deepEqual({ blocked: probe.probeBlocked, status: probe.probeStatus }, { blocked: false, status: 'failed' });
});
test('Doctor matches an installed Pi equal to the tested version', () => {
 const { deps } = doctorFixture({ installed: '1.0.3', tested: '1.0.3' });
 assert.equal(doctor(deps).pi.versionStatus, 'match');
});
test('Doctor treats a newer Pi patch as an informational difference', () => {
 const { deps } = doctorFixture({ installed: '1.0.4', tested: '1.0.3' });
 assert.equal(doctor(deps).pi.versionWarning, false);
});
test('Doctor warns on a newer Pi minor version', () => {
 const { deps } = doctorFixture({ installed: '1.1.0', tested: '1.0.3' });
 assert.equal(doctor(deps).pi.versionWarning, true);
});
test('Doctor warns when the installed Pi is older than the tested version', () => {
 const { deps } = doctorFixture({ installed: '0.9.0', tested: '1.0.3' });
 assert.equal(doctor(deps).pi.versionStatus, 'older');
});
test('Doctor reads the tested Pi version from the project config', () => {
 const { deps } = doctorFixture({ installed: '2.0.0', tested: '2.0.1' });
 assert.equal(doctor(deps).pi.testedVersion, '2.0.1');
});
test('A Pi version difference does not fail doctor', () => {
 const { deps } = doctorFixture({ installed: '2.0.0', tested: '1.0.3' });
 assert.equal(doctor(deps).ok, true);
});
test('Doctor recommends login before refreshing the catalog when unauthenticated', () => {
 const { deps } = doctorFixture({ authenticated: false, store: 'missing' });
 const remediation = doctor(deps).remediation.join('\n');
 assert.ok(remediation.indexOf('/login') < remediation.indexOf('pi update --models'));
});
test('Doctor recommends a catalog refresh for an authenticated empty store', () => {
 const { deps } = doctorFixture({ authenticated: true, store: 'empty' });
 assert.match(doctor(deps).remediation.join(' '), /pi update --models/);
});
test('Doctor recommends /model for a populated store missing the configured model', () => {
 const { deps } = doctorFixture({ authenticated: true, store: 'populated', catalogId: 'openrouter/other' });
 assert.match(doctor(deps).remediation.join(' '), /\/model/);
});
test('Doctor does not count another provider catalog as the selected provider store', () => {
 const { deps } = doctorFixture({ authenticated: true, store: 'populated', catalogProvider: 'deepseek', catalogId: 'deepseek/some-model' });
 assert.equal(doctor(deps).model.storeStatus, 'empty');
});
test('Doctor names the selected provider when its model catalog is missing', () => {
 const { deps } = doctorFixture({ authenticated: true, store: 'missing' });
 assert.match(doctor(deps).model.note ?? '', /openrouter/);
});
test('Doctor tells the user a missing catalog fills after login then refresh', () => {
 const { deps } = doctorFixture({ authenticated: true, store: 'missing' });
 assert.match(doctor(deps).model.note ?? '', /\/login[\s\S]*pi update --models/);
});
test('Doctor recommends a catalog refresh when only another provider is populated', () => {
 const { deps } = doctorFixture({ authenticated: true, store: 'populated', catalogProvider: 'deepseek', catalogId: 'deepseek/some-model' });
 assert.match(doctor(deps).remediation.join(' '), /pi update --models/);
});
test('Doctor reports a zero retained-worktree count outside a Git checkout', () => {
 const { deps } = doctorFixture();
 assert.equal(doctor(deps).retention.count, 0);
});
test('Doctor retained-worktree note explains there is nothing to prune', () => {
 const { deps } = doctorFixture();
 assert.match(doctor(deps).retention.note, /No retained worktrees/);
});
test('Install summary records a Pi attempt from the install result', () => {
 const summary = summarizeInstall({ requested: true, attempted: true, ok: true }, null);
 assert.equal(summary.pi.attempted, true);
});
test('Install summary records a tools attempt from the tools report', () => {
 const summary = summarizeInstall({ requested: true, attempted: false, ok: true }, { ok: true });
 assert.equal(summary.tools?.attempted, true);
});
test('Install summary reports a combined attempt when only tools were attempted', () => {
 const summary = summarizeInstall({ requested: true, attempted: false, ok: true }, { ok: true });
 assert.equal(summary.attempted, true);
});
test('Install summary reports a combined failure when a tools attempt fails', () => {
 const summary = summarizeInstall({ requested: true, attempted: true, ok: true }, { ok: false });
 assert.equal(summary.ok, false);
});
test('Install summary reports no attempt for a Pi-only setup without installing', () => {
 const summary = summarizeInstall(undefined, null);
 assert.equal(summary.attempted, false);
});

import { CLAUDE_STORE_DENY_RULES, RETIRED_STORE_DENY_RULES, inspectStoreDenyRules } from './harness.ts';

test('Doctor warns when a .crossmatrix store exists without Claude deny rules', () => {
 const cwd = tmp('junior-doctor-store-');
 mkdirSync(join(cwd, '.crossmatrix'), { recursive: true });
 const d = doctor({ cwd, env: { PATH:'', HOME:cwd, PROCESSOR_ARCHITECTURE:'x64' }, toolsRoot: tmp('junior-doc-store-tools-') } as any);
 assert.match(d.warnings.join(' '), /\.crossmatrix/);
});

test('Doctor reports the setup command as store-lockdown remediation', () => {
 const cwd = tmp('junior-doctor-store-fix-');
 mkdirSync(join(cwd, '.crossmatrix'), { recursive: true });
 const d = doctor({ cwd, env: { PATH:'', HOME:cwd, PROCESSOR_ARCHITECTURE:'x64' }, toolsRoot: tmp('junior-doc-store-fix-tools-') } as any);
 assert.match(d.remediation.join(' '), /junior init/);
});

test('Store lockdown inspection reports missing rules only when the store exists', () => {
 const cwd = tmp('junior-store-inspect-');
 assert.equal(inspectStoreDenyRules(cwd).storeExists, false);
});

test('Doctor warns when the Claude deny rules use retired spellings', () => {
 const cwd = tmp('junior-doctor-store-outdated-');
 mkdirSync(join(cwd, '.crossmatrix'), { recursive: true });
 mkdirSync(join(cwd, '.claude'), { recursive: true });
 writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: [RETIRED_STORE_DENY_RULES[0]] } }));
 const d = doctor({ cwd, env: { PATH:'', HOME:cwd, PROCESSOR_ARCHITECTURE:'x64' }, toolsRoot: tmp('junior-doc-store-outdated-tools-') } as any);
 assert.match(d.warnings.join(' '), /outdated/);
});

test('Doctor recommends junior init for outdated Claude deny rules', () => {
 const cwd = tmp('junior-doctor-store-outdated-fix-');
 mkdirSync(join(cwd, '.crossmatrix'), { recursive: true });
 mkdirSync(join(cwd, '.claude'), { recursive: true });
 writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: [RETIRED_STORE_DENY_RULES[0]] } }));
 const d = doctor({ cwd, env: { PATH:'', HOME:cwd, PROCESSOR_ARCHITECTURE:'x64' }, toolsRoot: tmp('junior-doc-store-outdated-fix-tools-') } as any);
 assert.match(d.remediation.join(' '), /junior init/);
});

test('Doctor reports no store-lockdown warning when the Claude deny rules are current', () => {
 const cwd = tmp('junior-doctor-store-current-');
 mkdirSync(join(cwd, '.crossmatrix'), { recursive: true });
 mkdirSync(join(cwd, '.claude'), { recursive: true });
 writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: [...CLAUDE_STORE_DENY_RULES] } }));
 const d = doctor({ cwd, env: { PATH:'', HOME:cwd, PROCESSOR_ARCHITECTURE:'x64' }, toolsRoot: tmp('junior-doc-store-current-tools-') } as any);
 assert.doesNotMatch(d.warnings.join(' '), /\.crossmatrix/);
});

test('Doctor warns when the ADR gate is proposed but not confirmed', () => {
 const { cwd, deps } = doctorFixture();
 mkdirSync(join(cwd, 'docs', 'adr'), { recursive: true });
 writeFileSync(join(cwd, 'docs', 'adr', '0001-use-a-gate.md'), '# 1. Use a gate\n\n## Status\n\nAccepted\n');
 const d = doctor(deps);
 assert.match(d.warnings.join('\n'), /ADR gate not confirmed \(running advisory\); run junior adr init --yes to confirm it/);
});

test('Doctor warns when the Junior agent instruction block is outdated', () => {
 const { cwd, deps } = doctorFixture();
 writeFileSync(join(cwd, 'CLAUDE.md'), '<junior>\nold guidance\n</junior>\n');
 const d = doctor(deps);
 assert.match(d.warnings.join('\n'), /CLAUDE\.md: the Junior <junior> block is outdated; run junior update/);
});

test('Doctor warns when the Junior agent instruction block has a tag conflict', () => {
 const { cwd, deps } = doctorFixture();
 writeFileSync(join(cwd, 'CLAUDE.md'), '<junior>\n</junior>\n<junior>\n</junior>\n');
 const d = doctor(deps);
 assert.match(d.warnings.join('\n'), /CLAUDE\.md: <junior> block conflict at lines 1, 3; fix the tags by hand/);
});

test('Doctor warns when OpenRouter has no models data policy', () => {
 const { deps } = doctorFixture();
 const d = doctor(deps);
 assert.match(d.warnings.join('\n'), /No models\.dataPolicy is set; OpenRouter may route requests to any provider and fall back between them \(see docs\/data-destination\.md\)/);
});

// Admission and cold-build advisories. Admission pressure is injected through
// the doctor's snapshot seam so no test reads the host /proc or lock state;
// cold-build history lives in a temporary `.delivery` fixture.
function admissionView(over: any = {}) {
  const base = {
    enabled: true,
    slots: { held: 0, limit: 4, holders: [] },
    pools: {},
    pressure: { availableMb: 8192, swapOutPerSec: 0, minAvailableMb: 2048, maxSwapOutPerSec: 500 },
  };
  return {
    ...base,
    ...over,
    slots: { ...base.slots, ...(over.slots ?? {}) },
    pools: over.pools ?? base.pools,
    pressure: { ...base.pressure, ...(over.pressure ?? {}) },
  };
}

function writeRun(cwd: string, id: string, stamp: number, result: any, contract?: any) {
  const dir = join(cwd, '.delivery', id, String(stamp));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result));
  if (contract) writeFileSync(join(dir, 'prompt.txt'), `Task contract (JSON):\n${JSON.stringify(contract)}`);
}

const coldBuild = (buildMs: number, warm = false) => ({
  isolation: { mode: 'worktree' },
  timing: { buildMs, testMs: 1000, otherMs: 0, warm },
});

test('Doctor forwards live admission state, proc root and clock to the snapshot reader', () => {
  const { deps } = doctorFixture();
  const clock = createManualClock(1234);
  let seen: any;
  doctor({
    ...deps,
    stateDir: '/fixture/state',
    procRoot: '/fixture/proc',
    clock,
    admissionSnapshot: (opts: any) => {
      seen = opts;
      return admissionView();
    },
  } as any);
  assert.deepEqual({ stateDir: seen.stateDir, procRoot: seen.procRoot, clock: seen.clock }, { stateDir: '/fixture/state', procRoot: '/fixture/proc', clock });
});

test('Doctor defaults live admission state to JUNIOR_STATE_DIR from the injected environment', () => {
  const { deps } = doctorFixture();
  const envState = tmp('junior-doctor-env-state-');
  let seen: any;
  productionDoctor({
    ...deps,
    env: { ...deps.env, JUNIOR_STATE_DIR: envState },
    procRoot: '/fixture/proc',
    admissionSnapshot: (opts: any) => {
      seen = opts;
      return admissionView();
    },
  } as any);
  assert.equal(seen.stateDir, envState);
});

test('Doctor returns a complete disabled admission snapshot when the live read fails', () => {
  const { deps } = doctorFixture();
  const d = doctor({ ...deps, admissionSnapshot: () => { throw new Error('pressure unavailable'); } } as any);
  assert.deepEqual(d.admission, {
    enabled: false,
    slots: { held: 0, limit: 4, holders: [] },
    pools: {},
    pressure: { availableMb: null, swapOutPerSec: null, minAvailableMb: 2048, maxSwapOutPerSec: 500 },
  });
});

test('Doctor warns when the live admission snapshot cannot be read', () => {
  const { deps } = doctorFixture();
  const d = doctor({ ...deps, admissionSnapshot: () => { throw new Error('pressure unavailable'); } } as any);
  assert.match(d.warnings.join('\n'), /admission: could not read machine pressure \(pressure unavailable\)/);
});

test('Doctor skips admission warnings when admission is disabled', () => {
  const { deps } = doctorFixture();
  const d = doctor({
    ...deps,
    admission: admissionView({ enabled: false, slots: { held: 4, limit: 4, holders: ['A1'] }, pressure: { availableMb: 1, swapOutPerSec: 900 } }),
  } as any);
  assert.doesNotMatch(d.warnings.join('\n'), /memory pressure|swap pressure|admission slots/);
});

test('Doctor includes the admission snapshot in its output', () => {
  const { deps } = doctorFixture();
  const snapshot = admissionView({ slots: { held: 1, limit: 6, holders: ['A1'] }, pools: { dotnet: { held: 0, limit: 2, holders: [] } } });
  const d = doctor({ ...deps, admission: snapshot } as any);
  assert.deepEqual(d.admission, snapshot);
});

test('Doctor warns when available memory is below its admission threshold', () => {
  const { deps } = doctorFixture();
  const d = doctor({ ...deps, admission: admissionView({ pressure: { availableMb: 1024 } }) } as any);
  assert.match(d.warnings.join('\n'), /memory pressure: available 1024 MB < 2048 MB/);
});

test('Doctor warns when swap-out is above its admission threshold', () => {
  const { deps } = doctorFixture();
  const d = doctor({ ...deps, admission: admissionView({ pressure: { swapOutPerSec: 900 } }) } as any);
  assert.match(d.warnings.join('\n'), /swap pressure: swap-out 900\/s > 500\/s/);
});

test('Doctor warns when every admission slot is held', () => {
  const { deps } = doctorFixture();
  const d = doctor({ ...deps, admission: admissionView({ slots: { held: 4, limit: 4, holders: ['A1', 'A2', 'A3', 'A4'] } }) } as any);
  assert.match(d.warnings.join('\n'), /admission slots: all slots are held \(4\/4\)/);
});

test('Doctor does not warn about admission while pressure is within its thresholds', () => {
  const { deps } = doctorFixture();
  const d = doctor({ ...deps, admission: admissionView({ slots: { held: 3, limit: 4, holders: ['A1', 'A2', 'A3'] } }) } as any);
  assert.doesNotMatch(d.warnings.join('\n'), /memory pressure|swap pressure|admission slots/);
});

test('A pressure warning does not change doctor readiness', () => {
  const { deps } = doctorFixture();
  const d = doctor({ ...deps, admission: admissionView({ pressure: { availableMb: 512 } }) } as any);
  assert.equal(d.ok, true);
});

test('Doctor warns after three recent cold worktree builds', () => {
  const { cwd, deps } = doctorFixture();
  for (const [stamp, buildMs] of [[1, 60_000], [2, 90_000], [3, 150_000]] as const) writeRun(cwd, 'cold', stamp, coldBuild(buildMs));
  const d = doctor({ ...deps, admission: admissionView() } as any);
  assert.match(d.warnings.join('\n'), /checks build cold in worktrees \(median build 90 s\); set isolationSetup\.warmFrom/);
});

test('The cold-build warning points at the warm-start documentation', () => {
  const { cwd, deps } = doctorFixture();
  for (const stamp of [1, 2, 3]) writeRun(cwd, 'cold-docs', stamp, coldBuild(90_000));
  const d = doctor({ ...deps, admission: admissionView() } as any);
  assert.match(d.warnings.join('\n'), /docs\/runtime\.md#warm-start/);
});

test('Doctor does not warn about cold builds after only two cold worktree runs', () => {
  const { cwd, deps } = doctorFixture();
  for (const stamp of [1, 2]) writeRun(cwd, 'two-cold', stamp, coldBuild(90_000));
  const d = doctor({ ...deps, admission: admissionView() } as any);
  assert.doesNotMatch(d.warnings.join('\n'), /checks build cold in worktrees/);
});

test('Doctor does not warn about cold builds when the worktree build was warm', () => {
  const { cwd, deps } = doctorFixture();
  for (const stamp of [1, 2, 3]) writeRun(cwd, 'warm', stamp, coldBuild(90_000, true));
  const d = doctor({ ...deps, admission: admissionView() } as any);
  assert.doesNotMatch(d.warnings.join('\n'), /checks build cold in worktrees/);
});

test('Doctor does not warn about cold builds when a recent contract sets warmFrom', () => {
  const { cwd, deps } = doctorFixture();
  for (const stamp of [1, 2, 3]) writeRun(cwd, 'contracted-cold', stamp, coldBuild(90_000));
  writeRun(cwd, 'contracted-cold', 4, coldBuild(90_000), { id: 'contracted', isolationSetup: { warmFrom: { path: '../source' } } });
  const d = doctor({ ...deps, admission: admissionView() } as any);
  assert.doesNotMatch(d.warnings.join('\n'), /checks build cold in worktrees/);
});

test('Doctor does not warn about cold builds when delivery.config.json sets warmFrom', () => {
  const { cwd, deps } = doctorFixture();
  for (const stamp of [1, 2, 3]) writeRun(cwd, 'configured-cold', stamp, coldBuild(90_000));
  writeFileSync(join(cwd, 'delivery.config.json'), JSON.stringify({ isolationSetup: { warmFrom: { path: '../source' } } }));
  const d = doctor({ ...deps, admission: admissionView() } as any);
  assert.doesNotMatch(d.warnings.join('\n'), /checks build cold in worktrees/);
});

test('Doctor reads warmFrom from delivery.config.json without the injected exists seam', () => {
  const { cwd, deps } = doctorFixture();
  for (const stamp of [1, 2, 3]) writeRun(cwd, 'direct-config-cold', stamp, coldBuild(90_000));
  writeFileSync(join(cwd, 'delivery.config.json'), JSON.stringify({ isolationSetup: { warmFrom: { path: '../source' } } }));
  const d = doctor({ ...deps, exists: () => false, admission: admissionView() } as any);
  assert.doesNotMatch(d.warnings.join('\n'), /checks build cold in worktrees/);
});

test('A null warmFrom does not suppress the cold-build warning', () => {
  const { cwd, deps } = doctorFixture();
  for (const stamp of [1, 2, 3]) writeRun(cwd, 'null-warmfrom-cold', stamp, coldBuild(90_000));
  writeFileSync(join(cwd, 'delivery.config.json'), JSON.stringify({ isolationSetup: { warmFrom: null } }));
  const d = doctor({ ...deps, admission: admissionView() } as any);
  assert.match(d.warnings.join('\n'), /checks build cold in worktrees/);
});

test('Doctor only inspects the newest twenty results for cold builds', () => {
  const { cwd, deps } = doctorFixture();
  for (const stamp of [1, 2, 3]) writeRun(cwd, 'old-cold', stamp, coldBuild(90_000));
  for (let stamp = 100; stamp < 118; stamp++) writeRun(cwd, 'new-warm', stamp, coldBuild(90_000, true));
  const d = doctor({ ...deps, admission: admissionView() } as any);
  assert.doesNotMatch(d.warnings.join('\n'), /checks build cold in worktrees/);
});

test('A cold-build warning does not change doctor readiness', () => {
  const { cwd, deps } = doctorFixture();
  for (const stamp of [1, 2, 3]) writeRun(cwd, 'ready-cold', stamp, coldBuild(90_000));
  const d = doctor({ ...deps, admission: admissionView() } as any);
  assert.equal(d.ok, true);
});
