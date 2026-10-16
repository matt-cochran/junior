// Behavioral tests for the advisory Crossmatrix link audit (`junior matrix qc`).
//
// Every scenario is offline: a fake `callHop` stands in for the MCP fixture, a
// fake git probe stands in for the checkout, and an injected `GateClassifier`
// stands in for Jev. Each test is atomic (one behavioral assertion) and drives a
// public interface (`linkQc` or the CLI).
//
// This file is written before the implementation: it describes the required
// behavior and must fail until `link-qc.ts` exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHop } from './tools/tools.ts';
import { MAX_GATE_QUESTIONS, type GateClassifier, type GateClassifierResult } from './worker.ts';
import { linkQc, type LinkQcGit } from './link-qc.ts';

const NODE = process.execPath;
const JUNIOR = join(import.meta.dirname, 'junior.ts');
const FAKE = join(import.meta.dirname, 'tools', 'test-fixtures', 'fake-mcp.mjs');

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-link-qc-'));
}

// --- Crossmatrix query fixtures ---------------------------------------------

/** One observation on a cell, as the `slice` query reports it. */
function obs(overrides: Record<string, unknown> = {}): any {
  return {
    observation: 'implements',
    confidence: 'high',
    provenanceClass: 'observed',
    rationale: 'changed by Junior handoff H1',
    evidence: [
      {
        excerpt: 'Junior handoff H1 (passed)',
        locator: 'art',
        sourceRef: { system: 'junior', sourceType: 'handoff', sourceRef: 'junior-handoff:H1' },
      },
    ],
    ...overrides,
  };
}

function cell(from: string, to: string, observations: any[]): any {
  return { from, to, observations };
}

function relation(id = 'codemap-cpm'): any {
  return { id, from: 'cpm', to: 'code', relationType: 'implements', scale: 'codemap', cells: 1, coveragePolicy: 'none' };
}

interface FixtureOptions {
  relations?: any[];
  cells?: Record<string, any[]>;
  orphans?: any[];
  coverage?: any;
  traceHops?: any[];
}

/** An offline `callHop` that answers the query kinds `linkQc` uses. */
function fixture(options: FixtureOptions = {}): {
  callHop: any;
  writes: string[];
} {
  const writes: string[] = [];
  const relations = options.relations ?? [];
  const cells = options.cells ?? {};
  const callHop = async (_hopPath: string, _tool: string, request: any) => {
    const tool = request?.tool;
    if (tool === 'crossmatrix.command') {
      writes.push(request?.arguments?.request?.op?.kind ?? 'command');
      return { ok: true, result: { ok: true } };
    }
    const q = request?.arguments?.request?.query ?? {};
    let result: unknown = {};
    if (q.kind === 'describe') {
      result = { describe: { modelId: 'm1', dimensions: [], scales: [], contractions: [], relations } };
    } else if (q.kind === 'slice') {
      result = { relation: q.relationId, cells: cells[q.relationId] ?? [], nextCursor: null, total: (cells[q.relationId] ?? []).length };
    } else if (q.kind === 'gaps.orphans') {
      result = { orphans: options.orphans ?? [], links: [] };
    } else if (q.kind === 'coverage') {
      result = options.coverage ?? { axes: [], summary: { axes: 0, uncovered: 0, violations: 0 }, links: [] };
    } else if (q.kind === 'trace') {
      result = { hops: options.traceHops ?? [], members: [], nextCursor: null, total: (options.traceHops ?? []).length };
    }
    return {
      ok: true,
      tool: 'crossmatrix',
      toolName: 'crossmatrix.query',
      revision: 1,
      kind: 'read',
      isError: false,
      unsupported: false,
      note: null,
      result,
    };
  };
  return { callHop, writes };
}

const loadHop = () => ({ tools: { crossmatrix: { sourceVersion: '0.4.0' } } });

/** A git probe where nothing is stale. */
const liveGit: LinkQcGit = { pathExists: () => true, lastChange: () => null };

/** A git probe where the named path has been deleted. */
function missingGit(paths: string[]): LinkQcGit {
  const gone = new Set(paths);
  return { pathExists: (p: string) => !gone.has(p), lastChange: () => null };
}

