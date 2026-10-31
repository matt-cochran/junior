// Behavioral tests for the Code-map write side: declaring the feature-to-code
// configuration and recording a handoff's changed files as `implements` links.
//
// Every scenario is offline: it uses its own temp hop + fake MCP write log (or
// a temp result.json). Each test asserts exactly one observable outcome through
// a public module/CLI interface and never inspects source text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { callHop, initHop } from './tools/tools.ts';
import {
  codemapContext,
  codemapFeatures,
  codemapFiles,
  codemapInit,
  codemapLink,
  codemapStale,
  DEFAULT_CODE_EXCLUDES,
  isCodeRosterPath,
  loadCodeExcludes,
} from './codemap.ts';

const NODE = process.execPath;
const JUNIOR = join(import.meta.dirname, 'junior.ts');
const FAKE = join(import.meta.dirname, 'tools', 'test-fixtures', 'fake-mcp.mjs');

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-codemap-'));
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

/** A hop whose crossmatrix command logs its pid before delegating to FAKE. */
function writePidLoggingHop(dir: string, sourceVersion: string, log: string, pids: string, extraEnv: Record<string, string> = {}): string {
  const script = join(dir, 'pid-server.mjs');
  writeFileSync(script, `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(pids)}, String(process.pid) + "\\n");\nawait import(${JSON.stringify(FAKE)});\n`);
  const hop = join(dir, 'hop.json');
  initHop(hop, {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: {
      crossmatrix: {
        command: NODE,
        args: [script],
        env: { FAKE_MCP_MODE: 'crossmatrix', FAKE_CROSSMATRIX_WRITES: log, ...extraEnv },
        sourceVersion,
        sourceSha: '0'.repeat(64),
      },
    },
  });
  return hop;
}

function readPids(log: string): number[] {
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).map(Number);
}

type StrictOp = Record<string, unknown>;

async function strictCommand(hopPath: string, modelId: string, requestId: string, op: StrictOp): Promise<void> {
  await callHop(hopPath, 'crossmatrix', {
    tool: 'crossmatrix.command',
    arguments: {
      request: {
        schemaVersion: '0.3.0',
        requestId,
        modelId,
        actor: { actorType: 'system', persona: 'model_admin' },
        op,
      },
    },
  });
}

async function seedStrictModel(hopPath: string, modelId: string): Promise<void> {
  await strictCommand(hopPath, modelId, 'seed-dimension-cpm', { kind: 'dimension.register', dimensionId: 'cpm' });
  await strictCommand(hopPath, modelId, 'seed-members-cpm', {
    kind: 'members.sync',
    dimensionId: 'cpm',
    members: [{ id: 'cpm:d1' }],
  });
  await strictCommand(hopPath, modelId, 'seed-dimension-code', { kind: 'dimension.register', dimensionId: 'code' });
  await strictCommand(hopPath, modelId, 'seed-members-code', {
    kind: 'members.sync',
    dimensionId: 'code',
    members: [{ id: 'loc:src/a.ts' }],
  });
}

function strictStatePath(dir: string): string {
  return join(dir, 'crossmatrix-state.json');
}

function strictRelations(dir: string, modelId: string): string[] {
  const state = JSON.parse(readFileSync(strictStatePath(dir), 'utf8'));
  return Object.keys(state.models[modelId]?.relations ?? {}).sort();
}

/** Opt-in fake crossmatrix query results, keyed by query kind. */
function queryResponses(dir: string, responses: Record<string, unknown>): string {
  const target = join(dir, 'queries.json');
  writeFileSync(target, JSON.stringify(responses));
  return target;
}

/** A trace hop as the Crossmatrix 0.3 server reports it. */
function hop(overrides: Record<string, unknown> = {}): any {
  return {
    dimension: 'code',
    direction: 'out',
    member: 'loc:src/a.ts',
    observations: ['implements'],
    relation: 'codemap-cpm',
    relationType: 'implements',
    ...overrides,
  };
}

