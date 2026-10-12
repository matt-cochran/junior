// Behavioral tests for `junior matrix sync`: the Crossmatrix 0.3+ write-API
// push of the matrix adapters' dimensions.
//
// Every scenario is offline: it uses its own temp hop + write log and the fake
// MCP fixture in write mode. Each test asserts exactly one observable outcome
// through the public module/CLI interface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHop } from './tools/tools.ts';
import { codeLocations } from './matrix.ts';
import { syncDimensions } from './matrix-sync.ts';

const NODE = process.execPath;
const FAKE = join(import.meta.dirname, 'tools', 'test-fixtures', 'fake-mcp.mjs');

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-matrix-sync-'));
}

function writeHop(dir: string, sourceVersion: string, log: string): string {
  const hop = join(dir, 'hop.json');
  initHop(hop, {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: {
      crossmatrix: {
        command: NODE,
        args: [FAKE],
        env: { FAKE_MCP_MODE: 'crossmatrix', FAKE_CROSSMATRIX_WRITES: log },
        sourceVersion,
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

function roster(): any[] {
  return [codeLocations([{ path: 'src/app.ts', content: 'export const x = 1;' }])];
}

// --- model.open -------------------------------------------------------------

test('syncDimensions opens the model before any dimension write', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  await syncDimensions({ hopPath: hop, modelId: 'm1', dimensions: roster() });
  assert.equal(operations(log)[0].op.kind, 'model.open');
});

test('syncDimensions opens the model exactly once across dimensions', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  await syncDimensions({
    hopPath: hop,
    modelId: 'm1',
    dimensions: [...roster(), ...roster()],
  });
  const opens = operations(log).filter((request) => request.op.kind === 'model.open');
  assert.equal(opens.length, 1);
});

// --- dimension.register before members.sync ---------------------------------

test('syncDimensions registers a dimension before syncing its members', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  await syncDimensions({ hopPath: hop, modelId: 'm1', dimensions: roster() });
  const ops = operations(log);
  const register = ops.findIndex((r) => r.op.kind === 'dimension.register' && r.op.dimensionId === 'code');
  const sync = ops.findIndex((r) => r.op.kind === 'members.sync' && r.op.dimensionId === 'code');
  assert.ok(register !== -1 && sync !== -1 && register < sync);
});

// --- member projection ------------------------------------------------------

test('syncDimensions drops the member status field from members.sync', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  await syncDimensions({ hopPath: hop, modelId: 'm1', dimensions: roster() });
  const sync = operations(log).find((r) => r.op.kind === 'members.sync');
  assert.equal('status' in sync.op.members[0], false);
});

// --- idempotency ------------------------------------------------------------

test('syncDimensions resends identical requestIds for an unchanged roster', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  await syncDimensions({ hopPath: hop, modelId: 'm1', dimensions: roster() });
  const first = operations(log).map((request) => request.requestId);
  await syncDimensions({ hopPath: hop, modelId: 'm1', dimensions: roster() });
  const second = operations(log)
    .map((request) => request.requestId)
    .slice(first.length);
  assert.deepEqual(second, first);
});

// --- version gate -----------------------------------------------------------

test('syncDimensions rejects a hop older than Crossmatrix 0.3.0', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.2.1', log);
  await assert.rejects(
    syncDimensions({ hopPath: hop, modelId: 'm1', dimensions: roster() }),
    /Crossmatrix 0\.3\.0 or newer \(hop records 0\.2\.1\)/,
  );
});

test('syncDimensions writes no request when the hop is too old', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.2.1', log);
  await syncDimensions({ hopPath: hop, modelId: 'm1', dimensions: roster() }).catch(() => {});
  assert.equal(existsSync(log), false);
});