/** An injected classifier returning a fixed probability for every question. */
function classifierAt(probability: number, calls: number[] = []): GateClassifier {
  return async ({ questions }) => {
    calls.push(Object.keys(questions).length);
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(questions)) answers[id] = { type: 'bool', probability };
    return { answers, provider: 'fake', model: 'fake' } satisfies GateClassifierResult;
  };
}

// --- plausibility -----------------------------------------------------------

test('linkQc reports a link the classifier judges unsupported as implausible', async () => {
  const f = fixture({
    relations: [relation()],
    cells: { 'codemap-cpm': [cell('cpm:d1', 'loc:src/a.ts', [obs()])] },
  });
  const result = await linkQc({
    hopPath: 'hop.json',
    modelId: 'm1',
    deps: { callHop: f.callHop, loadHop, git: liveGit, classify: classifierAt(0.2) },
  });
  assert.ok(result.findings.some((finding) => finding.kind === 'implausible'));
});

test('linkQc suggests re-link or deprecate for an implausible link', async () => {
  const f = fixture({
    relations: [relation()],
    cells: { 'codemap-cpm': [cell('cpm:d1', 'loc:src/a.ts', [obs()])] },
  });
  const result = await linkQc({
    hopPath: 'hop.json',
    modelId: 'm1',
    deps: { callHop: f.callHop, loadHop, git: liveGit, classify: classifierAt(0.2) },
  });
  const finding = result.findings.find((entry) => entry.kind === 'implausible');
  assert.ok(finding && ['re-link', 'deprecate'].includes(finding.suggestedAction));
});

test('linkQc labels a mid-range classifier answer uncertain', async () => {
  const f = fixture({
    relations: [relation()],
    cells: { 'codemap-cpm': [cell('cpm:d1', 'loc:src/a.ts', [obs()])] },
  });
  const result = await linkQc({
    hopPath: 'hop.json',
    modelId: 'm1',
    deps: { callHop: f.callHop, loadHop, git: liveGit, classify: classifierAt(0.5) },
  });
  assert.ok(result.findings.some((finding) => finding.kind === 'uncertain'));
});

test('linkQc asks the plausibility question with the relation and member endpoints', async () => {
  const f = fixture({
    relations: [relation()],
    cells: { 'codemap-cpm': [cell('cpm:d1', 'loc:src/a.ts', [obs()])] },
  });
  let instructions = '';
  const classify: GateClassifier = async ({ questions }) => {
    instructions = Object.values(questions)[0].instructions;
    return { answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'bool', probability: 0.9 }])) };
  };
  await linkQc({
    hopPath: 'hop.json',
    modelId: 'm1',
    deps: { callHop: f.callHop, loadHop, git: liveGit, classify },
  });
  assert.match(instructions, /codemap-cpm.*cpm:d1.*loc:src\/a\.ts/);
});

// --- scoping and cap --------------------------------------------------------

test('linkQc reports a seed scope when --seed members are given', async () => {
  const f = fixture({
    traceHops: [{ direction: 'out', member: 'loc:src/a.ts', relation: 'codemap-cpm', observations: ['implements'] }],
    cells: { 'codemap-cpm': [cell('cpm:d1', 'loc:src/a.ts', [obs()])] },
  });
  const result = await linkQc({
    hopPath: 'hop.json',
    modelId: 'm1',
    seeds: ['cpm:d1'],
    noJev: true,
    deps: { callHop: f.callHop, loadHop, git: liveGit },
  });
  assert.equal(result.scoped, 'seed');
});

test('linkQc caps the audited links at maxLinks', async () => {
  const f = fixture({
    relations: [relation()],
    cells: { 'codemap-cpm': [cell('cpm:d1', 'loc:src/a.ts', [obs()]), cell('cpm:d1', 'loc:src/b.ts', [obs()])] },
  });
  const result = await linkQc({
    hopPath: 'hop.json',
    modelId: 'm1',
    maxLinks: 1,
    noJev: true,
    deps: { callHop: f.callHop, loadHop, git: liveGit },
  });
  assert.equal(result.links, 1);
});

