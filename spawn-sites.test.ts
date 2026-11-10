// ---------------------------------------------------------------------------
// Guardrails for the synchronous child-process migration (#201).
//
// No production module may import `spawnSync` directly: Junior's synchronous
// children go through runSync so a Codex workspace-write sandbox cannot lose
// their output. The behaviour tests pin the two call-site fixes that made the
// migration necessary: Git results are judged by their exit status, and the Pi
// capability probe parses the help text runSync captured.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runGit } from './isolation.ts';
import { probePiCapabilities } from './worker-pi.ts';

const ROOT = import.meta.dirname;
const ALLOWED = new Set(['spawn-sync.ts', 'setup-env.ts', 'setup-init.ts', 'companions.ts']);
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git', '.delivery']);

function typescriptSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) typescriptSources(join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function eperm(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('spawnSync git EPERM');
  error.code = 'EPERM';
  error.syscall = 'spawnSync git';
  return error;
}

const epermSpawn = ((..._args: unknown[]) => ({
  pid: 7,
  status: 0,
  signal: null,
  output: [],
  stdout: null,
  stderr: null,
  error: eperm(),
})) as unknown as typeof spawnSync;

test('no production module imports spawnSync directly', () => {
  const pattern = /import\s*\{[^}]*\bspawnSync\b[^}]*\}\s*from\s*['"]node:child_process['"]/s;
  const offenders = typescriptSources(ROOT)
    .filter((file) => !ALLOWED.has(relative(ROOT, file)))
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(ROOT, file))
    .sort();
  assert.deepEqual(offenders, []);
});

test('runGit judges a Git run by its exit status when spawnSync reports EPERM', () => {
  assert.equal(runGit(ROOT, ['rev-parse', 'HEAD'], 60_000, { spawn: epermSpawn }).status, 0);
});

test('runGit drops a spurious EPERM that accompanied an exit status', () => {
  assert.equal(runGit(ROOT, ['rev-parse', 'HEAD'], 60_000, { spawn: epermSpawn }).error, undefined);
});

test('runGit treats a zero timeout as no timeout', () => {
  let timeout: unknown;
  const captureSpawn = ((...args: unknown[]) => {
    timeout = (args[2] as { timeout?: unknown } | undefined)?.timeout;
    return { pid: 1, status: 0, signal: null, output: [], stdout: null, stderr: null };
  }) as unknown as typeof spawnSync;
  runGit(ROOT, ['status', '--porcelain'], 0, { spawn: captureSpawn });
  assert.equal(timeout, undefined);
});

test('probePiCapabilities parses the Pi help captured by runSync', (t) => {
  const bin = mkdtempSync(join(tmpdir(), 'junior-pi-probe-'));
  const previousPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = previousPath;
    rmSync(bin, { recursive: true, force: true });
  });
  const pi = join(bin, 'pi');
  writeFileSync(pi, '#!/bin/sh\nprintf "%s\\n" "  --no-mcp   Disable built-in MCP support" "  --tools <tools>  Tool allowlist"\n');
  chmodSync(pi, 0o755);
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  assert.equal(probePiCapabilities()?.flags.has('--no-mcp'), true);
});
