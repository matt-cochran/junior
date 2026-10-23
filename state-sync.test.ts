// Behavioral tests for the companion-tool state mirror (`state-sync.ts`).
//
// Every scenario drives the real `syncState` code through a real hop whose
// crossmatrix command is the strict fake server. Companion reads (cpm, fmeca)
// are injected by wrapping `callHop`; crossmatrix writes always use the real
// hop so the strict model validation is part of the behaviour under test.
// Each test asserts exactly one observable outcome through a public interface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callHop, initHop, loadHop } from './tools/tools.ts';
import { syncState } from './state-sync.ts';

const NODE = process.execPath;
const FAKE = join(import.meta.dirname, 'tools', 'test-fixtures', 'fake-mcp.mjs');

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-state-sync-'));
}

function writeHop(dir: string): string {
  const hop = join(dir, 'hop.json');
  initHop(hop, {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: {
      crossmatrix: {
        command: NODE,
        args: [FAKE],
        env: {
          FAKE_MCP_MODE: 'crossmatrix',
          FAKE_CROSSMATRIX_STATE: join(dir, 'crossmatrix-state.json'),
        },
        sourceVersion: '0.4.0',
        sourceSha: '0'.repeat(64),
      },
    },
  });
  return hop;
}

function request(modelId: string, op: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: '0.3.0',
    requestId: `seed-${String(op.kind)}-${String(op.dimensionId ?? '')}`,
    modelId,
    actor: { actorType: 'system', persona: 'model_admin' },
    op,
  };
}

async function seedModel(hop: string, modelId: string, dimensions: Record<string, string[]>): Promise<void> {
  for (const [dimensionId, members] of Object.entries(dimensions)) {
    await callHop(hop, 'crossmatrix', {
      tool: 'crossmatrix.command',
      arguments: { request: request(modelId, { kind: 'dimension.register', dimensionId }) },
    });
    await callHop(hop, 'crossmatrix', {
      tool: 'crossmatrix.command',
      arguments: {
        request: request(modelId, {
          kind: 'members.sync',
          dimensionId,
          members: members.map((id) => ({ id })),
        }),
      },
    });
  }
}

/** Injected companion reads; crossmatrix writes go through the real hop. */
function deps(reads: Record<string, unknown>) {
  const injected = async (hop: string, tool: string, call: any) => {
    if (tool === 'crossmatrix') return callHop(hop, tool, call);
    if (tool in reads) return { ok: true, result: reads[tool] };
    return {
      ok: false,
      isError: true,
      note: null,
      error: { code: 'missing', message: `${tool} missing` },
    };
  };
  return { callHop: injected as typeof callHop, loadHop };
}

function planGet(deliverables: any[]): unknown {
  return { plan_id: 'P', graph: { deliverables } };
}

function acceptance(entries: unknown[]): any[] {
  return [{ id: 'd1', metadata: { junior: { acceptance: entries } } }];
}

test('a cpm ref to the synced plan becomes a junior-fmeca-cpm reference observation', async () => {
  const hop = writeHop(workdir());
  await seedModel(hop, 'm1', { cpm: ['cpm:d1'], code: ['loc:src/a.ts'], fmeca: ['fm:f1'] });
  const result = await syncState({
    hopPath: hop,
    modelId: 'm1',
    planId: 'P',
    fmecaSession: 'S',
    deps: deps({
      cpm: planGet([{ id: 'd1' }]),
      fmeca: { failure_modes: [{ id: 'f1', refs: ['cpm:P/d1'] }] },
    }),
  });

  assert.deepEqual(
    result.observations
      .filter((o) => o.relationId === 'junior-fmeca-cpm')
      .map((o) => [o.from, o.to, o.observation]),
    [['fm:f1', 'cpm:d1', 'references']],
  );
});

test('a verified mitigation referenced by a plan criterion becomes a junior-cpm-fmeca observation', async () => {
  const hop = writeHop(workdir());
  await seedModel(hop, 'm1', { cpm: ['cpm:d1'], code: ['loc:src/a.ts'], fmeca: ['fm:f1'] });
  const result = await syncState({
    hopPath: hop,
    modelId: 'm1',
    planId: 'P',
    fmecaSession: 'S',
    deps: deps({
      cpm: planGet(acceptance([{ id: 'req:c1/ac1', text: 't', mitigates: ['S/m1'] }])),
      fmeca: { failure_modes: [{ id: 'f1', mitigations: [{ id: 'm1', status: 'verified' }] }] },
    }),
  });

  assert.deepEqual(
    result.observations
      .filter((o) => o.relationId === 'junior-cpm-fmeca')
      .map((o) => [o.from, o.to, o.observation]),
    [['cpm:d1', 'fm:f1', 'verified']],
  );
});

