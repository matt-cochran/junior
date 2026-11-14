// Behavioral tests for the ticket-stage ADR gate in worker preflight
// (ADR 0018 R3, R5, R8). Every scenario is offline: a temporary project supplies
// the ADR, the classifier is a fake, and the ticket adapter is injected through
// deps.ticketAdapter. Each test drives one public outcome.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GateClassifier } from './worker.ts';
import type { Ticket, TicketAdapter } from './tickets.ts';
import {
  COMMODITY_MODEL,
  JEVPASS,
  bool,
  okSpawn,
  okTask,
  run,
} from './worker-helpers.test.ts';

const TICKET: Ticket = {
  id: '42',
  url: 'https://example.test/issues/42',
  title: 'Fix the widget',
  body: 'Make the widget safe.',
  labels: [],
  acceptance: ['widgets stay fixed'],
  updatedAt: '2026-11-14T12:00:00Z',
};

function project(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'junior-worker-ticket-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
  writeFileSync(join(root, 'delivery.config.json'), JSON.stringify({
    adr: { dir: 'docs/adr', format: 'junior', gate: 'enforce' },
  }));
  writeFileSync(join(root, 'docs', 'adr', '0001-src.md'), [
    '---',
    'id: ADR-0001',
    'title: Keep the source tree honest',
    'status: accepted',
    'date: 2026-01-01',
    'supersedes: []',
    "applies_to: ['src/**']",
    'rules:',
    '  - id: R1',
    '    text: Keep the source tree honest.',
    '---',
    '',
    '## Context',
    '',
    'Context.',
    '',
    '## Decision',
    '',
    'Decision.',
    '',
    '## Consequences',
    '',
    'Consequences.',
    '',
  ].join('\n'));
  return root;
}

function fakeAdapter(ticket: Ticket = TICKET): { adapter: TicketAdapter; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    adapter: {
      async list() {
        return [ticket];
      },
      async get() {
        calls += 1;
        return ticket;
      },
    },
  };
}

function classifier(verdict: 'contradicts' | 'conforms'): GateClassifier {
  return async ({ state, questions }: any) => {
    if (Object.prototype.hasOwnProperty.call(questions, 'contract_clear')) {
      return { stopReason: 'stop', answers: JEVPASS };
    }
    if (Array.isArray(state.items)) {
      const items = state.items as Array<{ id: string }>;
      const criteria = state.criteria as Array<{ id: string }>;
      const answers: Record<string, unknown> = {};
      for (const item of items) {
        for (const criterion of criteria) {
          answers[`cell:${item.id}:${criterion.id}`] = {
            type: 'choice',
            choice: criterion.id === 'relevant' ? 'yes' : verdict,
            confidence: 0.95,
          };
        }
      }
      return { stopReason: 'stop', answers };
    }
    return { stopReason: 'stop', answers: { AC1: bool(0.95) } };
  };
}

function ticketTask(root: string, extra: any = {}): any {
  return okTask({ dir: root }, {
    id: 'ticket-run',
    provider: 'openrouter',
    model: COMMODITY_MODEL,
    ticket: TICKET.id,
    ...extra,
  });
}

test('a contradicting ticket stops the run with needs_adr_decision', async (t) => {
  const root = project(t);
  const result = await run(ticketTask(root), false, {
    classify: classifier('contradicts'),
    ticketAdapter: fakeAdapter().adapter,
  });
  assert.equal(result.status, 'needs_adr_decision');
});

test('a contradicting ticket stops before Pi is spawned', async (t) => {
  const root = project(t);
  let spawns = 0;
  const spawnPi = (...args: any[]) => {
    spawns += 1;
    return okSpawn()(...args);
  };
  await run(ticketTask(root), false, {
    classify: classifier('contradicts'),
    ticketAdapter: fakeAdapter().adapter,
    spawnPi,
  });
  assert.equal(spawns, 0);
});

test('a contradicting ticket writes the ticket gate report', async (t) => {
  const root = project(t);
  const result = await run(ticketTask(root), false, {
    classify: classifier('contradicts'),
    ticketAdapter: fakeAdapter().adapter,
  });
  assert.equal(existsSync(join(result.artifactDir, 'ticket-adr-gate.md')), true);
});

test('a conforming ticket lets the run spawn Pi', async (t) => {
  const root = project(t);
  let spawns = 0;
  const spawnPi = (...args: any[]) => {
    spawns += 1;
    return okSpawn()(...args);
  };
  await run(ticketTask(root), false, {
    classify: classifier('conforms'),
    ticketAdapter: fakeAdapter().adapter,
    spawnPi,
  });
  assert.equal(spawns, 1);
});

test('a mock run does not ask the ticket adapter', async (t) => {
  const root = project(t);
  const fake = fakeAdapter();
  await run(ticketTask(root), true, { ticketAdapter: fake.adapter });
  assert.equal(fake.calls(), 0);
});

test('a non-string ticket is rejected naming the ticket field', async (t) => {
  const root = project(t);
  const fake = fakeAdapter();
  const result = await run(ticketTask(root, { ticket: 42 }), false, {
    classify: classifier('conforms'),
    ticketAdapter: fake.adapter,
  });
  assert.match(result.workerError, /ticket/);
});
