// Shared offline fixtures for the installer and doctor behavioral tests.
//
// This module deliberately holds no test() calls: the build only collects
// files with test declarations, and both sibling test files import these
// helpers.

import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseAssetName, SUPPORTED_MATRIX, TOOL_REPOS } from './installer.ts';
import { DEFAULT_MODEL, PI_PACKAGE } from './setup.ts';

export const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
export const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

export function response(status: number, body: string | Buffer, headers: Record<string, string> = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    async text() {
      return buf.toString('utf8');
    },
    async arrayBuffer() {
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
}

/** Archives are represented as JSON so the fake `tar` seams stay trivial. */
export function archiveBytes(entries: Array<{ name: string; type?: string; data?: string }>) {
  return Buffer.from(JSON.stringify({ entries }));
}

export function tarExec(_cmd: string, args: string[]) {
  const doc = JSON.parse(readFileSync(args[1], 'utf8'));
  if (args[0] === '-tvf') {
    const lines = doc.entries.map((e: any) => {
      const type = e.type === 'l' ? 'l' : e.type === 'd' ? 'd' : '-';
      return `${type}rwxr-xr-x user/group ${e.data ? Buffer.from(e.data, 'base64').length : 0} 2024-01-01 00:00 ${e.name}`;
    });
    return { status: 0, stdout: lines.join('\n') + '\n' };
  }
  return { status: 1, stderr: 'unsupported' };
}

export function tarExecBuffer(_cmd: string, args: string[]) {
  const doc = JSON.parse(readFileSync(args[1], 'utf8'));
  const entry = doc.entries.find((e: any) => e.name === args[2]);
  return { status: entry ? 0 : 1, stdout: Buffer.from(entry?.data ?? '', 'base64'), stderr: entry ? '' : 'missing' };
}

export interface ServerConfig {
  repo: string;
  tag?: string;
  assetName: string;
  entries: Array<{ name: string; type?: string; data?: string }>;
  digest?: string;
  body?: Buffer;
  checksums?: string;
  assets?: any[];
  /** Optional release-manifest.json body served as a verified asset. */
  manifest?: any;
}
export function allTargets(): Record<string, { asset: string }> {
  return Object.fromEntries(SUPPORTED_MATRIX.map((m) => [m.triple, { asset: m.triple }]));
}
export function releaseServer(config: ServerConfig) {
  const state = { assetFetches: 0, checksumFetches: 0, manifestFetches: 0 };
  const bytes = config.body ?? archiveBytes(config.entries);
  const digest = config.digest ?? sha(bytes);
  const tag = config.tag ?? 'v1.2.3';
  const manifestBytes = config.manifest === undefined ? undefined : Buffer.from(JSON.stringify(config.manifest));
  const defaultAssets = [
    {
      name: 'checksums.sha256',
      browser_download_url: `https://github.com/${config.repo}/releases/download/${tag}/checksums.sha256`,
      digest: `sha256:${digest}`,
    },
    {
      name: config.assetName,
      browser_download_url: `https://github.com/${config.repo}/releases/download/${tag}/${config.assetName}`,
      digest: `sha256:${digest}`,
      size: bytes.length,
    },
  ];
  if (manifestBytes) {
    defaultAssets.push({
      name: 'release-manifest.json',
      browser_download_url: `https://github.com/${config.repo}/releases/download/${tag}/release-manifest.json`,
      digest: `sha256:${sha(manifestBytes)}`,
    } as any);
  }
  const assets = config.assets ?? defaultAssets;
  const release = { tag_name: tag, target_commitish: 'a'.repeat(40), assets };
  const fetch = async (url: string) => {
    if (url.includes('/releases/latest')) return response(200, JSON.stringify(release));
    if (url.endsWith('checksums.sha256')) {
      state.checksumFetches++;
      return response(200, config.checksums ?? `${digest}  ${config.assetName}\n`);
    }
    if (url.endsWith('release-manifest.json') && manifestBytes) {
      state.manifestFetches++;
      return response(200, manifestBytes);
    }
    if (url.endsWith(config.assetName)) {
      state.assetFetches++;
      return response(200, bytes);
    }
    return response(404, 'not found');
  };
  return { fetch, state, bytes, digest, tag };
}

/** A response whose streamed body never ends, so the abort timer must stop it. */
export function stalledBody() {
  return {
    getReader: () => ({
      read: () => new Promise(() => {}),
      cancel: async () => {},
      releaseLock: () => {},
    }),
  };
}

export function entryData(text: string) {
  return Buffer.from(text).toString('base64');
}

export function baseDeps(server: ReturnType<typeof releaseServer>, overrides: Record<string, any> = {}) {
  const installRoot = overrides.installRoot ?? tmp('junior-install-');
  const cwd = overrides.cwd ?? tmp('junior-project-');
  return {
    platform: 'linux' as NodeJS.Platform,
    arch: 'x64',
    installRoot,
    statePath: join(installRoot, 'installed.json'),
    hopPath: join(cwd, '.delivery', 'setup', 'hop.json'),
    cwd,
    fetch: server.fetch,
    exec: tarExec,
    execBuffer: tarExecBuffer,
    probe: async () => true,
    ...overrides,
  };
}

export const fmecaAsset = releaseAssetName('fmeca', {
  os: 'linux',
  arch: 'x64',
  triple: 'x86_64-unknown-linux-gnu',
  ext: 'tar.gz',
});
export const scientificTarget = { os: 'linux' as const, arch: 'x64' as const, triple: 'x86_64-unknown-linux-gnu', ext: 'tar.gz' as const };
export const scientificAsset = releaseAssetName('scientific-process', scientificTarget);

export function missingScientificServer() {
  return releaseServer({ repo: TOOL_REPOS['scientific-process'].repo, assetName: scientificAsset, entries: [] });
}
export function readState(deps: any) {
  return JSON.parse(readFileSync(deps.statePath, 'utf8'));
}

/** A release fetch whose every call is delayed, to consume a shared deadline. */
export function delayedServer(server: ReturnType<typeof releaseServer>, delayMs: number) {
  return {
    ...server,
    fetch: async (url: string) => {
      await new Promise((r) => setTimeout(r, delayMs));
      return server.fetch(url);
    },
  };
}

export function binaryBodyFetch(repo: string, tag: string, assetName: string, body: any) {
  const checksum = 'a'.repeat(64);
  return async (url: string) => {
    if (url.includes('/releases/latest')) {
      return response(200, JSON.stringify({
        tag_name: tag,
        assets: [
          { name: 'checksums.sha256', browser_download_url: `https://github.com/${repo}/releases/download/${tag}/checksums.sha256` },
          { name: assetName, browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${assetName}` },
        ],
      }));
    }
    if (url.endsWith('checksums.sha256')) return response(200, `${checksum}  ${assetName}\n`);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '', body };
  };
}
export function stateWith(installRoot: string, tool: string, entry: Record<string, unknown>) {
  const statePath = join(installRoot, 'installed.json');
  writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, tools: { [tool]: entry } }));
  return statePath;
}
export type StoreState = 'missing' | 'empty' | 'populated';

/** A fully offline doctor fixture: an executable `pi`, optional auth/model
 * files, and a bounded `pi --version` seam. Never installs or calls a network. */
export function doctorFixture(opts: {
 installed?: string;
 tested?: string;
 store?: StoreState;
 authenticated?: boolean;
 catalogId?: string;
 catalogProvider?: string;
} = {}) {
 const cwd = tmp('junior-doctor-');
 const bin = join(cwd, 'bin');
 mkdirSync(bin, { recursive: true });
 writeFileSync(join(bin, 'pi'), '#!/bin/sh\n');
 const agent = join(cwd, 'agent');
 mkdirSync(agent, { recursive: true });
 if (opts.authenticated !== false) {
  writeFileSync(join(agent, 'auth.json'), JSON.stringify({ openrouter: { type: 'api', key: 'secret' } }));
 }
 const store = opts.store ?? 'populated';
 const catalogProvider = opts.catalogProvider ?? 'openrouter';
 if (store === 'populated') {
  writeFileSync(join(agent, 'models-store.json'), JSON.stringify({ [catalogProvider]: { models: [{ id: opts.catalogId ?? DEFAULT_MODEL }] } }));
 } else if (store === 'empty') {
  writeFileSync(join(agent, 'models-store.json'), JSON.stringify({ [catalogProvider]: { models: [] } }));
 }
 if (opts.tested) {
  writeFileSync(join(cwd, 'delivery.config.json'), JSON.stringify({ provider: 'openrouter', model: DEFAULT_MODEL, pi: { name: PI_PACKAGE, testedVersion: opts.tested } }));
 }
 const installed = opts.installed ?? '1.0.3';
 const deps = {
  cwd,
  env: { PATH: bin, PI_CODING_AGENT_DIR: agent },
  execPath: join(bin, 'node'),
  nodeVersion: '26.5.0',
  exec: () => ({ status: 0, stdout: `pi ${installed}\n` }),
 };
 return { cwd, deps };
}
export function managedStateWith(versions: Record<string, string>) {
  const root = tmp('junior-updates-');
  const tools: Record<string, unknown> = {};
  for (const [tool, version] of Object.entries(versions)) tools[tool] = { repo: TOOL_REPOS[tool as 'fmeca'].repo, tag: `v${version}`, version, path: join(root, tool) };
  writeFileSync(join(root, 'installed.json'), JSON.stringify({ schemaVersion: 1, tools }));
  return { installRoot: root, statePath: join(root, 'installed.json') };
}
export const releaseAt = (version: string) => async (repo: string) => ({ repo, tag: `v${version}`, version, assets: [] });
export function trizWithPackage(version: string, pkgVersion: string) {
  const fmeca = releaseServer({ repo: TOOL_REPOS.fmeca.repo, assetName: fmecaAsset, entries: [{ name: 'fmeca-mcp', data: entryData('BINARY') }] });
  const triz = releaseServer({
    repo: 'matt-cochran/triz',
    tag: `v${version}`,
    assetName: `triz-v${version}-node.tgz`,
    entries: [
      { name: 'package/dist/triz.js', data: entryData('export default 1') },
      { name: 'package/package.json', data: entryData(JSON.stringify({ name: '@matthew-cochran/triz', version: pkgVersion, bin: { triz: 'dist/triz.js' } })) },
    ],
  });
  const fetch = async (url: string) => (url.includes('matt-cochran/triz') ? triz.fetch(url) : fmeca.fetch(url));
  return baseDeps(fmeca, { fetch, smokeTriz: async () => true });
}