test('a repo-relative file named by a failure mode becomes a junior-fmeca-code observation', async () => {
  const hop = writeHop(workdir());
  await seedModel(hop, 'm1', { cpm: ['cpm:d1'], code: ['loc:src/a.ts'], fmeca: ['fm:f1'] });
  const result = await syncState({
    hopPath: hop,
    modelId: 'm1',
    planId: 'P',
    fmecaSession: 'S',
    deps: deps({
      cpm: planGet([{ id: 'd1' }]),
      fmeca: { failure_modes: [{ id: 'f1', files: ['src/a.ts'] }] },
    }),
  });

  assert.deepEqual(
    result.observations
      .filter((o) => o.relationId === 'junior-fmeca-code')
      .map((o) => [o.from, o.to]),
    [['fm:f1', 'loc:src/a.ts']],
  );
});

test('syncState never emits an observation whose from equals its to', async () => {
  const hop = writeHop(workdir());
  await seedModel(hop, 'm1', { cpm: ['cpm:d1'], code: ['loc:src/a.ts'], fmeca: ['fm:f1'] });
  const result = await syncState({
    hopPath: hop,
    modelId: 'm1',
    planId: 'P',
    fmecaSession: 'S',
    deps: deps({
      cpm: planGet([{ id: 'd1' }]),
      fmeca: {
        failure_modes: [
          {
            id: 'f1',
            refs: ['cpm:P/d1', 'loc:src/a.ts'],
            files: ['src/a.ts'],
            feature: 'cpm:d1',
          },
        ],
      },
    }),
  });

  assert.equal(result.observations.some((o) => o.from === o.to), false);
});

test('a missing fmeca dimension is noted with the relation and dimension it needs', async () => {
  const hop = writeHop(workdir());
  await seedModel(hop, 'm1', { cpm: ['cpm:d1'], code: ['loc:src/a.ts'] });
  const result = await syncState({
    hopPath: hop,
    modelId: 'm1',
    planId: 'P',
    fmecaSession: 'S',
    deps: deps({
      cpm: planGet([{ id: 'd1' }]),
      fmeca: { failure_modes: [{ id: 'f1', refs: ['cpm:P/d1'] }] },
    }),
  });

  assert.ok(result.notes.some((note) => note.includes('junior-fmeca-cpm') && note.includes('fmeca')));
});

test('a missing fmeca dimension is not recorded as a write failure', async () => {
  const hop = writeHop(workdir());
  await seedModel(hop, 'm1', { cpm: ['cpm:d1'], code: ['loc:src/a.ts'] });
  const result = await syncState({
    hopPath: hop,
    modelId: 'm1',
    planId: 'P',
    fmecaSession: 'S',
    deps: deps({
      cpm: planGet([{ id: 'd1' }]),
      fmeca: { failure_modes: [{ id: 'f1', refs: ['cpm:P/d1'] }] },
    }),
  });

  assert.deepEqual(result.failures, []);
});

test('an elicitation session produces exactly one not-mirrored note', async () => {
  const hop = writeHop(workdir());
  await seedModel(hop, 'm1', { cpm: ['cpm:d1'] });
  const result = await syncState({
    hopPath: hop,
    modelId: 'm1',
    elicitationSession: 'job:j1',
    deps: deps({}),
  });

  assert.equal(result.notes.filter((note) => note.includes('not mirrored')).length, 1);
});

test('an elicitation session writes nothing to crossmatrix', async () => {
  const hop = writeHop(workdir());
  await seedModel(hop, 'm1', { cpm: ['cpm:d1'] });
  const result = await syncState({
    hopPath: hop,
    modelId: 'm1',
    elicitationSession: 'job:j1',
    deps: deps({}),
  });

  assert.equal(result.sent.length, 0);
});

/** d2 (absent from the cpm roster) then d1, each with a criterion mitigating S/m1. */
function twoMitigatingDeliverables(): any[] {
  const criterion = { text: 't', mitigates: ['S/m1'] };
  return [
    { id: 'd2', metadata: { junior: { acceptance: [{ id: 'a2', ...criterion }] } } },
    { id: 'd1', metadata: { junior: { acceptance: [{ id: 'a1', ...criterion }] } } },
  ];
}

test('a rejected observe is recorded as a failure', async () => {
  const hop = writeHop(workdir());
  await seedModel(hop, 'm1', { cpm: ['cpm:d1'], code: ['loc:src/a.ts'], fmeca: ['fm:f1'] });
  const result = await syncState({
    hopPath: hop,
    modelId: 'm1',
    planId: 'P',
    fmecaSession: 'S',
    deps: deps({
      cpm: planGet(twoMitigatingDeliverables()),
      fmeca: { failure_modes: [{ id: 'f1', mitigations: [{ id: 'm1', status: 'verified' }] }] },
    }),
  });

  assert.equal(result.failures.length, 1);
});