// --- batching ---------------------------------------------------------------

test('linkQc keeps every classifier batch within MAX_GATE_QUESTIONS', async () => {
  const cells = Array.from({ length: 45 }, (_, i) => cell(`cpm:d${i}`, `loc:src/f${i}.ts`, [obs()]));
  const f = fixture({ relations: [relation()], cells: { 'codemap-cpm': cells } });
  const batches: number[] = [];
  const classify: GateClassifier = async ({ questions }) => {
    batches.push(Object.keys(questions).length);
    return { answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'bool', probability: 0.9 }])) };
  };
  await linkQc({
    hopPath: 'hop.json',
    modelId: 'm1',
    deps: { callHop: f.callHop, loadHop, git: liveGit, classify },
  });
  assert.ok(Math.max(...batches) <= MAX_GATE_QUESTIONS);
});

// --- stale ------------------------------------------------------------------

test('linkQc marks a link to a missing loc target stale', async () => {
  const f = fixture({
    relations: [relation()],
    cells: { 'codemap-cpm': [cell('cpm:d1', 'loc:src/gone.ts', [obs()])] },
  });
  const result = await linkQc({
    hopPath: 'hop.json',
    modelId: 'm1',
    deps: { callHop: f.callHop, loadHop, git: missingGit(['src/gone.ts']) },
  });
  assert.ok(result.findings.some((finding) => finding.kind === 'stale'));
});

test('linkQc does not ask the classifier about a stale link', async () => {
  const f = fixture({
    relations: [relation()],
    cells: { 'codemap-cpm': [cell('cpm:d1', 'loc:src/gone.ts', [obs()])] },
  });
  const calls: number[] = [];
  await linkQc({
    hopPath: 'hop.json',
    modelId: 'm1',
    deps: { callHop: f.callHop, loadHop, git: missingGit(['src/gone.ts']), classify: classifierAt(0.2, calls) },
  });
  assert.equal(calls.length, 0);
});

// --- contradictions ---------------------------------------------------------

test('linkQc reports conflicting observations on one pair as a contradiction', async () => {
  const f = fixture({
    relations: [relation()],
    cells: { 'codemap-cpm': [cell('cpm:d1', 'loc:src/a.ts', [obs({ observation: 'implements' }), obs({ observation: 'tests' })])] },
  });
  const result = await linkQc({
    hopPath: 'hop.json',
    modelId: 'm1',
    noJev: true,
    deps: { callHop: f.callHop, loadHop, git: liveGit },
  });
  assert.ok(result.findings.some((finding) => finding.kind === 'contradiction'));
});

// --- coverage gaps ----------------------------------------------------------

test('linkQc reports a desired outcome with no verifying journey as a coverage gap', async () => {
  const f = fixture({ relations: [], orphans: [{ dimension: 'jevitate-jobs', member: 'job:j1/outcome:fast' }] });
  const result = await linkQc({
    hopPath: 'hop.json',
    modelId: 'm1',
    noJev: true,
    deps: { callHop: f.callHop, loadHop, git: liveGit },
  });
  assert.ok(result.findings.some((finding) => finding.kind === 'coverage-gap'));
});

test('linkQc reports a feature with links but no tests link as a coverage gap', async () => {
  const f = fixture({
    relations: [relation()],
    cells: { 'codemap-cpm': [cell('feature:f1', 'loc:src/a.ts', [obs({ observation: 'implements' })])] },
  });
  const result = await linkQc({
    hopPath: 'hop.json',
    modelId: 'm1',
    noJev: true,
    deps: { callHop: f.callHop, loadHop, git: liveGit },
  });
  assert.ok(result.findings.some((finding) => finding.kind === 'coverage-gap' && finding.link?.from === 'feature:f1'));
});

// --- --no-jev and writes ----------------------------------------------------

test('linkQc with noJev makes no classifier call', async () => {
  const f = fixture({
    relations: [relation()],
    cells: { 'codemap-cpm': [cell('cpm:d1', 'loc:src/a.ts', [obs()])] },
  });
  const calls: number[] = [];
  await linkQc({
    hopPath: 'hop.json',
    modelId: 'm1',
    noJev: true,
    deps: { callHop: f.callHop, loadHop, git: liveGit, classify: classifierAt(0.2, calls) },
  });
  assert.equal(calls.length, 0);
});

