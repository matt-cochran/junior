// Opt-in integration tests: Junior's crossmatrix setup against the real
// crossmatrix-mcp binary (ADR 0012 R6). The strict test double mirrors the
// server's public contract; these tests check that the mirror is honest.
//
// The binary comes from CROSSMATRIX_MCP, else ~/.junior/tools/crossmatrix,
// else PATH. Without one every test is skipped, never failed. Companion reads
// (cpm plan.get, fmeca state.get) are injected; every crossmatrix call goes
// to the real server through a real hop.

import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { callHop, initHop, loadHop } from './tools/tools.ts';
import { codeLocations, cpmDeliverables, fmecaFailureModes } from './matrix.ts';
import { syncDimensions } from './matrix-sync.ts';
import { codemapInit, type CodemapResult } from './codemap.ts';
import { syncState, type StateSyncResult } from './state-sync.ts';
import { graphSlice, type GraphSlice } from './context-graph.ts';

function findBinary(): string | null {
  const explicit = process.env.CROSSMATRIX_MCP;
  if (explicit !== undefined) return existsSync(explicit) ? explicit : null;
  const managed = join(homedir(), '.junior', 'tools', 'crossmatrix', 'crossmatrix-mcp');
  if (existsSync(managed)) return managed;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['crossmatrix-mcp'], { encoding: 'utf8' });
  const found = which.status === 0 ? which.stdout.split('\n')[0]?.trim() : '';
  return found || null;
}

const BINARY = findBinary();
const SKIP = BINARY ? false : 'crossmatrix-mcp not installed';
const MODEL = 'live';

const PLAN = {
  deliverables: [
    {
      id: 'd1',
      owned_files: ['src/a.ts'],
      metadata: { junior: { acceptance: [{ id: 'a1', text: 't', mitigates: ['S/m1'] }] } },
    },
    { id: 'd2' },
  ],
};
const FMECA = {
  failure_modes: [
    {
      id: 'f1',
      description: 'd',
      refs: ['cpm:P/d1', 'src/a.ts'],
      mitigations: [{ id: 'm1', status: 'verified' }],
    },
  ],
};

let codemap: CodemapResult;
let state: StateSyncResult;
let slice: GraphSlice;

before(async () => {
  if (!BINARY) return;
  const dir = mkdtempSync(join(tmpdir(), 'junior-matrix-live-'));
  spawnSync(BINARY, ['init'], { cwd: dir, encoding: 'utf8' });
  const version = /(\d+\.\d+\.\d+)/.exec(spawnSync(BINARY, ['--version'], { encoding: 'utf8' }).stdout)?.[1] ?? '0.3.0';
  const hopPath = join(dir, 'hop.json');
  initHop(hopPath, {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: {
      crossmatrix: {
        command: BINARY,
        args: [],
        env: { CROSSMATRIX_DIR: join(dir, '.crossmatrix') },
        sourceVersion: version,
        sourceSha: '0'.repeat(64),
      },
    },
  });
  const reads: Record<string, unknown> = { cpm: PLAN, fmeca: FMECA };
  const injected = (async (hop: string, tool: string, call: any) =>
    tool in reads ? { ok: true, result: reads[tool] } : callHop(hop, tool, call)) as typeof callHop;

  await syncDimensions({
    hopPath,
    modelId: MODEL,
    dimensions: [
      cpmDeliverables(PLAN, 'P'),
      codeLocations([{ path: 'src/a.ts', content: 'x' }]),
      fmecaFailureModes(FMECA, 'S'),
    ],
  });
  codemap = await codemapInit({ hopPath, modelId: MODEL });
  state = await syncState({
    hopPath,
    modelId: MODEL,
    planId: 'P',
    fmecaSession: 'S',
    deps: { callHop: injected, loadHop },
  });
  slice = await graphSlice({ hopPath, modelId: MODEL, seeds: ['cpm:d1'], depth: 2 });
});

test('codemap init on a model without Jevitate dimensions notes jevitate-jobs', { skip: SKIP }, () => {
  assert.ok(codemap.notes.some((note) => note.includes('jevitate-jobs')));
});

test('state sync against the real server records no failures', { skip: SKIP }, () => {
  assert.deepEqual(state.failures, []);
});

test('the graph slice from a deliverable reaches the failure mode it mitigates', { skip: SKIP }, () => {
  assert.ok(slice.nodes.some((node) => node.member === 'fm:f1'));
});

test('the graph slice holds the failure mode reference to the deliverable', { skip: SKIP }, () => {
  assert.ok(slice.edges.some((edge) => edge.from === 'fm:f1' && edge.to === 'cpm:d1' && edge.relation === 'junior-fmeca-cpm'));
});
