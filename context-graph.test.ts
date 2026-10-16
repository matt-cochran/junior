// Behavioral tests for the context-graph read side: turning the Crossmatrix
// store into a deterministic task-context slice, a contract `context` array,
// and impact-driven checks.
//
// Every scenario is offline. Unit scenarios inject `callHop`/`loadHop`; CLI
// scenarios use the fake MCP fixture. Each test asserts exactly one observable
// outcome through a public interface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHop } from './tools/tools.ts';
import {
  contractContext,
  graphSlice,
  impactChecks,
  type GraphSlice,
} from './context-graph.ts';

const NODE = process.execPath;
const JUNIOR = join(import.meta.dirname, 'junior.ts');
const FAKE = join(import.meta.dirname, 'tools', 'test-fixtures', 'fake-mcp.mjs');

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-graph-'));
}

/** A trace hop as the Crossmatrix server reports it. */
function hop(overrides: Record<string, unknown> = {}): any {
  return {
    direction: 'out',
    member: 'loc:src/a.ts',
    observations: ['implements'],
    relation: 'codemap-cpm',
    relationType: 'implements',
    confidence: 'high',
    ...overrides,
  };
}

/** Injected deps returning per-member trace hops; no network, no processes. */
function injected(adjacency: Record<string, any[]>, extra: Record<string, unknown> = {}): any {
  return {
    callHop: async (_hopPath: string, _tool: string, request: any) => {
      const q = request?.arguments?.request?.query ?? {};
      const hops = q.kind === 'trace' ? adjacency[q.member] ?? [] : [];
      return {
        ok: true,
        tool: 'crossmatrix',
        toolName: 'crossmatrix.query',
        revision: 1,
        kind: 'read',
        isError: false,
        unsupported: false,
        note: null,
        result: { hops, nextCursor: null },
      };
    },
    loadHop: () => ({ tools: { crossmatrix: { sourceVersion: '0.4.0' } } }),
    ...extra,
  };
}

function writeHop(dir: string, sourceVersion: string, extraEnv: Record<string, string> = {}): string {
  const hop = join(dir, 'hop.json');
  initHop(hop, {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: {
      crossmatrix: {
        command: NODE,
        args: [FAKE],
        env: { FAKE_MCP_MODE: 'crossmatrix', ...extraEnv },
        sourceVersion,
        sourceSha: '0'.repeat(64),
      },
    },
  });
  return hop;
}

function queryResponses(dir: string, responses: Record<string, unknown>): string {
  const target = join(dir, 'queries.json');
  writeFileSync(target, JSON.stringify(responses));
  return target;
}

// --- graphSlice -------------------------------------------------------------

test('graphSlice from a cpm deliverable seed includes the owned file', async () => {
  const slice = await graphSlice({
    hopPath: 'hop.json',
    modelId: 'm1',
    seeds: ['cpm:d1'],
    deps: injected({ 'cpm:d1': [hop({ member: 'loc:src/app.ts' })] }),
  });
  assert.ok(slice.nodes.some((node) => node.member === 'loc:src/app.ts'));
});

test('graphSlice from a cpm deliverable seed reaches a test linked through the owned file', async () => {
  const slice = await graphSlice({
    hopPath: 'hop.json',
    modelId: 'm1',
    seeds: ['cpm:d1'],
    deps: injected({
      'cpm:d1': [hop({ member: 'loc:src/app.ts' })],
      'loc:src/app.ts': [hop({ direction: 'in', member: 'loc:src/app.test.ts', observations: ['tests'] })],
    }),
  });
  assert.ok(slice.nodes.some((node) => node.member === 'loc:src/app.test.ts'));
});

test('graphSlice from a jevitate outcome seed reaches the journey that verifies it', async () => {
  const slice = await graphSlice({
    hopPath: 'hop.json',
    modelId: 'm1',
    seeds: ['outcome:o1'],
    deps: injected({ 'outcome:o1': [hop({ member: 'journey:j1', relation: 'verifies' })] }),
  });
  assert.ok(slice.nodes.some((node) => node.member === 'journey:j1'));
});