test('linkQc never sends a crossmatrix write', async () => {
  const f = fixture({
    relations: [relation()],
    cells: { 'codemap-cpm': [cell('cpm:d1', 'loc:src/a.ts', [obs()])] },
  });
  await linkQc({
    hopPath: 'hop.json',
    modelId: 'm1',
    noJev: true,
    deps: { callHop: f.callHop, loadHop, git: liveGit },
  });
  assert.deepEqual(f.writes, []);
});

// --- CLI --------------------------------------------------------------------

function writeHop(dir: string, extraEnv: Record<string, string> = {}): string {
  const hop = join(dir, 'hop.json');
  initHop(hop, {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: {
      crossmatrix: {
        command: NODE,
        args: [FAKE],
        env: { FAKE_MCP_MODE: 'crossmatrix', ...extraEnv },
        sourceVersion: '0.4.0',
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

test('junior matrix qc prints a JSON review queue', () => {
  const dir = workdir();
  const responses = queryResponses(dir, {
    describe: { describe: { modelId: 'm1', dimensions: [], scales: [], contractions: [], relations: [] } },
    'gaps.orphans': { orphans: [{ dimension: 'jevitate-jobs', member: 'job:j1/outcome:fast' }], links: [] },
  });
  const hopPath = writeHop(dir, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const cli = spawnSync(NODE, [JUNIOR, 'matrix', 'qc', '--hop', hopPath, '--model', 'm1', '--no-jev'], {
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(cli.stdout).findings.length, 1);
});

test('junior matrix qc --no-jev reports a deleted loc link stale', () => {
  const dir = workdir();
  const responses = queryResponses(dir, {
    describe: {
      describe: {
        modelId: 'm1',
        dimensions: [],
        scales: [],
        contractions: [],
        relations: [relation()],
      },
    },
    slice: { relation: 'codemap-cpm', cells: [cell('cpm:d1', 'loc:src/gone.ts', [obs()])], nextCursor: null, total: 1 },
  });
  const hopPath = writeHop(dir, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const cli = spawnSync(
    NODE,
    [JUNIOR, 'matrix', 'qc', '--hop', hopPath, '--model', 'm1', '--dir', dir, '--no-jev'],
    { encoding: 'utf8' },
  );
  assert.ok(JSON.parse(cli.stdout).findings.some((finding: any) => finding.kind === 'stale'));
});

test('junior matrix qc --md emits a Markdown review queue', () => {
  const dir = workdir();
  const responses = queryResponses(dir, {
    describe: { describe: { modelId: 'm1', dimensions: [], scales: [], contractions: [], relations: [] } },
    'gaps.orphans': { orphans: [{ dimension: 'jevitate-jobs', member: 'job:j1/outcome:fast' }], links: [] },
  });
  const hopPath = writeHop(dir, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const cli = spawnSync(NODE, [JUNIOR, 'matrix', 'qc', '--hop', hopPath, '--model', 'm1', '--no-jev', '--md'], {
    encoding: 'utf8',
  });
  assert.match(cli.stdout, /^# Link QC/);
});

test('junior matrix qc --no-jev emits deterministic JSON for identical inputs', () => {
  const dir = workdir();
  const responses = queryResponses(dir, {
    describe: { describe: { modelId: 'm1', dimensions: [], scales: [], contractions: [], relations: [] } },
    'gaps.orphans': { orphans: [{ dimension: 'jevitate-jobs', member: 'job:j1/outcome:fast' }], links: [] },
  });
  const hopPath = writeHop(dir, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const args = [JUNIOR, 'matrix', 'qc', '--hop', hopPath, '--model', 'm1', '--no-jev'];
  const first = spawnSync(NODE, args, { encoding: 'utf8' }).stdout;
  const second = spawnSync(NODE, args, { encoding: 'utf8' }).stdout;
  assert.equal(first, second);
});
