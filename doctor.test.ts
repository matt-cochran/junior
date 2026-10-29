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
import { doctor, summarizeInstall } from './setup.ts';
import { sha, tmp, stateWith, fmecaAsset, doctorFixture } from './dependencies-helpers.test.ts';

test('Doctor reports integrations readiness separately from execution readiness', async () => {
  const cwd = tmp('junior-doc-');
  const { doctor } = await import('./setup.ts');
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