test('graphSlice from a jevitate outcome seed reaches the file mapped by the linked journey', async () => {
  const slice = await graphSlice({
    hopPath: 'hop.json',
    modelId: 'm1',
    seeds: ['outcome:o1'],
    deps: injected({
      'outcome:o1': [hop({ member: 'journey:j1', relation: 'verifies' })],
      'journey:j1': [hop({ member: 'loc:src/checkout.ts', relation: 'codemap-jevitate-journeys' })],
    }),
  });
  assert.ok(slice.nodes.some((node) => node.member === 'loc:src/checkout.ts'));
});

test('graphSlice stops at maxNodes and reports the cut', async () => {
  const slice = await graphSlice({
    hopPath: 'hop.json',
    modelId: 'm1',
    seeds: ['cpm:d1'],
    maxNodes: 1,
    deps: injected({
      'cpm:d1': [hop({ member: 'loc:src/a.ts' }), hop({ member: 'loc:src/b.ts' })],
    }),
  });
  assert.equal(slice.truncated, true);
});

test('graphSlice records a high-confidence link to a member reached by a low-confidence one too', async () => {
  const slice = await graphSlice({
    hopPath: 'hop.json',
    modelId: 'm1',
    seeds: ['cpm:d1'],
    deps: injected({
      'cpm:d1': [
        hop({ member: 'loc:src/a.ts', confidence: 'low' }),
        hop({ member: 'loc:src/a.ts', confidence: 'high' }),
      ],
    }),
  });
  const node = slice.nodes.find((entry) => entry.member === 'loc:src/a.ts');
  assert.equal(node?.confidence, 'high');
});

// --- contractContext --------------------------------------------------------

function sliceOf(nodes: GraphSlice['nodes'], edges: GraphSlice['edges'] = []): GraphSlice {
  return {
    modelId: 'm1',
    seeds: [],
    depth: 3,
    maxNodes: 60,
    nodes,
    edges,
    truncated: false,
    cut: null,
  };
}

test('contractContext deduplicates a path reachable by two observations', () => {
  const result = contractContext(
    sliceOf([
      { member: 'loc:src/app.ts', kind: 'file', path: 'src/app.ts', depth: 1, confidence: 'high', stale: false, observation: 'implements', standing: null },
      { member: 'loc:src/app.ts', kind: 'file', path: 'src/app.ts', depth: 2, confidence: 'low', stale: false, observation: 'touches', standing: null },
    ]),
  );
  assert.deepEqual(result.context.map((entry) => entry.path), ['src/app.ts']);
});

test('contractContext summarizes related outcomes, risks, claims and notes', () => {
  const result = contractContext(
    sliceOf([
      { member: 'job:j1/outcome:fast', kind: 'outcome', depth: 1, confidence: 'high', stale: false, observation: null, standing: null },
      { member: 'fm:f1', kind: 'failure-mode', depth: 1, confidence: 'high', stale: false, observation: null, standing: null },
      { member: 'claim:c1', kind: 'claim', depth: 1, confidence: 'medium', stale: false, observation: null, standing: 'supported' },
      { member: 'adr:1', kind: 'adr', depth: 1, confidence: 'medium', stale: false, observation: null, standing: null },
      { member: 'hypothesis:h1', kind: 'hypothesis', depth: 1, confidence: 'low', stale: false, observation: null, standing: null },
    ]),
  );
  assert.deepEqual(result.evidence, {
    outcomes: ['job:j1/outcome:fast'],
    risks: ['fm:f1'],
    claims: [{ member: 'claim:c1', standing: 'supported' }],
    notes: ['adr:1', 'hypothesis:h1'],
  });
});

// --- impactChecks -----------------------------------------------------------

