// Behavioral tests for the strict crossmatrix mode of the fake MCP server.
//
// Each scenario drives the fixture through the real hop exactly as an
// integration test does. A separate server process runs per call, so a passing
// sequence also proves that strict model state survives between calls.
// Each test asserts exactly one observable outcome.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callHop, initHop } from './tools/tools.ts';

const NODE = process.execPath;
const FAKE = join(import.meta.dirname, 'tools', 'test-fixtures', 'fake-mcp.mjs');

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-fake-crossmatrix-'));
}

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

function stateFile(dir: string): string {
  return join(dir, 'crossmatrix-state.json');
}

function request(modelId: string, op: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: '0.3.0',
    requestId: `test-${String(op.kind)}`,
    modelId,
    actor: { actorType: 'system', persona: 'model_admin' },
    op,
  };
}

async function command(hop: string, modelId: string, op: Record<string, unknown>): Promise<any> {
  return callHop(hop, 'crossmatrix', {
    tool: 'crossmatrix.command',
    arguments: { request: request(modelId, op) },
  });
}

async function registerDimension(
  hop: string,
  modelId: string,
  dimensionId: string,
  members: string[] = [],
): Promise<any> {
  await command(hop, modelId, { kind: 'dimension.register', dimensionId });
  return command(hop, modelId, {
    kind: 'members.sync',
    dimensionId,
    members: members.map((id) => ({ id })),
  });
}

test('relation.declare into an unregistered dimension is rejected as unknown_dimension', async () => {
  const dir = workdir();
  const hop = writeHop(dir, { FAKE_CROSSMATRIX_STATE: stateFile(dir) });
  const modelId = 'strict-model';

  await registerDimension(hop, modelId, 'cpm', ['cpm:c1']);
  const outcome = await command(hop, modelId, {
    kind: 'relation.declare',
    relationId: 'cpm-code',
    relationType: 'implements',
    from: 'cpm',
    to: 'missing-code',
    scale: 'junior-reference',
  });

  assert.equal(outcome.result.error.code, 'unknown_dimension');
});

test('observe with a member absent from the from dimension is rejected as unknown_member', async () => {
  const dir = workdir();
  const hop = writeHop(dir, { FAKE_CROSSMATRIX_STATE: stateFile(dir) });
  const modelId = 'strict-model';

  await registerDimension(hop, modelId, 'cpm', ['cpm:c1']);
  await registerDimension(hop, modelId, 'code', ['loc:src/a.ts']);
  await command(hop, modelId, {
    kind: 'scale.declare',
    scale: { id: 'junior-reference' },
  });
  await command(hop, modelId, {
    kind: 'relation.declare',
    relationId: 'cpm-code',
    relationType: 'implements',
    from: 'cpm',
    to: 'code',
    scale: 'junior-reference',
  });
  const outcome = await command(hop, modelId, {
    kind: 'observe',
    relationId: 'cpm-code',
    from: 'cpm:absent',
    to: 'loc:src/a.ts',
  });

  assert.equal(
    outcome.result.error.message,
    "unknown member 'cpm:absent' in dimension 'cpm'",
  );
});

test('a complete model sequence succeeds across separate server processes', async () => {
  const dir = workdir();
  const hop = writeHop(dir, { FAKE_CROSSMATRIX_STATE: stateFile(dir) });
  const modelId = 'strict-model';

  await command(hop, modelId, { kind: 'model.open' });
  await registerDimension(hop, modelId, 'cpm', ['cpm:c1']);
  await registerDimension(hop, modelId, 'code', ['loc:src/a.ts']);
  await command(hop, modelId, {
    kind: 'scale.declare',
    scale: { id: 'junior-reference' },
  });
  await command(hop, modelId, {
    kind: 'relation.declare',
    relationId: 'cpm-code',
    relationType: 'implements',
    from: 'cpm',
    to: 'code',
    scale: 'junior-reference',
  });
  const outcome = await command(hop, modelId, {
    kind: 'observe',
    relationId: 'cpm-code',
    from: 'cpm:c1',
    to: 'loc:src/a.ts',
  });

  assert.equal(outcome.result.ok, true);
});

test('relation.declare with an undeclared scale is rejected as unknown_scale', async () => {
  const dir = workdir();
  const hop = writeHop(dir, { FAKE_CROSSMATRIX_STATE: stateFile(dir) });
  const modelId = 'strict-model';

  await registerDimension(hop, modelId, 'cpm', ['cpm:c1']);
  await registerDimension(hop, modelId, 'code', ['loc:src/a.ts']);
  const outcome = await command(hop, modelId, {
    kind: 'relation.declare',
    relationId: 'cpm-code',
    relationType: 'implements',
    from: 'cpm',
    to: 'code',
    scale: 'undeclared-scale',
  });

  assert.equal(outcome.result.error.code, 'unknown_scale');
});

test('without strict state any crossmatrix command still succeeds in write-log mode', async () => {
  const dir = workdir();
  const hop = writeHop(dir, { FAKE_CROSSMATRIX_WRITES: join(dir, 'writes.jsonl') });
  writeFileSync(join(dir, 'writes.jsonl'), '');
  const outcome = await command(hop, 'legacy-model', {
    kind: 'relation.declare',
    relationId: 'cpm-code',
    from: 'unregistered-cpm',
    to: 'unregistered-code',
    scale: 'undeclared-scale',
  });

  assert.equal(outcome.ok, true);
});

test('relation.declare with a relation type crossmatrix does not know is rejected as unknown_relation_type', async () => {
  const dir = workdir();
  const hop = writeHop(dir, { FAKE_CROSSMATRIX_STATE: stateFile(dir) });
  const modelId = 'strict-model';

  await registerDimension(hop, modelId, 'cpm', ['cpm:c1']);
  await registerDimension(hop, modelId, 'code', ['loc:src/a.ts']);
  await command(hop, modelId, { kind: 'scale.declare', scale: { id: 'junior-reference', mode: 'categorical', levels: [] } });
  const outcome = await command(hop, modelId, {
    kind: 'relation.declare',
    relationId: 'cpm-code',
    relationType: 'concerns',
    from: 'cpm',
    to: 'code',
    scale: 'junior-reference',
  });

  assert.equal(outcome.result.error.code, 'unknown_relation_type');
});