/** A temp git repository whose tracked files hold `contents`. */
function gitRepo(contents: Record<string, string>): string {
  const dir = workdir();
  spawnSync('git', ['init', '-q'], { cwd: dir });
  for (const [p, content] of Object.entries(contents)) {
    const abs = join(dir, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    spawnSync('git', ['add', p], { cwd: dir });
  }
  return dir;
}

function gitRepoWithConfig(contents: Record<string, string>): string {
  const dir = gitRepo(contents);
  spawnSync('git', ['add', '.'], { cwd: dir });
  return dir;
}

function gitOutput(dir: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A committed temp repository, so links can carry real git anchors. */
function committedRepo(contents: Record<string, string>): string {
  const dir = gitRepoWithConfig(contents);
  gitOutput(dir, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'initial']);
  return dir;
}

function commitAll(dir: string, message: string): void {
  gitOutput(dir, ['add', '-A']);
  gitOutput(dir, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', message]);
}

function gitLinkResponses(dir: string, path: string, commit: string, blob: string): string {
  return queryResponses(dir, {
    describe: { describe: { relations: [{ id: 'codemap-cpm' }] } },
    slice: {
      cells: [
        {
          from: 'cpm:d1',
          to: `loc:${path}`,
          relationId: 'codemap-cpm',
          // The shape crossmatrix-mcp returns: evidence lives on each observation.
          observations: [
            {
              observation: 'implements',
              provenanceClass: 'observed',
              evidence: [
                {
                  sourceRef: { system: 'git', sourceType: 'blob', sourceRef: path, locator: commit },
                  locator: blob,
                  excerpt: 'git anchor',
                },
              ],
            },
          ],
        },
      ],
      nextCursor: null,
    },
  });
}

function operations(log: string): any[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function resultFile(dir: string, changedFiles: Array<string | { path: string }>, extra: Record<string, unknown> = {}): string {
  const target = join(dir, 'result.json');
  writeFileSync(
    target,
    JSON.stringify({
      id: 'J-test',
      status: 'ready_for_review',
      artifactDir: join(dir, '.delivery', 'J-test', '1'),
      evidence: { runChangedFiles: changedFiles },
      ...extra,
    }),
  );
  return target;
}

function observes(log: string): any[] {
  return operations(log).filter((request) => request.op.kind === 'observe');
}

// --- codemapInit ------------------------------------------------------------

test('codemapInit declares the codemap scale before any relation', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  await codemapInit({ hopPath: hop, modelId: 'm1' });
  assert.equal(operations(log).map((r) => r.request ?? r).filter((r) => r.op.kind !== 'model.open')[0].op.kind, 'scale.declare');
});

test('codemapInit declares the categorical codemap scale with implements above tests above touches', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  await codemapInit({ hopPath: hop, modelId: 'm1' });
  const scale = operations(log).find((request) => request.op.kind === 'scale.declare').op.scale;
  assert.deepEqual(scale, {
    id: 'codemap',
    mode: 'categorical',
    levels: [
      { observation: 'implements', value: 9 },
      { observation: 'tests', value: 3 },
      { observation: 'touches', value: 1 },
    ],
  });
});

test('codemapInit declares one implements relation per default feature dimension', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  await codemapInit({ hopPath: hop, modelId: 'm1' });
  const relationIds = operations(log)
    .filter((request) => request.op.kind === 'relation.declare' && request.op.relationType === 'implements')
    .map((request) => request.op.relationId)
    .sort();
  assert.deepEqual(relationIds, ['codemap-cpm', 'codemap-jevitate-jobs', 'codemap-jevitate-journeys']);
});

test('codemapInit accepts a caller-supplied feature dimension list', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  await codemapInit({ hopPath: hop, modelId: 'm1', featureDimensions: ['alpha'] });
  const relationIds = operations(log)
    .filter((request) => request.op.kind === 'relation.declare' && request.op.relationType === 'implements')
    .map((request) => request.op.relationId);
  assert.deepEqual(relationIds, ['codemap-alpha']);
});