test('impactChecks turns a changed file linked to a .test.ts file into a node --test check', async () => {
  const result = await impactChecks({
    hopPath: 'hop.json',
    modelId: 'm1',
    changedFiles: ['src/app.ts'],
    deps: injected({
      'loc:src/app.ts': [hop({ direction: 'in', member: 'loc:src/app.test.ts', observations: ['tests'] })],
    }),
  });
  assert.deepEqual(result.checks, [
    {
      kind: 'test',
      source: 'src/app.ts',
      file: 'src/app.test.ts',
      command: 'node',
      args: ['--test', 'src/app.test.ts'],
    },
  ]);
});

test('impactChecks turns a changed file linked to a tests/<name>.rs file into a cargo check', async () => {
  const result = await impactChecks({
    hopPath: 'hop.json',
    modelId: 'm1',
    changedFiles: ['src/lib.rs'],
    deps: injected({
      'loc:src/lib.rs': [hop({ direction: 'in', member: 'loc:tests/parser.rs', observations: ['tests'] })],
    }),
  });
  assert.deepEqual(result.checks, [
    {
      kind: 'test',
      source: 'src/lib.rs',
      file: 'tests/parser.rs',
      command: 'cargo',
      args: ['test', '--test', 'parser'],
    },
  ]);
});

test('impactChecks adds a jevitate check for a linked journey suite when the CLI exists', async () => {
  const result = await impactChecks({
    hopPath: 'hop.json',
    modelId: 'm1',
    changedFiles: ['src/checkout.ts'],
    deps: injected(
      {
        'loc:src/checkout.ts': [hop({ member: 'journey:j1', relation: 'codemap-jevitate-journeys' })],
      },
      { hasJevitate: () => true },
    ),
  });
  assert.deepEqual(result.checks, [
    {
      kind: 'jevitate',
      source: 'src/checkout.ts',
      file: '.jevitate/journeys/j1.json',
      command: 'jevitate',
      args: ['check', '--suite', '.jevitate/journeys/j1.json'],
    },
  ]);
});

// --- CLI --------------------------------------------------------------------

test('junior matrix graph prints the slice and the context array', () => {
  const dir = workdir();
  const responses = queryResponses(dir, {
    trace: { hops: [hop({ member: 'loc:src/app.ts' })], nextCursor: null },
  });
  const hopPath = writeHop(dir, '0.4.0', { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const cli = spawnSync(
    NODE,
    [JUNIOR, 'matrix', 'graph', '--hop', hopPath, '--model', 'm1', '--seed', 'cpm:d1', '--json'],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(cli.stdout);
  assert.deepEqual(Object.keys(parsed).sort(), ['context', 'slice']);
});

test('junior matrix graph impact prints a node --test check for a linked test', () => {
  const dir = workdir();
  const responses = queryResponses(dir, {
    trace: { hops: [hop({ direction: 'in', member: 'loc:src/app.test.ts', observations: ['tests'] })], nextCursor: null },
  });
  const hopPath = writeHop(dir, '0.4.0', { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const resultPath = join(dir, 'result.json');
  writeFileSync(resultPath, JSON.stringify({ evidence: { runChangedFiles: ['src/app.ts'] } }));
  const cli = spawnSync(
    NODE,
    [JUNIOR, 'matrix', 'graph', '--hop', hopPath, '--model', 'm1', '--impact', '--result', resultPath, '--json'],
    { encoding: 'utf8' },
  );
  assert.deepEqual(JSON.parse(cli.stdout).checks.map((check: any) => check.command), ['node']);
});

test('junior matrix graph produces byte-identical JSON for identical inputs', () => {
  const dir = workdir();
  const responses = queryResponses(dir, {
    trace: { hops: [hop({ member: 'loc:src/app.ts' })], nextCursor: null },
  });
  const hopPath = writeHop(dir, '0.4.0', { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const args = [JUNIOR, 'matrix', 'graph', '--hop', hopPath, '--model', 'm1', '--seed', 'cpm:d1', '--json'];
  const first = spawnSync(NODE, args, { encoding: 'utf8' }).stdout;
  const second = spawnSync(NODE, args, { encoding: 'utf8' }).stdout;
  assert.equal(first, second);
});
