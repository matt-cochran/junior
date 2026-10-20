// Behavioral tests for the Crossmatrix autopilot: offline bootstrap proposals,
// proposal confirmation and plan-driven autolinking.
//
// Every scenario is offline and asserts exactly one observable outcome through
// the module or CLI interface. Crossmatrix traffic goes through the fake MCP
// fixture or an injected `callHop`; nothing inspects source text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHop } from './tools/tools.ts';
import { bootstrap, confirmProposals, autolink } from './matrix-autopilot.ts';

const NODE = process.execPath;
const JUNIOR = join(import.meta.dirname, 'junior.ts');
const FAKE = join(import.meta.dirname, 'tools', 'test-fixtures', 'fake-mcp.mjs');

/** The recorded cpm@0.4.0 `plan.get` response. */
function planGetFixture(): unknown {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, 'tools', 'test-fixtures', 'companions', 'cpm@0.4.0', 'plan.get.json'), 'utf8'),
  );
}

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-autopilot-'));
}

/** A tracked-file fixture the bootstrap logic reads without touching disk. */
function file(path: string, content = 'x'): { path: string; content: string } {
  return { path, content };
}

function writeHop(dir: string, sourceVersion: string, log: string, extraEnv: Record<string, string> = {}): string {
  const hop = join(dir, 'hop.json');
  initHop(hop, {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: {
      crossmatrix: {
        command: NODE,
        args: [FAKE],
        env: { FAKE_MCP_MODE: 'crossmatrix', FAKE_CROSSMATRIX_WRITES: log, ...extraEnv },
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

function observes(log: string): any[] {
  return operations(log).filter((request) => request.op.kind === 'observe');
}

function proposalsFile(dir: string, proposals: any[]): string {
  const target = join(dir, 'proposals.json');
  writeFileSync(target, JSON.stringify({ schemaVersion: '0.1.0', modelId: 'm1', project: dir, proposals }, null, 2));
  return target;
}

function proposal(overrides: Record<string, unknown>): any {
  return {
    id: 'p',
    feature: 'cpm:d1',
    path: 'src/a.ts',
    observation: 'implements',
    confidence: 'high',
    evidence: { kind: 'test', detail: 'd', source: 's' },
    ...overrides,
  };
}

function resultFile(dir: string, id: string, changedFiles: string[]): string {
  const target = join(dir, `${id}.result.json`);
  writeFileSync(
    target,
    JSON.stringify({ id, status: 'ready_for_review', artifactDir: join(dir, id), evidence: { runChangedFiles: changedFiles } }),
  );
  return target;
}

/** A crossmatrix-capable manifest with no tool process behind it. */
function manifest(): any {
  return { tools: { crossmatrix: { sourceVersion: '0.3.0' } } };
}

// --- bootstrap --------------------------------------------------------------

test('bootstrap proposes a high-confidence implements link from a cpm deliverable to each owned file', async () => {
  const doc = await bootstrap({
    hopPath: 'hop.json',
    modelId: 'm1',
    dir: '/project',
    deps: {
      loadHop: manifest,
      planGraph: { deliverables: [{ id: 'd1', owned_files: ['src/a.ts', 'src/b.ts'] }] },
      files: [file('src/a.ts'), file('src/b.ts')],
    },
  });
  const high = doc.proposals
    .filter((p) => p.feature === 'cpm:d1' && p.confidence === 'high' && p.observation === 'implements')
    .map((p) => p.path)
    .sort();
  assert.deepEqual(high, ['src/a.ts', 'src/b.ts']);
});

test('bootstrap proposes a medium journey link to a source file containing the journey route', async () => {
  const doc = await bootstrap({
    hopPath: 'hop.json',
    modelId: 'm1',
    dir: '/project',
    deps: {
      loadHop: manifest,
      files: [
        file('.jevitate/journeys/checkout.json', JSON.stringify({ id: 'checkout', route: '/cart/checkout' })),
        file('src/pages/checkout.ts', "export const path = '/cart/checkout';"),
        file('src/unrelated.ts', 'export const x = 1;'),
      ],
    },
  });
  const journey = doc.proposals.find((p) => p.feature === 'jevitate-journeys:journey:checkout');
  assert.equal(journey?.path, 'src/pages/checkout.ts');
});

test('bootstrap proposes a low-confidence job link to a file of a journey that references the job', async () => {
  const doc = await bootstrap({
    hopPath: 'hop.json',
    modelId: 'm1',
    dir: '/project',
    deps: {
      loadHop: manifest,
      files: [
        file('.jevitate/jobs.json', JSON.stringify([{ id: 'buy', name: 'Buy a ticket' }])),
        file('.jevitate/journeys/buy.json', JSON.stringify({ id: 'buy', job: 'buy' })),
        file('src/pages/buy.ts', 'export const route = "/buy";'),
      ],
    },
  });
  const job = doc.proposals.find((p) => p.feature === 'jevitate-jobs:job:buy' && p.path === 'src/pages/buy.ts');
  assert.equal(job?.confidence, 'low');
});

test('bootstrap proposes cpm:d-api and cpm:d-docs from the cpm@0.4.0 plan.get fixture', async () => {
  const doc = await bootstrap({
    hopPath: 'hop.json',
    modelId: 'm1',
    dir: '/project',
    deps: {
      loadHop: manifest,
      planGraph: planGetFixture(),
      files: [file('api.ts'), file('docs.md')],
    },
  });
  const features = [...new Set(doc.proposals.map((p) => p.feature))].filter((f) => f.startsWith('cpm:'));
  assert.deepEqual(features, ['cpm:d-api', 'cpm:d-docs']);
});

test('bootstrap proposes a medium tests link when a test name names a deliverable', async () => {
  const doc = await bootstrap({
    hopPath: 'hop.json',
    modelId: 'm1',
    dir: '/project',
    deps: {
      loadHop: manifest,
      planGraph: { deliverables: [{ id: 'd1', title: 'Login flow', owned_files: ['src/login.ts'] }] },
      files: [file('src/login.ts'), file('src/login.test.ts', "test('Login flow accepts valid credentials', () => {});")],
    },
  });
  const link = doc.proposals.find((p) => p.feature === 'cpm:d1' && p.path === 'src/login.test.ts');
  assert.equal(link?.observation, 'tests');
});

test('bootstrap writes the proposals file and sends no crossmatrix command', () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  const out = join(dir, 'proposals.json');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'a.ts'), 'x');
  spawnSync('git', ['add', 'a.ts'], { cwd: dir });
  spawnSync(NODE, [JUNIOR, 'matrix', 'bootstrap', '--hop', hop, '--model', 'm1', '--dir', dir, '--out', out], {
    encoding: 'utf8',
  });
  assert.equal(existsSync(log), false);
});

// --- confirm ----------------------------------------------------------------

test('confirm with --min high sends only high-confidence proposals', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  const file = proposalsFile(dir, [
    proposal({ id: 'hi', feature: 'cpm:d1', path: 'src/a.ts', confidence: 'high' }),
    proposal({ id: 'lo', feature: 'cpm:d1', path: 'src/b.ts', confidence: 'medium' }),
  ]);
  await confirmProposals({ hopPath: hop, modelId: 'm1', proposalsPath: file, min: 'high' });
  const confidences = observes(log).map((r) => r.op.confidence);
  assert.deepEqual(confidences, ['high']);
});

test('confirming the same proposals twice produces identical request ids', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  const file = proposalsFile(dir, [proposal({ id: 'p1' }), proposal({ id: 'p2', path: 'src/b.ts' })]);
  await confirmProposals({ hopPath: hop, modelId: 'm1', proposalsPath: file });
  const first = observes(log).map((r) => r.requestId);
  await confirmProposals({ hopPath: hop, modelId: 'm1', proposalsPath: file });
  const second = observes(log).map((r) => r.requestId).slice(first.length);
  assert.deepEqual(second, first);
});