test('codemapInit declares the codemap-contains relation from code to code', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  await codemapInit({ hopPath: hop, modelId: 'm1' });
  const op = operations(log).find((request) => request.op.relationId === 'codemap-contains').op;
  assert.deepEqual({ from: op.from, to: op.to }, { from: 'code', to: 'code' });
});

test('codemapInit refuses a hop older than Crossmatrix 0.3.0', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.2.1', log);
  await assert.rejects(
    codemapInit({ hopPath: hop, modelId: 'm1' }),
    /Crossmatrix 0\.3\.0 or newer \(hop records 0\.2\.1\)/,
  );
});

test('codemapInit sends no request when the hop is too old', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.2.1', log);
  await codemapInit({ hopPath: hop, modelId: 'm1' }).catch(() => {});
  assert.equal(existsSync(log), false);
});

test('codemapInit with default dimensions notes each feature dimension the model lacks', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log, { FAKE_CROSSMATRIX_STATE: strictStatePath(dir) });
  await seedStrictModel(hop, 'm1');
  const result = await codemapInit({ hopPath: hop, modelId: 'm1' });
  assert.deepEqual(result.notes, [
    'codemap-jevitate-jobs skipped: dimension jevitate-jobs is not in model m1',
    'codemap-jevitate-journeys skipped: dimension jevitate-journeys is not in model m1',
  ]);
});

test('codemapInit with default dimensions declares only relations whose dimensions exist', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log, { FAKE_CROSSMATRIX_STATE: strictStatePath(dir) });
  await seedStrictModel(hop, 'm1');
  await codemapInit({ hopPath: hop, modelId: 'm1' });
  assert.deepEqual(strictRelations(dir, 'm1'), ['codemap-contains', 'codemap-cpm']);
});

test('codemapInit rejects an explicitly named feature dimension the model lacks', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log, { FAKE_CROSSMATRIX_STATE: strictStatePath(dir) });
  await seedStrictModel(hop, 'm1');
  await assert.rejects(
    codemapInit({ hopPath: hop, modelId: 'm1', featureDimensions: ['jevitate-jobs'] }),
    /jevitate-jobs/,
  );
});

// --- codemapLink ------------------------------------------------------------

test('codemapLink sends one observe per changed file', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  const result = resultFile(dir, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  await codemapLink({ hopPath: hop, modelId: 'm1', resultPath: result, feature: 'cpm:cpm:d1' });
  assert.equal(observes(log).length, 3);
});

test('codemapLink ignores changed files under .delivery', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  const result = resultFile(dir, ['src/a.ts', '.delivery/J-test/1/result.json']);
  await codemapLink({ hopPath: hop, modelId: 'm1', resultPath: result, feature: 'cpm:cpm:d1' });
  const targets = observes(log).map((request) => request.op.to);
  assert.deepEqual(targets, ['loc:src/a.ts']);
});

test('codemapLink defaults a test file to the tests observation', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  const result = resultFile(dir, ['src/app.test.ts']);
  await codemapLink({ hopPath: hop, modelId: 'm1', resultPath: result, feature: 'cpm:cpm:d1' });
  assert.equal(observes(log)[0].op.observation, 'tests');
});

test('codemapLink defaults a non-test file to the implements observation', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  const result = resultFile(dir, ['src/app.ts']);
  await codemapLink({ hopPath: hop, modelId: 'm1', resultPath: result, feature: 'cpm:cpm:d1' });
  assert.equal(observes(log)[0].op.observation, 'implements');
});

test('codemapLink honors an explicit observation over the test-file default', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  const result = resultFile(dir, ['src/app.test.ts']);
  await codemapLink({ hopPath: hop, modelId: 'm1', resultPath: result, feature: 'cpm:cpm:d1', observation: 'touches' });
  assert.equal(observes(log)[0].op.observation, 'touches');
});