test('syncState keeps sending the remaining observations after a rejected observe', async () => {
  const hop = writeHop(workdir());
  await seedModel(hop, 'm1', { cpm: ['cpm:d1'], code: ['loc:src/a.ts'], fmeca: ['fm:f1'] });
  const result = await syncState({
    hopPath: hop,
    modelId: 'm1',
    planId: 'P',
    fmecaSession: 'S',
    deps: deps({
      cpm: planGet(twoMitigatingDeliverables()),
      fmeca: { failure_modes: [{ id: 'f1', mitigations: [{ id: 'm1', status: 'verified' }] }] },
    }),
  });

  assert.equal(result.sent.filter((entry) => entry.kind === 'observe').length, 1);
});

test('a cpm token in failure-mode text that names another plan is noted, not observed', async () => {
  const hop = writeHop(workdir());
  await seedModel(hop, 'm1', { cpm: ['cpm:d1'], code: ['loc:src/a.ts'], fmeca: ['fm:f1'] });
  const result = await syncState({
    hopPath: hop,
    modelId: 'm1',
    planId: 'P',
    fmecaSession: 'S',
    deps: deps({
      cpm: planGet([{ id: 'd1' }]),
      fmeca: { failure_modes: [{ id: 'f1', description: 'slips cpm:OTHER/d9 in delivery' }] },
    }),
  });

  assert.deepEqual(result.observations.filter((o) => o.relationId === 'junior-fmeca-cpm'), []);
});

test('a ref to a deliverable missing from the cpm roster is a note, not a failure', async () => {
  const hop = writeHop(workdir());
  await seedModel(hop, 'm1', { cpm: ['cpm:d1'], code: ['loc:src/a.ts'], fmeca: ['fm:f1'] });
  const result = await syncState({
    hopPath: hop,
    modelId: 'm1',
    planId: 'P',
    fmecaSession: 'S',
    deps: deps({
      cpm: planGet([{ id: 'd1' }]),
      fmeca: { failure_modes: [{ id: 'f1', refs: ['cpm:P/gone'] }] },
    }),
  });

  assert.deepEqual(result.failures, []);
});

test('syncState sends identical request ids when state is unchanged', async () => {
  const hop = writeHop(workdir());
  await seedModel(hop, 'm1', { cpm: ['cpm:d1'], code: ['loc:src/a.ts'], fmeca: ['fm:f1'] });
  const options = {
    hopPath: hop,
    modelId: 'm1',
    planId: 'P',
    fmecaSession: 'S',
    deps: deps({
      cpm: planGet([{ id: 'd1' }]),
      fmeca: { failure_modes: [{ id: 'f1', refs: ['cpm:P/d1'] }] },
    }),
  };
  const first = await syncState(options);
  const second = await syncState(options);

  assert.deepEqual(second.requestIds, first.requestIds);
});

test('syncState notes a companion read that throws instead of failing', async () => {
  const hop = writeHop(workdir());
  await seedModel(hop, 'm1', { cpm: ['cpm:d1'], fmeca: ['fm:f1'] });
  const throwing = async (h: string, tool: string, call: any) => {
    if (tool === 'crossmatrix') return callHop(h, tool, call);
    throw new Error(`${tool} exploded`);
  };
  const result = await syncState({
    hopPath: hop,
    modelId: 'm1',
    planId: 'P',
    fmecaSession: 'S',
    deps: { callHop: throwing as typeof callHop, loadHop },
  });

  assert.ok(result.notes.some((note) => note.includes('fmeca state.get skipped: fmeca exploded')));
});

test('syncState never copies an environment value into what it sends', async () => {
  const hop = writeHop(workdir());
  await seedModel(hop, 'm1', { cpm: ['cpm:d1'], code: ['loc:src/a.ts'], fmeca: ['fm:f1'] });
  process.env.JUNIOR_STATE_SYNC_SECRET = 'sk-state-sync-secret-value';
  const result = await syncState({
    hopPath: hop,
    modelId: 'm1',
    planId: 'P',
    fmecaSession: 'S',
    deps: deps({
      cpm: planGet(acceptance([{ id: 'a1', text: 't', mitigates: ['S/m1'] }])),
      fmeca: { failure_modes: [{ id: 'f1', refs: ['cpm:P/d1', 'src/a.ts'], mitigations: [{ id: 'm1', status: 'verified' }] }] },
    }),
  });
  delete process.env.JUNIOR_STATE_SYNC_SECRET;

  assert.equal(JSON.stringify(result).includes('sk-state-sync-secret-value'), false);
});
