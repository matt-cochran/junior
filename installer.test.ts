// Behavioral tests for the prebuilt tool installer.
//
// Every scenario is offline: release metadata, archives, the filesystem and the
// binary probe are injected or confined to a temporary directory. No network
// request is made and nothing is installed globally. Each test asserts exactly
// one observable outcome through the public installer interface.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  detectPlatform,
  installTools,
  TOOL_REPOS,
  parseReleaseManifest,
  resolveLatestRelease,
  checkToolUpdates,
  TRIZ_REPO,
} from './installer.ts';
import {
  tmp,
  response,
  baseDeps,
  releaseServer,
  fmecaAsset,
  scientificAsset,
  missingScientificServer,
  allTargets,
  entryData,
  stalledBody,
  readState,
  delayedServer,
  binaryBodyFetch,
  stateWith,
  managedStateWith,
  releaseAt,
  trizWithPackage,
} from './dependencies-helpers.test.ts';

test('Linux x64 resolves the GNU tar.gz release target', () => {
  const target = detectPlatform({ platform: 'linux', arch: 'x64' });
  assert.equal(target.triple, 'x86_64-unknown-linux-gnu');
});
test('Windows ARM64 native environment overrides x64 process emulation', () => {
  const target = detectPlatform({ platform: 'win32', arch: 'x64', env: { PROCESSOR_ARCHITEW6432: 'ARM64' } });
  assert.equal(target.triple, 'aarch64-pc-windows-msvc');
});
test('Unsupported architectures fail with the supported target matrix', () => {
  assert.throws(
    () => detectPlatform({ platform: 'linux', arch: 'riscv64' }),
    (err: any) => err?.code === 'UNSUPPORTED_PLATFORM' && Array.isArray(err?.detail?.supported),
  );
});
test('An install records release provenance and the binary digest in managed state', async () => {
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
  });
  const deps = baseDeps(server);
  await installTools({ tools: ['fmeca'] }, deps);
  const state = JSON.parse(readFileSync(deps.statePath, 'utf8'));
  assert.equal(state.tools.fmeca.tag, 'v1.2.3');
});
test('A current install is idempotent and does not re-download the asset', async () => {
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
  });
  const deps = baseDeps(server);
  await installTools({ tools: ['fmeca'] }, deps);
  await installTools({ tools: ['fmeca'] }, deps);
  assert.equal(server.state.assetFetches, 1);
});
test('A newer release is reported without silently floating to it', async () => {
  const first = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('ONE') }],
  });
  const deps = baseDeps(first);
  await installTools({ tools: ['fmeca'] }, deps);
  const newer = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    tag: 'v1.2.4',
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('TWO') }],
  });
  await installTools({ tools: ['fmeca'] }, { ...deps, fetch: newer.fetch });
  assert.equal(newer.state.assetFetches, 0);
});
test('An explicit update re-downloads and adopts the current release', async () => {
  const first = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('ONE') }],
  });
  const deps = baseDeps(first);
  await installTools({ tools: ['fmeca'] }, deps);
  const newer = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    tag: 'v1.2.4',
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('TWO') }],
  });
  await installTools({ tools: ['fmeca'], update: true }, { ...deps, fetch: newer.fetch });
  assert.equal(newer.state.assetFetches, 1);
});
test('An explicit update of an unchanged managed tool performs no asset download', async () => {
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
  });
  const deps = baseDeps(server);
  await installTools({ tools: ['fmeca'] }, deps);
  await installTools({ tools: ['fmeca'], update: true }, deps);
  assert.equal(server.state.assetFetches, 1);
});
test('An explicit update of an unchanged managed tool reports changed false', async () => {
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
  });
  const deps = baseDeps(server);
  await installTools({ tools: ['fmeca'] }, deps);
  const report = await installTools({ tools: ['fmeca'], update: true }, deps);
  assert.equal(report.outcomes[0].changed, false);
});
test('An explicit update of an unchanged managed tool reinstalls a tampered binary', async () => {
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
  });
  const deps = baseDeps(server);
  await installTools({ tools: ['fmeca'] }, deps);
  const binaryPath = join(deps.installRoot, 'fmeca', 'fmeca-mcp');
  writeFileSync(binaryPath, 'TAMPERED');
  await installTools({ tools: ['fmeca'], update: true }, deps);
  assert.equal(readFileSync(binaryPath, 'utf8'), 'BINARY');
});
test('An explicit update of a managed tool with a newer release installs it', async () => {
  const first = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('ONE') }],
  });
  const deps = baseDeps(first);
  await installTools({ tools: ['fmeca'] }, deps);
  const newer = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    tag: 'v1.2.4',
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('TWO') }],
  });
  await installTools({ tools: ['fmeca'], update: true }, { ...deps, fetch: newer.fetch });
  assert.equal(readFileSync(join(deps.installRoot, 'fmeca', 'fmeca-mcp'), 'utf8'), 'TWO');
});
test('An explicit update of an unchanged optional TRIZ install performs no asset download', async () => {
  const fmeca = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
  });
  const triz = releaseServer({
    repo: 'matt-cochran/triz',
    tag: 'v0.9.0',
    assetName: 'triz-v0.9.0-node.tgz',
    entries: [{ name: 'dist/triz.js', data: entryData('export default 1') }],
  });
  const fetch = async (url: string) => (url.includes('matt-cochran/triz') ? triz.fetch(url) : fmeca.fetch(url));
  const deps = baseDeps(fmeca, { fetch, smokeTriz: async () => true });
  await installTools({ tools: ['fmeca'], withTriz: true }, deps);
  await installTools({ tools: ['fmeca'], withTriz: true, update: true }, deps);
  assert.equal(triz.state.assetFetches, 1);
});
test('A checksum mismatch fails the install', async () => {
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
    checksums: `${'0'.repeat(64)}  ${fmecaAsset}\n`,
  });
  const report = await installTools({ tools: ['fmeca'] }, baseDeps(server));
  assert.match(report.outcomes[0].error ?? '', /mismatch/i);
});
test('A release with no matching asset fails explicitly', async () => {
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
    assets: [],
  });
  const report = await installTools({ tools: ['fmeca'] }, baseDeps(server));
  assert.equal(report.outcomes[0].error, `release v1.2.3 of ${TOOL_REPOS.fmeca.repo} has no asset ${fmecaAsset}`);
});
test('A missing scientific-process release is reported unavailable', async () => {
  const report = await installTools(
    { tools: ['scientific-process'] },
    baseDeps(missingScientificServer(), { resolveRelease: async () => { throw new Error('HTTP 404'); } }),
  );
  assert.equal(report.outcomes[0].status, 'unavailable');
});
test('A missing scientific-process release does not fail the install run', async () => {
  const report = await installTools(
    { tools: ['scientific-process'] },
    baseDeps(missingScientificServer(), { resolveRelease: async () => { throw new Error('HTTP 404'); } }),
  );
  assert.equal(report.ok, true);
});
test('A scientific-process release without the platform asset is reported unavailable', async () => {
  const server = releaseServer({ repo: TOOL_REPOS['scientific-process'].repo, assetName: scientificAsset, entries: [], assets: [] });
  const report = await installTools({ tools: ['scientific-process'] }, baseDeps(server));
  assert.equal(report.outcomes[0].status, 'unavailable');
});
test('An archive entry that traverses out of the extraction root is rejected', async () => {
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: '../fmeca-mcp', data: entryData('EVIL') }],
  });
  const report = await installTools({ tools: ['fmeca'] }, baseDeps(server));
  assert.match(report.outcomes[0].error ?? '', /escapes the extraction root/i);
});
test('A symlink archive entry is rejected', async () => {
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', type: 'l', data: entryData('target') }],
  });
  const report = await installTools({ tools: ['fmeca'] }, baseDeps(server));
  assert.match(report.outcomes[0].error ?? '', /is a link/i);
});
test('A failed update preserves the previous working install', async () => {
  const first = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('WORKING') }],
  });
  const deps = baseDeps(first);
  await installTools({ tools: ['fmeca'] }, deps);
  const binaryPath = join(deps.installRoot, 'fmeca', 'fmeca-mcp');
  const before = readFileSync(binaryPath, 'utf8');
  const corrupt = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    tag: 'v1.2.4',
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BROKEN') }],
    checksums: `${'0'.repeat(64)}  ${fmecaAsset}\n`,
  });
  await installTools({ tools: ['fmeca'], update: true }, { ...deps, fetch: corrupt.fetch });
  assert.equal(readFileSync(binaryPath, 'utf8'), before);
});
test('A binary that fails its protocol probe preserves the previous install', async () => {
  const first = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('WORKING') }],
  });
  const deps = baseDeps(first);
  await installTools({ tools: ['fmeca'] }, deps);
  const binaryPath = join(deps.installRoot, 'fmeca', 'fmeca-mcp');
  const before = readFileSync(binaryPath, 'utf8');
  const newer = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    tag: 'v1.2.4',
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BADPROBE') }],
  });
  await installTools({ tools: ['fmeca'], update: true }, { ...deps, fetch: newer.fetch, probe: async () => false });
  assert.equal(readFileSync(binaryPath, 'utf8'), before);
});
test('Installing tools preserves an existing HOP project id', async () => {
  const cwd = tmp('junior-hop-');
  const hopPath = join(cwd, '.delivery', 'setup', 'hop.json');
  const tools = await import('./tools/tools.ts');
  tools.initHop(hopPath, { projectId: 'existing-project' });
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
  });
  await installTools({ tools: ['fmeca'] }, baseDeps(server, { cwd, hopPath }));
  assert.equal(tools.loadHop(hopPath).projectId, 'existing-project');
});
test('Installing tools points the HOP at the downloaded binary', async () => {
  const cwd = tmp('junior-hop-');
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
  });
  const deps = baseDeps(server, { cwd });
  await installTools({ tools: ['fmeca'] }, deps);
  const tools = await import('./tools/tools.ts');
  assert.equal(tools.loadHop(join(cwd, '.delivery', 'setup', 'hop.json')).tools.fmeca.command, join(deps.installRoot, 'fmeca', 'fmeca-mcp'));
});
test('An explicit managed tool update advances the existing HOP revision', async () => {
  const cwd = tmp('junior-hop-');
  const hopPath = join(cwd, '.delivery', 'setup', 'hop.json');
  const tools = await import('./tools/tools.ts');
  tools.initHop(hopPath, { projectId: 'existing-project' });
  const first = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData("ONE") }],
  });
  const deps = baseDeps(first, { cwd, hopPath });
  await installTools({ tools: ['fmeca'] }, deps);
  const hop = tools.loadHop(hopPath);
  hop.revision = 5;
  hop.managerAcceptance = 'accepted';
  hop.acceptedRevision = 5;
  tools.saveHop(hopPath, hop);
  const newer = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    tag: 'v1.2.4',
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('TWO') }],
  });
  await installTools({ tools: ['fmeca'], update: true }, { ...deps, fetch: newer.fetch });
  assert.equal(tools.loadHop(hopPath).revision, 6);
});
test('An absolute-path archive entry is rejected', async () => {
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: '/etc/fmeca-mcp', data: entryData('EVIL') }],
  });
  const report = await installTools({ tools: ['fmeca'] }, baseDeps(server));
  assert.match(report.outcomes[0].error ?? '', /escapes the extraction root/i);
});
test('A release with no checksum metadata fails before extraction', async () => {
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
    assets: [
      {
        name: fmecaAsset,
        browser_download_url: `https://github.com/${TOOL_REPOS.fmeca.repo}/releases/download/v1.2.3/${fmecaAsset}`,
      },
    ],
  });
  const report = await installTools({ tools: ['fmeca'] }, baseDeps(server));
  assert.match(report.outcomes[0].error ?? '', /no checksums\.sha256 asset or asset digest/i);
});
test('The optional TRIZ install resolves the portable dist/triz.js archive', async () => {
  const fmeca = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
  });
  const triz = releaseServer({
    repo: 'matt-cochran/triz',
    tag: 'v0.9.0',
    assetName: 'triz-v0.9.0-node.tgz',
    entries: [{ name: 'dist/triz.js', data: entryData('console.log(1)') }],
  });
  const fetch = async (url: string) => {
    if (url.includes('matt-cochran/triz')) return triz.fetch(url);
    return fmeca.fetch(url);
  };
  const deps = baseDeps(fmeca, { fetch });
  await installTools({ tools: ['fmeca'], withTriz: true }, deps);
  assert.equal(existsSync(join(deps.installRoot, 'triz', 'dist', 'triz.js')), true);
});
test('A stalled release response body is aborted by the request timeout', async () => {
  const fetch = binaryBodyFetch(TOOL_REPOS.fmeca.repo, 'v1.2.3', fmecaAsset, stalledBody());
  const report = await installTools({ tools: ['fmeca'] }, baseDeps({ fetch } as any, { fetch, requestTimeoutMs: 50 }));
  assert.match(report.outcomes[0].error ?? '', /abort|timeout|deadline/i);
});
test('A streaming release body over the byte limit is rejected by streaming', async () => {
  const totalChunks = 100;
  const chunk = Buffer.alloc(1024, 1);
  let reads = 0;
  const body = {
    getReader: () => ({
      read: async () => {
        reads++;
        return reads <= totalChunks ? { done: false, value: chunk } : { done: true, value: undefined };
      },
      cancel: async () => {},
      releaseLock: () => {},
    }),
  };
  const fetch = binaryBodyFetch(TOOL_REPOS.fmeca.repo, 'v1.2.3', fmecaAsset, body);
  const report = await installTools({ tools: ['fmeca'] }, baseDeps({ fetch } as any, { fetch, maxAssetBytes: 4 * 1024 }));
  assert.match(report.outcomes[0].error ?? '', /exceeds/i);
});
test('An overall install deadline is shared across release requests', async () => {
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
  });
  const deps = baseDeps(delayedServer(server, 30) as any, { installTimeoutMs: 40, requestTimeoutMs: 60_000 });
  const report = await installTools({ tools: ['fmeca'] }, deps);
  assert.equal(report.outcomes[0].status, 'failed');
});
test('A release manifest supplies the recorded source SHA instead of the binary digest', async () => {
  const sourceSha = 'b'.repeat(40);
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
    manifest: { version: '1.2.3', tag: 'v1.2.3', sourceSha, targets: allTargets() },
  });
  const deps = baseDeps(server);
  await installTools({ tools: ['fmeca'] }, deps);
  assert.equal(readState(deps).tools.fmeca.sourceSha, sourceSha);
});
test('A release without a manifest never records the binary digest as the source SHA', async () => {
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
  });
  const deps = baseDeps(server);
  await installTools({ tools: ['fmeca'] }, deps);
  assert.equal(readState(deps).tools.fmeca.sourceSha, undefined);
});
test('A new-format release manifest missing a supported target is rejected', async () => {
  const targets = allTargets();
  delete targets['aarch64-pc-windows-msvc'];
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
    manifest: { version: '1.2.3', tag: 'v1.2.3', sourceSha: 'b'.repeat(40), targets },
  });
  const report = await installTools({ tools: ['fmeca'] }, baseDeps(server));
  assert.match(report.outcomes[0].error ?? '', /target/i);
});
test('A release manifest whose version disagrees with the release tag is rejected', async () => {
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
    manifest: { version: '9.9.9', tag: 'v9.9.9', sourceSha: 'b'.repeat(40), targets: allTargets() },
  });
  const report = await installTools({ tools: ['fmeca'] }, baseDeps(server));
  assert.match(report.outcomes[0].error ?? '', /version|tag/i);
});
test('A TRIZ commit-schema release manifest supplies the recorded source SHA', async () => {
  const commit = 'c'.repeat(40);
  const triz = releaseServer({
    repo: 'matt-cochran/triz',
    tag: 'v0.9.0',
    assetName: 'triz-v0.9.0-node.tgz',
    entries: [{ name: 'dist/triz.js', data: entryData('export default 1') }],
    manifest: { version: '0.9.0', commit },
  });
  const deps = baseDeps(triz, { smokeTriz: async () => true });
  await installTools({ tools: [], withTriz: true }, deps);
  assert.equal(readState(deps).optional.triz.sourceSha, commit);
});
test('Installing tools preserves an explicitly custom HOP command', async () => {
  const cwd = tmp('junior-hop-');
  const hopPath = join(cwd, '.delivery', 'setup', 'hop.json');
  const tools = await import('./tools/tools.ts');
  const hop = tools.initHop(hopPath, { projectId: 'existing-project' });
  hop.tools.fmeca = { command: '/custom/fmeca-mcp', args: [], env: {}, sourceVersion: '0.0.0', sourceSha: 'c'.repeat(40) };
  tools.saveHop(hopPath, hop);
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
  });
  await installTools({ tools: ['fmeca'] }, baseDeps(server, { cwd, hopPath }));
  assert.equal(tools.loadHop(hopPath).tools.fmeca.command, '/custom/fmeca-mcp');
});
test('Installing tools preserves explicitly custom HOP arguments', async () => {
  const cwd = tmp('junior-hop-');
  const hopPath = join(cwd, '.delivery', 'setup', 'hop.json');
  const tools = await import('./tools/tools.ts');
  const hop = tools.initHop(hopPath, { projectId: 'existing-project' });
  hop.tools.fmeca = { command: '/custom/fmeca-mcp', args: ['--custom', 'flag'], env: {}, sourceVersion: '0.0.0', sourceSha: 'c'.repeat(40) };
  tools.saveHop(hopPath, hop);
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
  });
  await installTools({ tools: ['fmeca'] }, baseDeps(server, { cwd, hopPath }));
  assert.deepEqual(tools.loadHop(hopPath).tools.fmeca.args, ['--custom', 'flag']);
});
test('Installing tools preserves explicitly custom HOP environment', async () => {
  const cwd = tmp('junior-hop-');
  const hopPath = join(cwd, '.delivery', 'setup', 'hop.json');
  const tools = await import('./tools/tools.ts');
  const hop = tools.initHop(hopPath, { projectId: 'existing-project' });
  hop.tools.fmeca = { command: '/custom/fmeca-mcp', args: [], env: { CUSTOM_KEY: 'value' }, sourceVersion: '0.0.0', sourceSha: 'c'.repeat(40) };
  tools.saveHop(hopPath, hop);
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
  });
  await installTools({ tools: ['fmeca'] }, baseDeps(server, { cwd, hopPath }));
  assert.deepEqual(tools.loadHop(hopPath).tools.fmeca.env, { CUSTOM_KEY: 'value' });
});
test('An idempotent HOP synchronization does not invalidate manager acceptance', async () => {
  const cwd = tmp('junior-hop-');
  const hopPath = join(cwd, '.delivery', 'setup', 'hop.json');
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
  });
  const deps = baseDeps(server, { cwd, hopPath });
  await installTools({ tools: ['fmeca'] }, deps);
  const tools = await import('./tools/tools.ts');
  const hop = tools.loadHop(hopPath);
  hop.managerAcceptance = 'accepted';
  hop.acceptedRevision = hop.revision;
  tools.saveHop(hopPath, hop);
  await installTools({ tools: ['fmeca'] }, deps);
  assert.equal(tools.loadHop(hopPath).managerAcceptance, 'accepted');
});
test('An updated HOP tool configuration resets manager acceptance to pending', async () => {
  const cwd = tmp('junior-hop-');
  const hopPath = join(cwd, '.delivery', 'setup', 'hop.json');
  const first = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('ONE') }],
  });
  const deps = baseDeps(first, { cwd, hopPath });
  await installTools({ tools: ['fmeca'] }, deps);
  const tools = await import('./tools/tools.ts');
  const hop = tools.loadHop(hopPath);
  hop.managerAcceptance = 'accepted';
  hop.acceptedRevision = hop.revision;
  tools.saveHop(hopPath, hop);
  const newer = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    tag: 'v1.2.4',
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('TWO') }],
  });
  await installTools({ tools: ['fmeca'], update: true }, { ...deps, fetch: newer.fetch });
  assert.equal(tools.loadHop(hopPath).managerAcceptance, 'pending');
});
test('The TRIZ install writes a managed ESM package manifest', async () => {
  const fmeca = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
  });
  const triz = releaseServer({
    repo: 'matt-cochran/triz',
    tag: 'v0.9.0',
    assetName: 'triz-v0.9.0-node.tgz',
    entries: [{ name: 'dist/triz.js', data: entryData('export default 1') }],
  });
  const fetch = async (url: string) => (url.includes('matt-cochran/triz') ? triz.fetch(url) : fmeca.fetch(url));
  const deps = baseDeps(fmeca, { fetch, smokeTriz: async () => true });
  await installTools({ tools: ['fmeca'], withTriz: true }, deps);
  const manifest = JSON.parse(readFileSync(join(deps.installRoot, 'triz', 'package.json'), 'utf8'));
  assert.equal(manifest.type, 'module');
});
test('A failing TRIZ smoke preserves the previous working installation', async () => {
  const fmeca = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
  });
  const triz1 = releaseServer({
    repo: 'matt-cochran/triz',
    tag: 'v0.9.0',
    assetName: 'triz-v0.9.0-node.tgz',
    entries: [{ name: 'dist/triz.js', data: entryData('export default 1') }],
  });
  const fetch1 = async (url: string) => (url.includes('matt-cochran/triz') ? triz1.fetch(url) : fmeca.fetch(url));
  const deps = baseDeps(fmeca, { fetch: fetch1, smokeTriz: async () => true });
  await installTools({ tools: ['fmeca'], withTriz: true }, deps);
  const destPath = join(deps.installRoot, 'triz', 'dist', 'triz.js');
  const before = readFileSync(destPath, 'utf8');
  const triz2 = releaseServer({
    repo: 'matt-cochran/triz',
    tag: 'v0.9.1',
    assetName: 'triz-v0.9.1-node.tgz',
    entries: [{ name: 'dist/triz.js', data: entryData('export default 2') }],
  });
  const fetch2 = async (url: string) => (url.includes('matt-cochran/triz') ? triz2.fetch(url) : fmeca.fetch(url));
  await installTools({ tools: ['fmeca'], withTriz: true, update: true }, { ...deps, fetch: fetch2, smokeTriz: async () => false });
  assert.equal(readFileSync(destPath, 'utf8'), before);
});
test('A newer TRIZ release is not adopted without an explicit update', async () => {
  const fmeca = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
  });
  const triz1 = releaseServer({
    repo: 'matt-cochran/triz',
    tag: 'v0.9.0',
    assetName: 'triz-v0.9.0-node.tgz',
    entries: [{ name: 'dist/triz.js', data: entryData('export default 1') }],
  });
  const fetch1 = async (url: string) => (url.includes('matt-cochran/triz') ? triz1.fetch(url) : fmeca.fetch(url));
  const deps = baseDeps(fmeca, { fetch: fetch1, smokeTriz: async () => true });
  await installTools({ tools: ['fmeca'], withTriz: true }, deps);
  const triz2 = releaseServer({
    repo: 'matt-cochran/triz',
    tag: 'v0.9.1',
    assetName: 'triz-v0.9.1-node.tgz',
    entries: [{ name: 'dist/triz.js', data: entryData('export default 2') }],
  });
  const fetch2 = async (url: string) => (url.includes('matt-cochran/triz') ? triz2.fetch(url) : fmeca.fetch(url));
  await installTools({ tools: ['fmeca'], withTriz: true }, { ...deps, fetch: fetch2 });
  assert.equal(triz2.state.assetFetches, 0);
});
test('A failed candidate swap restores the previous working binary', async () => {
  const first = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('WORKING') }],
  });
  const deps = baseDeps(first);
  await installTools({ tools: ['fmeca'] }, deps);
  const binaryPath = join(deps.installRoot, 'fmeca', 'fmeca-mcp');
  const before = readFileSync(binaryPath, 'utf8');
  const newer = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    tag: 'v1.2.4',
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('NEW') }],
  });
  await installTools(
    { tools: ['fmeca'], update: true },
    {
      ...deps,
      fetch: newer.fetch,
      probe: async (candidate: string) => {
        rmSync(candidate, { force: true });
        return true;
      },
    },
  );
  assert.equal(readFileSync(binaryPath, 'utf8'), before);
});
test('A failed install drops a manifest entry whose binary is missing', async () => {
  const installRoot = tmp('junior-stale-state-');
  stateWith(installRoot, 'fmeca', {
    repo: TOOL_REPOS.fmeca.repo, tag: 'v1.2.3', version: '1.2.3', asset: fmecaAsset,
    assetDigest: 'sha256:' + '0'.repeat(64), binaryDigest: 'sha256:' + '0'.repeat(64),
    path: join(installRoot, 'fmeca', 'fmeca-mcp'), installedAt: new Date().toISOString(),
  });
  const server = releaseServer({
    repo: TOOL_REPOS.fmeca.repo,
    assetName: fmecaAsset,
    entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }],
    assets: [],
  });
  const deps = baseDeps(server, { installRoot });
  await installTools({ tools: ['fmeca'] }, deps);
  assert.equal(readState(deps).tools.fmeca, undefined);
});
test('TRIZ release provenance accepts its complete portable target matrix', () => {
 const release = {repo:'matt-cochran/triz',tag:'v0.1.0',version:'0.1.0',assets:[]};
 const manifest = {version:'0.1.0',tag:'v0.1.0',commit:'a'.repeat(40),targets:['linux-x64','linux-arm64','darwin-x64','darwin-arm64','win32-x64','win32-arm64']};
 assert.equal(parseReleaseManifest(release.repo,manifest,release).sourceSha,manifest.commit);
});
test('Private release metadata sends the token to the GitHub API host', async () => {
 let authorization;
 await resolveLatestRelease('matt-cochran/triz',{githubToken:'fixture-token',fetch:async(url,init)=>{
  authorization=init?.headers?.Authorization;
  return response(200,JSON.stringify({tag_name:'v0.1.0',assets:[]}));
 }});
 assert.equal(authorization,'Bearer fixture-token');
});
test('Private release redirects never forward the GitHub token to an asset host', async () => {
 let authorization;
 await resolveLatestRelease('matt-cochran/triz',{githubToken:'fixture-token',fetch:async(url,init)=>{
  if(new URL(url).host==='api.github.com')return response(302,'',{location:'https://release-assets.githubusercontent.com/fixture'});
  authorization=init?.headers?.Authorization;
  return response(200,JSON.stringify({tag_name:'v0.1.0',assets:[]}));
 }});
 assert.equal(authorization,undefined);
});
test('update check flags a managed tool behind its latest GitHub release', async () => {
  const report = await checkToolUpdates({ ...managedStateWith({ fmeca: '0.0.2' }), resolveRelease: releaseAt('0.2.0') });
  assert.equal(report.tools.find((t) => t.tool === 'fmeca')?.outdated, true);
});
test('update check reports a managed tool at the latest release as current', async () => {
  const report = await checkToolUpdates({ ...managedStateWith({ cpm: '0.2.2' }), resolveRelease: releaseAt('0.2.2') });
  assert.equal(report.tools.find((t) => t.tool === 'cpm')?.outdated, false);
});
test('update check leaves outdated unknown when the release lookup fails', async () => {
  const report = await checkToolUpdates({ ...managedStateWith({ fmeca: '0.0.2' }), resolveRelease: async () => { throw new Error('offline'); } });
  assert.equal(report.tools.find((t) => t.tool === 'fmeca')?.outdated, null);
});
test('update check reports scientific-process as unavailable when its release lookup fails', async () => {
  const report = await checkToolUpdates({ ...managedStateWith({}), resolveRelease: async () => { throw new Error('offline'); } });
  assert.equal(report.tools.find((t) => t.tool === 'scientific-process')?.unavailable, true);
});
test('update check reports the optional managed TRIZ install as tool triz', async () => {
  const root = tmp('junior-updates-');
  writeFileSync(join(root, 'installed.json'), JSON.stringify({
    schemaVersion: 1,
    tools: {},
    optional: { triz: { repo: TRIZ_REPO, tag: 'v0.8.0', version: '0.8.0', path: join(root, 'triz', 'dist', 'triz.js') } },
  }));
  const report = await checkToolUpdates({ installRoot: root, statePath: join(root, 'installed.json'), resolveRelease: releaseAt('0.9.0') });
  assert.equal(report.tools.find((t) => t.tool === 'triz')?.outdated, true);
});
test('update check lists an outdated optional TRIZ among the outdated tools', async () => {
  const deps = managedStateWith({});
  const state = JSON.parse(readFileSync(deps.statePath, 'utf8'));
  state.optional = { triz: { repo: 'matt-cochran/triz', tag: 'v0.1.0', version: '0.1.0', path: join(deps.installRoot, 'triz.js') } };
  writeFileSync(deps.statePath, JSON.stringify(state));
  const report = await checkToolUpdates({ ...deps, resolveRelease: releaseAt('0.2.1') });
  assert.ok(report.outdated.includes('triz'));
});
test('The TRIZ install keeps the release package name and version in its managed manifest', async () => {
  const deps = trizWithPackage('0.9.0', '0.9.0');
  await installTools({ tools: ['fmeca'], withTriz: true }, deps);
  const manifest = JSON.parse(readFileSync(join(deps.installRoot, 'triz', 'package.json'), 'utf8'));
  assert.deepEqual({ name: manifest.name, version: manifest.version, type: manifest.type }, { name: '@matthew-cochran/triz', version: '0.9.0', type: 'module' });
});
test('A TRIZ archive whose package.json version contradicts the release is refused', async () => {
  const deps = trizWithPackage('0.9.0', '0.8.0');
  const report = await installTools({ tools: ['fmeca'], withTriz: true }, deps);
  assert.equal(report.triz?.status, 'failed');
});