test('codemapLink targets the feature relation and member for every file', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  const result = resultFile(dir, ['src/app.ts']);
  await codemapLink({ hopPath: hop, modelId: 'm1', resultPath: result, feature: 'cpm:cpm:d1' });
  const op = observes(log)[0].op;
  assert.deepEqual({ relationId: op.relationId, from: op.from }, { relationId: 'codemap-cpm', from: 'cpm:d1' });
});

test('codemapLink records observed high-confidence handoff evidence', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  const result = resultFile(dir, ['src/app.ts']);
  await codemapLink({ hopPath: hop, modelId: 'm1', resultPath: result, feature: 'cpm:cpm:d1' });
  const op = observes(log)[0].op;
  assert.deepEqual(
    { provenanceClass: op.provenanceClass, confidence: op.confidence, evidence: op.evidence, rationale: op.rationale },
    {
      provenanceClass: 'observed',
      confidence: 'high',
      evidence: [{ sourceRef: { system: 'junior', sourceType: 'handoff', sourceRef: 'junior-handoff:J-test', locator: join(dir, '.delivery', 'J-test', '1') }, locator: join(dir, '.delivery', 'J-test', '1'), excerpt: 'Junior handoff J-test (ready_for_review)' }],
      rationale: 'changed by Junior handoff J-test',
    },
  );
});

test('codemapLink falls back to evidence.changedFiles when runChangedFiles is absent', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  const result = resultFile(dir, [], { evidence: { changedFiles: [{ path: 'src/legacy.ts' }] } });
  await codemapLink({ hopPath: hop, modelId: 'm1', resultPath: result, feature: 'cpm:cpm:d1' });
  assert.deepEqual(observes(log).map((request) => request.op.to), ['loc:src/legacy.ts']);
});

test('codemapLink repeats identical requestIds when relinking the same result', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  const result = resultFile(dir, ['src/a.ts', 'src/b.ts']);
  await codemapLink({ hopPath: hop, modelId: 'm1', resultPath: result, feature: 'cpm:cpm:d1' });
  const first = observes(log).map((request) => request.requestId);
  await codemapLink({ hopPath: hop, modelId: 'm1', resultPath: result, feature: 'cpm:cpm:d1' });
  const second = observes(log).map((request) => request.requestId).slice(first.length);
  assert.deepEqual(second, first);
});

test('codemapLink refuses a hop older than Crossmatrix 0.3.0', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.2.1', log);
  const result = resultFile(dir, ['src/a.ts']);
  await assert.rejects(
    codemapLink({ hopPath: hop, modelId: 'm1', resultPath: result, feature: 'cpm:cpm:d1' }),
    /Crossmatrix 0\.3\.0 or newer \(hop records 0\.2\.1\)/,
  );
});

// --- CLI --------------------------------------------------------------------

test('junior matrix codemap init prints the requestIds it sent', () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  const result = spawnSync(NODE, [JUNIOR, 'matrix', 'codemap', 'init', '--hop', hop, '--model', 'm1'], {
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(result.stdout).requestIds.length, 5);
});

test('junior matrix link prints the requestIds it sent', () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  const result = resultFile(dir, ['src/a.ts', 'src/b.ts']);
  const cli = spawnSync(
    NODE,
    [JUNIOR, 'matrix', 'link', '--hop', hop, '--model', 'm1', '--result', result, '--feature', 'cpm:cpm:d1'],
    { encoding: 'utf8' },
  );
  assert.equal(JSON.parse(cli.stdout).requestIds.length, 2);
});

test('codemap link sends evidence in the Crossmatrix sourceRef/locator/excerpt shape', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.jsonl');
  const hop = writeHop(dir, '0.3.0', log);
  const result = resultFile(dir, ['src/a.ts']);
  await codemapLink({ hopPath: hop, modelId: 'm1', resultPath: result, feature: 'cpm:cpm:d1' });
  const observe = operations(log).map((line) => line.request ?? line).find((r) => r.op.kind === 'observe');
  assert.deepEqual(Object.keys(observe.op.evidence[0]).sort(), ['excerpt', 'locator', 'sourceRef']);
});

