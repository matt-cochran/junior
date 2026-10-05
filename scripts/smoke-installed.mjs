#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Lightweight installed-CLI smoke for CI.
//
// Assumes the build already ran (`npm run build`). Packs the package with
// lifecycle scripts ignored, installs the tarball into a temporary prefix with
// `--ignore-scripts`, then runs `--version` and `--help` through the installed
// shim. No runtime dependency is fetched and nothing is published.
//
// POSIX-only behavior (process groups, signals) is intentionally not exercised
// here; the full suite runs on Ubuntu. This smoke runs on every OS/arch so the
// published bin and compiled entry are proven to install and start natively.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const dir = mkdtempSync(join(tmpdir(), 'junior-smoke-'));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
    ...options,
  });
}

try {
  const packed = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', dir]));
  const tarball = join(dir, packed[0].filename);
  const prefix = join(dir, 'prefix');
  run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, tarball]);

  const bin = process.platform === 'win32'
    ? join(prefix, 'node_modules', '.bin', 'junior.cmd')
    : join(prefix, 'node_modules', '.bin', 'junior');
  const version = run(bin, ['--version']).trim();
  const help = run(bin, ['--help']);

  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`unexpected --version output: ${JSON.stringify(version)}`);
  if (!help.includes('Usage: junior')) throw new Error('--help output is missing the junior usage line');
  console.log(`installed CLI smoke ok: junior ${version}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
