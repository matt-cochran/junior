// Behavioral tests for the Code-map write side: declaring the feature-to-code
// configuration and recording a handoff's changed files as `implements` links.
//
// Every scenario is offline: it uses its own temp hop + fake MCP write log (or
// a temp result.json). Each test asserts exactly one observable outcome through
// a public module/CLI interface and never inspects source text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHop } from './tools/tools.ts';
import { codemapInit, codemapLink } from './codemap.ts';

const NODE = process.execPath;
const JUNIOR = join(import.meta.dirname, 'junior.ts');
const FAKE = join(import.meta.dirname, 'tools', 'test-fixtures', 'fake-mcp.mjs');

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-codemap-'));
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
  assert.equal(operations(log)[0].op.kind, 'scale.declare');
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
      evidence: [{ kind: 'junior-handoff', id: 'J-test', status: 'ready_for_review', artifactDir: join(dir, '.delivery', 'J-test', '1') }],
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