test('codemapLink records the git commit and blob anchor as a third evidence item', async () => {
  const dir = committedRepo({ 'src/a.ts': 'hello' });
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  const result = resultFile(dir, ['src/a.ts']);
  await codemapLink({ hopPath: hop, modelId: 'm1', resultPath: result, feature: 'cpm:d1', dir });
  const anchor = observes(log)[0].op.evidence.find((item: any) => item.sourceRef.system === 'git');
  assert.deepEqual(anchor, {
    sourceRef: {
      system: 'git',
      sourceType: 'blob',
      sourceRef: 'src/a.ts',
      locator: gitOutput(dir, ['rev-parse', 'HEAD']),
    },
    locator: gitOutput(dir, ['rev-parse', 'HEAD:src/a.ts']),
    excerpt: 'git anchor',
  });
});

test('codemapLink keeps the request id stable when only the git anchor changes', async () => {
  const dir = committedRepo({ 'src/a.ts': 'hello' });
  const log = join(dir, 'writes.log');
  const hop = writeHop(dir, '0.3.0', log);
  const result = resultFile(dir, ['src/a.ts']);
  await codemapLink({ hopPath: hop, modelId: 'm1', resultPath: result, feature: 'cpm:d1', dir });
  const first = observes(log)[0].requestId;
  writeFileSync(join(dir, 'src/a.ts'), 'hello again');
  commitAll(dir, 'edit');
  await codemapLink({ hopPath: hop, modelId: 'm1', resultPath: result, feature: 'cpm:d1', dir });
  assert.equal(observes(log)[1].requestId, first);
});

test('codemap link adds the dimension prefix to a bare feature member id', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.jsonl');
  const hop = writeHop(dir, '0.3.0', log);
  const result = resultFile(dir, ['src/a.ts']);
  await codemapLink({ hopPath: hop, modelId: 'm1', resultPath: result, feature: 'cpm:d1' });
  const observe = operations(log).map((line) => line.request ?? line).find((r) => r.op.kind === 'observe');
  assert.equal(observe.op.from, 'cpm:d1');
});

// --- codemapFiles / codemapContext -----------------------------------------

test('codemapFiles lists implements observations before tests', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const responses = queryResponses(dir, {
    trace: {
      hops: [
        hop({ member: 'loc:src/z.ts', observations: ['implements'], relation: 'codemap-cpm' }),
        hop({ member: 'loc:src/a.test.ts', observations: ['tests'], relation: 'codemap-cpm' }),
      ],
      nextCursor: null,
    },
  });
  const hopPath = writeHop(dir, '0.3.0', log, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const files = await codemapFiles({ hopPath, modelId: 'm1', feature: 'cpm:d1' });
  assert.deepEqual(files.map((entry) => entry.observation), ['implements', 'tests']);
});

test('codemapFiles follows nextCursor across two pages', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const responses = queryResponses(dir, {
    trace: [
      { hops: [hop({ member: 'loc:src/b.ts' })], nextCursor: '1' },
      { hops: [hop({ member: 'loc:src/a.ts' })], nextCursor: null },
    ],
  });
  const hopPath = writeHop(dir, '0.3.0', log, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const files = await codemapFiles({ hopPath, modelId: 'm1', feature: 'cpm:d1' });
  assert.deepEqual(files.map((entry) => entry.path), ['src/a.ts', 'src/b.ts']);
});

