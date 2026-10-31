// Behavioral tests for `junior matrix refresh`.
//
// The focused scenarios inject each step and assert one observable outcome:
// the order of the recorded calls, the note left by a failed step, the skipped
// autolink when no plan resolves, or the stale counts. One integration scenario
// drives the real steps through the fake Crossmatrix write API and asserts the
// pass is idempotent. Nothing inspects private state or source text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refresh } from './matrix-refresh.ts';
import { initHop } from './tools/tools.ts';

const NODE = process.execPath;
const FAKE = join(import.meta.dirname, 'tools', 'test-fixtures', 'fake-mcp.mjs');

const fakeDeps = (overrides: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const deps = {
    resolveMatrixHop: () => ({ path: 'hop.json', source: 'explicit' }),
    resolveMatrixModel: () => ({ id: 'm1', source: 'explicit' }),
    resolveMatrixPlan: async () => ({ planId: 'plan1', source: 'explicit' }),
    defaultSources: () => ['code'],
    dimensionsForSource: async () => [],
    syncDimensions: async () => {
      calls.push('sync');
      return { modelId: 'm1', synced: [] };
    },
    bootstrap: async () => {
      calls.push('bootstrap');
      return { proposals: [], out: 'proposals.json', counts: { high: 0, medium: 0, low: 0 } };
    },
    confirmProposals: async () => {
      calls.push('confirm');
      return { modelId: 'm1', requestIds: ['confirm-1'], sent: [] };
    },
    autolink: async () => {
      calls.push('autolink');
      return { modelId: 'm1', requestIds: ['link-1'], sent: [], skipped: [] };
    },
    codemapStale: async () => {
      calls.push('stale');
      return { changed: ['a'], affectedCells: ['b', 'c'] };
    },
    ...overrides,
  };
  return { calls, deps: deps as any };
};

test('refresh runs sync, bootstrap, confirm, autolink and stale in order', async () => {
  const { calls, deps } = fakeDeps();
  await refresh({ dir: '/project', deps });
  assert.deepEqual(calls, ['sync', 'bootstrap', 'confirm', 'autolink', 'stale']);
});

test('refresh records a failed step in notes', async () => {
  const { deps } = fakeDeps({ syncDimensions: async () => { throw new Error('sync exploded'); } });
  const result = await refresh({ dir: '/project', deps });
  assert.match(result.notes.join('\n'), /sync failed: sync exploded/);
});

test('refresh continues with later independent steps after a step fails', async () => {
  const { calls, deps } = fakeDeps({ bootstrap: async () => { throw new Error('bootstrap exploded'); } });
  await refresh({ dir: '/project', deps });
  assert.deepEqual(calls, ['sync', 'confirm', 'autolink', 'stale']);
});

test('refresh skips autolink when no single plan resolves', async () => {
  const { calls, deps } = fakeDeps({ resolveMatrixPlan: async () => ({}) });
  await refresh({ dir: '/project', deps });
  assert.deepEqual(calls, ['sync', 'bootstrap', 'confirm', 'stale']);
});

test('refresh notes why autolink was skipped when no single plan resolves', async () => {
  const { deps } = fakeDeps({ resolveMatrixPlan: async () => ({}) });
  const result = await refresh({ dir: '/project', deps });
  assert.ok(result.notes.some((note) => /autolink skipped/.test(note)));
});

test('refresh reports the stale changed and affected-cell counts', async () => {
  const { deps } = fakeDeps();
  const result = await refresh({ dir: '/project', deps });
  assert.deepEqual(result.stale, { changed: 1, affectedCells: 2 });
});

test('refresh returns the confirmed and autolinked request ids', async () => {
  const { deps } = fakeDeps();
  const result = await refresh({ dir: '/project', deps });
  assert.deepEqual([...result.confirmed, ...result.autolinked], ['confirm-1', 'link-1']);
});

// --- integration: one real pass over the fake write API --------------------

function workdir(t: any): string {
  const dir = mkdtempSync(join(tmpdir(), 'junior-refresh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeHop(dir: string, log: string): string {
  const hop = join(dir, '.delivery', 'setup', 'hop.json');
  initHop(hop, {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: {
      crossmatrix: {
        command: NODE,
        args: [FAKE],
        env: { FAKE_MCP_MODE: 'crossmatrix', FAKE_CROSSMATRIX_WRITES: log },
        sourceVersion: '0.3.0',
        sourceSha: '0'.repeat(64),
      },
    },
  });
  return hop;
}

function operations(log: string): any[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('refresh run twice against an unchanged store resends the same request ids', async (t) => {
  const dir = workdir(t);
  const log = join(dir, 'writes.log');
  writeHop(dir, log);
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['add', 'a.ts'], { cwd: dir });

  await refresh({ dir });
  const first = operations(log).map((request) => request.requestId);
  await refresh({ dir });
  const second = operations(log).map((request) => request.requestId).slice(first.length);

  assert.deepEqual(second, first);
});