test('confirm excludes proposals named by --exclude', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  const file = proposalsFile(dir, [
    proposal({ id: 'keep', path: 'src/keep.ts' }),
    proposal({ id: 'drop', path: 'src/drop.ts' }),
  ]);
  await confirmProposals({ hopPath: hop, modelId: 'm1', proposalsPath: file, exclude: ['drop'] });
  const targets = observes(log).map((r) => r.op.to);
  assert.deepEqual(targets, ['loc:src/keep.ts']);
});

// --- autolink ---------------------------------------------------------------

test('autolink links a completed deliverable whose evidence names an existing result.json', async () => {
  const dir = workdir();
  const result = resultFile(dir, 'J-1', ['src/a.ts']);
  const sent: any[] = [];
  const deps = {
    loadHop: manifest,
    callHop: async (_hop: string, tool: string, request: any) => {
      if (tool === 'cpm') {
        return {
          ok: true,
          result: {
            plan_id: 'plan1',
            graph: {
              deliverables: [
                { id: 'd1', owned_files: ['src/a.ts'], status: { status: 'complete' }, evidence: [result] },
                { id: 'd2', owned_files: ['src/b.ts'], status: { status: 'pending' } },
              ],
            },
          },
        };
      }
      sent.push(request.arguments.request);
      return { ok: true, result: {} };
    },
  };
  await autolink({ hopPath: 'hop.json', modelId: 'm1', planId: 'plan1', deps: deps as any });
  const targets = sent.filter((r) => r.op.kind === 'observe').map((r) => r.op.to);
  assert.deepEqual(targets, ['loc:src/a.ts']);
});

test('autolink reads a completed status from a cpm plan.status response', async () => {
  const dir = workdir();
  const result = resultFile(dir, 'J-1', ['src/a.ts']);
  const sent: any[] = [];
  const deps = {
    loadHop: manifest,
    callHop: async (_hop: string, _tool: string, request: any) => {
      if (request.tool === 'plan.get') {
        return {
          ok: true,
          result: { graph: { deliverables: [{ id: 'd1', owned_files: ['src/a.ts'], evidence: [result] }] } },
        };
      }
      if (request.tool === 'plan.status') {
        return { ok: true, result: { deliverables: [['d1', { status: 'complete' }, 1, 0, 0]] } };
      }
      sent.push(request.arguments.request);
      return { ok: true, result: {} };
    },
  };
  await autolink({ hopPath: 'hop.json', modelId: 'm1', planId: 'plan1', deps: deps as any });
  const targets = sent.filter((r) => r.op.kind === 'observe').map((r) => r.op.to);
  assert.deepEqual(targets, ['loc:src/a.ts']);
});

test('autolink skips a completed deliverable whose evidence result.json is missing', async () => {
  const dir = workdir();
  const sent: any[] = [];
  const deps = {
    loadHop: manifest,
    callHop: async (_hop: string, tool: string, request: any) => {
      if (tool === 'cpm') {
        return {
          ok: true,
          result: {
            graph: {
              deliverables: [
                { id: 'd1', owned_files: ['src/a.ts'], status: { status: 'complete' }, evidence: [join(dir, 'missing.json')] },
              ],
            },
          },
        };
      }
      sent.push(request.arguments.request);
      return { ok: true, result: {} };
    },
  };
  await autolink({ hopPath: 'hop.json', modelId: 'm1', planId: 'plan1', deps: deps as any });
  assert.equal(sent.filter((r) => r.op.kind === 'observe').length, 0);
});