test('a multi-page codemapFiles run spawns a single server process', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const pids = join(dir, 'pids.log');
  const responses = queryResponses(dir, {
    trace: [
      { hops: [hop({ member: 'loc:src/b.ts' })], nextCursor: '1' },
      { hops: [hop({ member: 'loc:src/a.ts' })], nextCursor: null },
    ],
  });
  const hopPath = writePidLoggingHop(dir, '0.3.0', log, pids, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const files = await codemapFiles({ hopPath, modelId: 'm1', feature: 'cpm:d1' });
  assert.equal(new Set(readPids(pids)).size, 1);
});

test('codemapFiles ignores non-codemap relations and non-location members', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const responses = queryResponses(dir, {
    trace: {
      hops: [
        hop({ relation: 'implements' }),
        hop({ member: 'job:d1' }),
        hop({ member: 'loc:src/a.ts' }),
      ],
      nextCursor: null,
    },
  });
  const hopPath = writeHop(dir, '0.3.0', log, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const files = await codemapFiles({ hopPath, modelId: 'm1', feature: 'cpm:d1' });
  assert.deepEqual(files.map((entry) => entry.path), ['src/a.ts']);
});

test('codemapContext caps entries at max', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const responses = queryResponses(dir, {
    trace: {
      hops: [
        hop({ member: 'loc:src/a.ts' }),
        hop({ member: 'loc:src/b.ts' }),
        hop({ member: 'loc:src/c.ts' }),
      ],
      nextCursor: null,
    },
  });
  const hopPath = writeHop(dir, '0.3.0', log, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const context = await codemapContext({ hopPath, modelId: 'm1', feature: 'cpm:d1', max: 2 });
  assert.equal(context.length, 2);
});

test('codemapContext has no duplicate paths', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const responses = queryResponses(dir, {
    trace: {
      hops: [
        hop({ member: 'loc:src/a.ts', observations: ['implements'] }),
        hop({ member: 'loc:src/a.ts', observations: ['tests'], relation: 'codemap-cpm' }),
      ],
      nextCursor: null,
    },
  });
  const hopPath = writeHop(dir, '0.3.0', log, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const context = await codemapContext({ hopPath, modelId: 'm1', feature: 'cpm:d1' });
  assert.deepEqual(context.map((entry) => entry.path), ['src/a.ts']);
});

// --- code roster filtering --------------------------------------------------

test('isCodeRosterPath rejects a .crossmatrix path even with no excludes', () => {
  assert.equal(isCodeRosterPath('.crossmatrix/audit/jevitate.jsonl', []), false);
});

test('isCodeRosterPath rejects a default-excluded changeset path', () => {
  assert.equal(isCodeRosterPath('.changeset/brave-owl.md', DEFAULT_CODE_EXCLUDES), false);
});

test('isCodeRosterPath accepts an ordinary source path under the default excludes', () => {
  assert.equal(isCodeRosterPath('src/app.ts', DEFAULT_CODE_EXCLUDES), true);
});

test('isCodeRosterPath rejects a path matched by project excludes replacing the defaults', () => {
  const excludes = loadCodeExcludes(gitRepoWithConfig({ 'delivery.config.json': JSON.stringify({ codemap: { exclude: ['docs/**'] } }) }));
  assert.equal(isCodeRosterPath('docs/a.md', excludes), false);
});

test('isCodeRosterPath accepts a default-excluded path when project excludes replace the defaults', () => {
  const excludes = loadCodeExcludes(gitRepoWithConfig({ 'delivery.config.json': JSON.stringify({ codemap: { exclude: ['docs/**'] } }) }));
  assert.equal(isCodeRosterPath('.changeset/x.md', excludes), true);
});

// --- codemapStale ----------------------------------------------------------

