// Behavioral tests for automatic matrix context on handoff contracts.
//
// Every scenario is offline: a temp hop + fake Crossmatrix query transport.
// Each test asserts one observable outcome through the public module interface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHop } from './tools/tools.ts';
import { matrixContextFor } from './matrix-context.ts';

const NODE = process.execPath;
const FAKE = join(import.meta.dirname, 'tools', 'test-fixtures', 'fake-mcp.mjs');

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-matrix-context-'));
}

function project(): string {
  const dir = workdir();
  mkdirSync(join(dir, '.crossmatrix', 'state'), { recursive: true });
  writeFileSync(join(dir, '.crossmatrix', 'state', 'm1.json'), '{}');
  return dir;
}

function writeQueryHop(dir: string, responses: Record<string, unknown>): void {
  const queries = join(dir, 'queries.json');
  writeFileSync(queries, JSON.stringify(responses));
  mkdirSync(join(dir, '.delivery', 'setup'), { recursive: true });
  initHop(join(dir, '.delivery', 'setup', 'hop.json'), {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: {
      crossmatrix: {
        command: NODE,
        args: [FAKE],
        env: { FAKE_MCP_MODE: 'crossmatrix', FAKE_CROSSMATRIX_QUERY_RESPONSES: queries },
        sourceVersion: '0.3.0',
        sourceSha: '0'.repeat(64),
      },
    },
  });
}

function traceHops(...paths: string[]): Record<string, unknown> {
  return {
    trace: {
      hops: paths.map((path) => ({
        dimension: 'code',
        direction: 'out',
        member: `loc:${path}`,
        observations: ['implements'],
        relation: 'codemap-cpm',
      })),
      nextCursor: null,
    },
  };
}

test('matrixContextFor returns codemap context for a plan deliverable', async () => {
  const dir = project();
  writeQueryHop(dir, traceHops('src/a.ts', 'src/b.ts'));
  const result = await matrixContextFor({ cwd: dir, plan: { deliverable: 'd-1' } });
  assert.deepEqual(result.entries, [{ path: 'src/a.ts' }, { path: 'src/b.ts' }]);
});

test('matrixContextFor uses the contract feature when present', async () => {
  const dir = project();
  writeQueryHop(dir, traceHops('src/a.ts'));
  const result = await matrixContextFor({ cwd: dir, feature: 'cpm:d-1', plan: { deliverable: 'd-2' } });
  assert.equal(result.feature, 'cpm:d-1');
});

test('matrixContextFor returns no entries and a note when the store is missing', async () => {
  const dir = workdir();
  const result = await matrixContextFor({ cwd: dir, feature: 'cpm:d-1' });
  assert.deepEqual(result.entries, []);
});

test('matrixContextFor notes the missing store instead of failing the run', async () => {
  const dir = workdir();
  const result = await matrixContextFor({ cwd: dir, feature: 'cpm:d-1' });
  assert.match(result.note ?? '', /crossmatrix/i);
});

test('matrixContextFor returns no entries and a note when the hop call fails', async () => {
  const dir = project();
  const result = await matrixContextFor(
    { cwd: dir, feature: 'cpm:d-1' },
    {
      deps: {
        loadHop: () => ({ tools: { crossmatrix: { sourceVersion: '0.3.0' } } }) as any,
        callHop: (async () => {
          throw new Error('hop offline');
        }) as any,
      },
    },
  );
  assert.deepEqual(result.entries, []);
});

// --- handoff wiring --------------------------------------------------------

test('a handoff result records the matrix context it added', async () => {
  const dir = project();
  writeQueryHop(dir, traceHops('src/a.ts'));
  writeFileSync(join(dir, 'src-a.ts'), 'export const a = 1;\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  const { run } = await import('./worker.ts');
  const result = await run({
    id: 'matrix-context-run',
    deliverable: 'Use matrix context',
    cwd: dir,
    feature: 'cpm:d-1',
    acceptance: ['the run completes'],
    checks: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
    externalContextConsent: true,
    jev: { mode: 'off' },
  }, true);
  assert.deepEqual(result.matrixContext, { feature: 'cpm:d-1', paths: ['src/a.ts'] });
});