test('codemapStale classifies a link changed when its git blob differs from HEAD', async () => {
  const dir = committedRepo({ 'src/a.ts': 'hello' });
  const path = 'src/a.ts';
  const commit = gitOutput(dir, ['rev-parse', 'HEAD']);
  const blob = gitOutput(dir, ['rev-parse', `HEAD:${path}`]);
  writeFileSync(join(dir, path), 'hello again');
  commitAll(dir, 'edit');
  const log = join(dir, 'writes.log');
  const responses = gitLinkResponses(dir, path, commit, blob);
  const hopPath = writeHop(dir, '0.3.0', log, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const result = await codemapStale({ hopPath, modelId: 'm1', dir });
  assert.deepEqual(result.changed.map((entry) => entry.path), [path]);
});

test('codemapStale reports a stored link without git evidence as unanchored', async () => {
  const dir = committedRepo({ 'src/a.ts': 'hello' });
  const log = join(dir, 'writes.log');
  const responses = queryResponses(dir, {
    describe: { describe: { relations: [{ id: 'codemap-cpm' }] } },
    slice: {
      cells: [{ from: 'cpm:d1', to: 'loc:src/a.ts', observations: ['implements'] }],
      nextCursor: null,
    },
  });
  const hopPath = writeHop(dir, '0.3.0', log, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const result = await codemapStale({ hopPath, modelId: 'm1', dir });
  assert.deepEqual(result.unanchored.map((entry) => entry.path), ['src/a.ts']);
});

test('codemapFiles refuses a hop older than Crossmatrix 0.3.0', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hopPath = writeHop(dir, '0.2.1', log);
  await assert.rejects(
    codemapFiles({ hopPath, modelId: 'm1', feature: 'cpm:d1' }),
    /Crossmatrix 0\.3\.0 or newer \(hop records 0\.2\.1\)/,
  );
});

test('codemapFiles sends the trace query keyed by the feature member', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const hopPath = writeHop(dir, '0.3.0', log);
  const requests: any[] = [];
  const deps = {
    callHop: async (_hopPath: string, _tool: string, request: any) => {
      requests.push(request);
      return { ok: true, tool: 'crossmatrix', toolName: 'crossmatrix.query', revision: 1, kind: 'read', isError: false, unsupported: false, note: null, result: { hops: [], nextCursor: null } };
    },
  };
  await codemapFiles({ hopPath, modelId: 'm1', feature: 'cpm:d1', deps: deps as any });
  assert.deepEqual(requests[0].arguments.request.query, { kind: 'trace', member: 'cpm:d1' });
});

test('codemapContext skips directory paths', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const responses = queryResponses(dir, {
    trace: {
      hops: [hop({ member: 'loc:src/' }), hop({ member: 'loc:src/a.ts' })],
      nextCursor: null,
    },
  });
  const hopPath = writeHop(dir, '0.3.0', log, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const context = await codemapContext({ hopPath, modelId: 'm1', feature: 'cpm:d1' });
  assert.deepEqual(context.map((entry) => entry.path), ['src/a.ts']);
});

// --- CLI read routes --------------------------------------------------------

test('junior matrix files prints the feature code links', () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const responses = queryResponses(dir, {
    trace: { hops: [hop({ member: 'loc:src/a.ts' })], nextCursor: null },
  });
  const hopPath = writeHop(dir, '0.3.0', log, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const cli = spawnSync(NODE, [JUNIOR, 'matrix', 'files', '--hop', hopPath, '--model', 'm1', '--feature', 'cpm:d1'], {
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(cli.stdout).map((entry: any) => entry.path), ['src/a.ts']);
});

test('junior matrix context caps printed paths at max', () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const responses = queryResponses(dir, {
    trace: {
      hops: [hop({ member: 'loc:src/a.ts' }), hop({ member: 'loc:src/b.ts' })],
      nextCursor: null,
    },
  });
  const hopPath = writeHop(dir, '0.3.0', log, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const cli = spawnSync(
    NODE,
    [JUNIOR, 'matrix', 'context', '--hop', hopPath, '--model', 'm1', '--feature', 'cpm:d1', '--max', '1'],
    { encoding: 'utf8' },
  );
  assert.equal(JSON.parse(cli.stdout).length, 1);
});

test('junior matrix stale prints the changed links', () => {
  const dir = committedRepo({ 'src/a.ts': 'hello' });
  const commit = gitOutput(dir, ['rev-parse', 'HEAD']);
  const blob = gitOutput(dir, ['rev-parse', 'HEAD:src/a.ts']);
  writeFileSync(join(dir, 'src/a.ts'), 'hello again');
  commitAll(dir, 'edit');
  const log = join(dir, 'writes.log');
  const responses = gitLinkResponses(dir, 'src/a.ts', commit, blob);
  const hopPath = writeHop(dir, '0.3.0', log, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const cli = spawnSync(NODE, [JUNIOR, 'matrix', 'stale', '--hop', hopPath, '--model', 'm1', '--dir', dir], {
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(cli.stdout).changed.map((entry: any) => entry.path), ['src/a.ts']);
});

// --- codemapFeatures (reverse lookup) --------------------------------------

test('codemapFeatures lists the features linked to a file', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const responses = queryResponses(dir, {
    trace: {
      hops: [
        hop({ member: 'cpm:d1', direction: 'in', observations: ['implements'], relation: 'codemap-cpm' }),
        hop({ member: 'job:j1', direction: 'in', observations: ['tests'], relation: 'codemap-jevitate-jobs' }),
      ],
      nextCursor: null,
    },
  });
  const hopPath = writeHop(dir, '0.3.0', log, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const features = await codemapFeatures({ hopPath, modelId: 'm1', path: 'src/a.ts' });
  assert.deepEqual(features.map((entry) => entry.feature), ['cpm:d1', 'jevitate-jobs:j1']);
});

test('codemapFeatures keeps the strongest observation for a feature', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const responses = queryResponses(dir, {
    trace: {
      hops: [
        hop({ member: 'cpm:d1', direction: 'in', observations: ['touches'], relation: 'codemap-cpm' }),
        hop({ member: 'cpm:d1', direction: 'in', observations: ['implements'], relation: 'codemap-cpm' }),
      ],
      nextCursor: null,
    },
  });
  const hopPath = writeHop(dir, '0.3.0', log, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const features = await codemapFeatures({ hopPath, modelId: 'm1', path: 'src/a.ts' });
  assert.deepEqual(features, [{ feature: 'cpm:d1', observation: 'implements' }]);
});

test('codemapFeatures aggregates every linked file under a directory', async () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const responses = queryResponses(dir, {
    describe: { describe: { relations: [{ id: 'codemap-cpm' }] } },
    slice: {
      cells: [
        { from: 'cpm:d1', to: 'loc:src/a.ts', observations: ['implements'] },
        { from: 'cpm:d2', to: 'loc:src/nested/b.ts', observations: ['tests'] },
        { from: 'cpm:d3', to: 'loc:other/c.ts', observations: ['implements'] },
      ],
      nextCursor: null,
    },
  });
  const hopPath = writeHop(dir, '0.3.0', log, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const features = await codemapFeatures({ hopPath, modelId: 'm1', path: 'src' });
  assert.deepEqual(features.map((entry) => entry.feature), ['cpm:d1', 'cpm:d2']);
});

test('junior matrix features prints the reverse lookup for a path', () => {
  const dir = workdir();
  const log = join(dir, 'writes.log');
  const responses = queryResponses(dir, {
    trace: {
      hops: [hop({ member: 'cpm:d1', direction: 'in', observations: ['implements'], relation: 'codemap-cpm' })],
      nextCursor: null,
    },
  });
  const hopPath = writeHop(dir, '0.3.0', log, { FAKE_CROSSMATRIX_QUERY_RESPONSES: responses });
  const result = spawnSync(
    NODE,
    [JUNIOR, 'matrix', 'features', 'src/a.ts', '--dir', dir, '--hop', hopPath, '--model', 'm1'],
    { encoding: 'utf8' },
  );
  assert.deepEqual(JSON.parse(result.stdout), [{ feature: 'cpm:d1', observation: 'implements' }]);
});
