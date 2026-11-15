// Behavioral tests for Junior's worker-facing ADR gate (ADR 0018 R2-R5, R9).
//
// Every scenario is offline: temporary projects supply the ADR files and
// config, the classifier is a fake, and the worker test uses the existing
// helper seams (mock spawnPi and an injected classify). Each test drives one
// public outcome and makes exactly one behavioral assertion.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdrConfig } from './adr-config.ts';
import type { GateClassifier } from './worker.ts';
import type { Ticket, TicketAdapter } from './tickets.ts';
import {
  CHANGED_FILE_TEXT_LIMIT,
  boundedDiff,
  changedFileDiff,
  designGate,
  implementationGate,
  loadGateAdrs,
  resolveGateConfig,
  ticketGate,
} from './worker-adr-gate.ts';
import {
  JEVPASS,
  artifactFor,
  assistant,
  bool,
  COMMODITY_MODEL,
  commitFile,
  gitRepo,
  okTask,
  run,
  stream,
} from './worker-helpers.test.ts';

function project(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'junior-worker-adr-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function adrMarkdown(options: {
  id?: string;
  status?: string;
  appliesTo?: string;
  rule?: string;
} = {}): string {
  return [
    '---',
    `id: ${options.id ?? 'ADR-0001'}`,
    'title: Keep the source tree honest',
    `status: ${options.status ?? 'accepted'}`,
    'date: 2026-01-01',
    'supersedes: []',
    `applies_to: ${options.appliesTo ?? "['src/**']"}`,
    'rules:',
    '  - id: R1',
    `    text: ${options.rule ?? 'Keep the source tree honest.'}`,
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
  ].join('\n');
}

function adrProject(
  t: { after(fn: () => void): void },
  options: { gate?: AdrConfig['gate']; config?: boolean } = {},
): string {
  const root = project(t);
  const dir = join(root, 'docs', 'adr');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '0001-src.md'), adrMarkdown());
  if (options.config !== false) {
    writeFileSync(
      join(root, 'delivery.config.json'),
      JSON.stringify({ adr: { dir: 'docs/adr', format: 'junior', gate: options.gate ?? 'enforce' } }),
    );
  }
  return root;
}

function fakeGateClassifier(
  choice: 'contradicts' | 'conforms',
  confidence = 0.95,
): { classify: GateClassifier; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const classify: GateClassifier = async ({ state }) => {
    calls.push(state);
    const items = Array.isArray(state.items) ? (state.items as Array<{ id: string }>) : [];
    const criteria = Array.isArray(state.criteria) ? (state.criteria as Array<{ id: string }>) : [];
    const answers: Record<string, unknown> = {};
    for (const item of items) {
      for (const criterion of criteria) {
        answers[`cell:${item.id}:${criterion.id}`] = {
          type: 'choice',
          choice: criterion.id === 'relevant' ? 'yes' : choice,
          confidence,
        };
      }
    }
    return { answers };
  };
  return { classify, calls };
}

function briefFixture(): any {
  return {
    understanding: { scope: [], outOfScope: [], assumptions: [], acceptanceProof: [] },
    options: [
      {
        id: 'A',
        title: 'Option A',
        approach: 'Use two stores.',
        files: ['src/app.ts'],
        effort: { optimistic: 1, likely: 2, pessimistic: 3 },
        risks: [],
        tradeoffs: 'none',
      },
    ],
    recommendation: { option: 'A', why: 'smallest change' },
  };
}

const TICKET: Ticket = {
  id: '42',
  url: 'https://example.test/issues/42',
  title: 'Fix the widget',
  body: 'Make the widget safe.',
  labels: [],
  acceptance: ['widgets stay fixed'],
  updatedAt: '2026-11-14T12:00:00Z',
};

function fakeAdapter(ticket: Ticket = TICKET): TicketAdapter {
  return {
    async list() {
      return [ticket];
    },
    async get() {
      return ticket;
    },
  };
}

// --- resolveGateConfig -----------------------------------------------------

test('resolveGateConfig treats a recorded enforce gate as confirmed', (t) => {
  const root = adrProject(t, { gate: 'enforce' });
  assert.deepEqual(resolveGateConfig(root), {
    config: { dir: 'docs/adr', format: 'junior', gate: 'enforce' },
    confirmed: true,
  });
});

test('resolveGateConfig downgrades an unconfirmed proposed enforce gate to advisory', (t) => {
  const root = adrProject(t, { config: false });
  assert.deepEqual(resolveGateConfig(root), {
    config: { dir: 'docs/adr', format: 'junior', gate: 'advisory' },
    confirmed: false,
  });
});

test('resolveGateConfig returns null when no ADR directory exists', (t) => {
  const root = project(t);
  assert.equal(resolveGateConfig(root), null);
});

test('resolveGateConfig returns null for an off gate', (t) => {
  const root = adrProject(t, { gate: 'off' });
  assert.equal(resolveGateConfig(root), null);
});

// --- loadGateAdrs ----------------------------------------------------------

test('loadGateAdrs reads a MADR record from the configured directory', (t) => {
  const root = project(t);
  const dir = join(root, 'docs', 'adr');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '0001-madr.md'),
    [
      '# 1. Use one store',
      '',
      '## Status',
      '',
      'Accepted',
      '',
      '## Decision',
      '',
      'Use one store.',
      '',
    ].join('\n'),
  );
  const config: AdrConfig = { dir: 'docs/adr', format: 'madr', gate: 'enforce' };
  assert.deepEqual(loadGateAdrs(root, config).map((adr) => adr.id), ['ADR-0001']);
});

// --- implementationGate ----------------------------------------------------

function longSource(markerAtHead: string, markerAtLine292: string): string {
  return Array.from({length: 320}, (_, index) => {
    if (index === 0) return `export const head = '${markerAtHead}';`;
    if (index === 291) return `export const deep = '${markerAtLine292}';`;
    return `export const line${index + 1} = ${index + 1};`;
  }).join('\n') + '\n';
}

function adrGitProject(t: { after(fn: () => void): void }): {root: string; git: (args: string[]) => any} {
  const repo = gitRepo();
  t.after(() => rmSync(repo.dir, {recursive: true, force: true}));
  mkdirSync(join(repo.dir, 'docs', 'adr'), {recursive: true});
  mkdirSync(join(repo.dir, 'src'), {recursive: true});
  commitFile(repo, 'delivery.config.json', JSON.stringify({adr: {dir: 'docs/adr', format: 'junior', gate: 'enforce'}}));
  commitFile(repo, 'docs/adr/0001-src.md', adrMarkdown());
  return {root: repo.dir, git: repo.git};
}

test('implementationGate sends a change deep in a long file to the classifier', async (t) => {
  const {root, git} = adrGitProject(t);
  commitFile({dir: root, git}, 'src/long.ts', longSource('old-head', 'old-deep'));
  writeFileSync(join(root, 'src', 'long.ts'), longSource('old-head', 'deep-change-marker'));
  const {classify, calls} = fakeGateClassifier('conforms');
  await implementationGate({cwd: root, changedFiles: ['src/long.ts'], classify});
  assert.match(JSON.stringify(calls), /deep-change-marker/);
});

test('implementationGate leaves unchanged code beyond the diff context out of the subject', async (t) => {
  const {root, git} = adrGitProject(t);
  commitFile({dir: root, git}, 'src/long.ts', longSource('old-head-marker', 'old-deep'));
  writeFileSync(join(root, 'src', 'long.ts'), longSource('old-head-marker', 'deep-change-marker'));
  const {classify, calls} = fakeGateClassifier('conforms');
  await implementationGate({cwd: root, changedFiles: ['src/long.ts'], classify});
  assert.doesNotMatch(JSON.stringify(calls), /old-head-marker/);
});

test('changedFileDiff sends an untracked new file whole with a new file prefix', (t) => {
  const {root} = adrGitProject(t);
  writeFileSync(join(root, 'src', 'new.ts'), 'export const fresh = true;\n');
  assert.equal(changedFileDiff(root, 'src/new.ts', 'HEAD'), 'new file src/new.ts\nexport const fresh = true;\n');
});

test('an oversized diff is truncated at a hunk boundary with a marker', (t) => {
  const {root, git} = adrGitProject(t);
  const base = Array.from({length: 500}, (_, index) => `export const v${index} = ${index};`).join('\n') + '\n';
  commitFile({dir: root, git}, 'src/wide.ts', base);
  const changed = Array.from({length: 500}, (_, index) => index % 40 === 0 ? `export const v${index} = 'changed-${index}';` : `export const v${index} = ${index};`).join('\n') + '\n';
  writeFileSync(join(root, 'src', 'wide.ts'), changed);
  assert.match(boundedDiff(changedFileDiff(root, 'src/wide.ts', 'HEAD') ?? ''), /\[truncated: \d+ more hunks\]$/);
});

test('a bounded oversized diff stays within the subject limit', (t) => {
  const {root, git} = adrGitProject(t);
  const base = Array.from({length: 500}, (_, index) => `export const v${index} = ${index};`).join('\n') + '\n';
  commitFile({dir: root, git}, 'src/wide.ts', base);
  const changed = Array.from({length: 500}, (_, index) => index % 40 === 0 ? `export const v${index} = 'changed-${index}';` : `export const v${index} = ${index};`).join('\n') + '\n';
  writeFileSync(join(root, 'src', 'wide.ts'), changed);
  assert.ok(boundedDiff(changedFileDiff(root, 'src/wide.ts', 'HEAD') ?? '').length <= CHANGED_FILE_TEXT_LIMIT);
});

test('implementationGate falls back to the file head when git is unavailable', async (t) => {
  const root = adrProject(t);
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(join(root, 'src', 'app.ts'), 'export const fallbackHeadMarker = true;\n');
  const {classify, calls} = fakeGateClassifier('conforms');
  await implementationGate({cwd: root, changedFiles: ['src/app.ts'], classify});
  assert.match(JSON.stringify(calls), /fallbackHeadMarker/);
});

test('implementationGate returns an empty outcome when there are no changed files', async (t) => {
  const root = adrProject(t);
  const { classify } = fakeGateClassifier('contradicts');
  assert.deepEqual(await implementationGate({ cwd: root, changedFiles: [], classify }), {
    result: null,
    status: null,
    markdown: null,
  });
});

test('implementationGate makes no classifier call when there are no changed files', async (t) => {
  const root = adrProject(t);
  const { classify, calls } = fakeGateClassifier('contradicts');
  await implementationGate({ cwd: root, changedFiles: [], classify });
  assert.equal(calls.length, 0);
});

test('implementationGate leaves a conforming code handoff unblocked', async (t) => {
  const root = adrProject(t);
  const { classify } = fakeGateClassifier('conforms');
  const outcome = await implementationGate({ cwd: root, changedFiles: ['src/app.ts'], classify });
  assert.equal(outcome.status, null);
});

test('implementationGate requires a decision when a changed file contradicts an ADR rule', async (t) => {
  const root = adrProject(t);
  const { classify } = fakeGateClassifier('contradicts');
  const outcome = await implementationGate({ cwd: root, changedFiles: ['src/app.ts'], classify });
  assert.equal(outcome.status, 'needs_adr_decision');
});

test('implementationGate stops an unattended run with needs_operator', async (t) => {
  const root = adrProject(t);
  const { classify } = fakeGateClassifier('contradicts');
  const outcome = await implementationGate({
    cwd: root,
    changedFiles: ['src/app.ts'],
    classify,
    unattended: true,
  });
  assert.equal(outcome.status, 'needs_operator');
});

test('implementationGate never blocks under an advisory gate', async (t) => {
  const root = adrProject(t, { gate: 'advisory' });
  const { classify } = fakeGateClassifier('contradicts');
  const outcome = await implementationGate({ cwd: root, changedFiles: ['src/app.ts'], classify });
  assert.equal(outcome.status, null);
});

test('implementationGate renders a blocked markdown report', async (t) => {
  const root = adrProject(t);
  const { classify } = fakeGateClassifier('contradicts');
  const outcome = await implementationGate({ cwd: root, changedFiles: ['src/app.ts'], classify });
  assert.match(outcome.markdown ?? '', /BLOCKED/);
});

// --- designGate ------------------------------------------------------------

test('designGate returns the brief unchanged when no ADR gate is configured', async (t) => {
  const root = project(t);
  const brief = briefFixture();
  const { classify } = fakeGateClassifier('contradicts');
  assert.equal(await designGate({ cwd: root, brief, classify }), brief);
});

test('designGate records a finding for a brief option that contradicts an ADR rule', async (t) => {
  const root = adrProject(t);
  const { classify } = fakeGateClassifier('contradicts');
  const brief = await designGate({ cwd: root, brief: briefFixture(), classify });
  assert.deepEqual(brief.adrGate?.findings.map((finding) => finding.target), ['option:A']);
});

// --- ticketGate ------------------------------------------------------------

test('ticketGate requires a decision when a ticket contradicts an ADR rule', async (t) => {
  const root = adrProject(t);
  const { classify } = fakeGateClassifier('contradicts');
  const outcome = await ticketGate({
    cwd: root,
    ticketId: TICKET.id,
    adapter: fakeAdapter(),
    classify,
  });
  assert.equal(outcome.status, 'needs_adr_decision');
});

// --- worker integration ----------------------------------------------------

async function blockedCodeRun(t: { after(fn: () => void): void }): Promise<{
  result: any;
  artifact: string;
}> {
  const repo = gitRepo();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  mkdirSync(join(repo.dir, 'docs', 'adr'), { recursive: true });
  mkdirSync(join(repo.dir, 'src'), { recursive: true });
  commitFile(repo, 'delivery.config.json', JSON.stringify({
    adr: { dir: 'docs/adr', format: 'junior', gate: 'enforce' },
  }));
  commitFile(repo, 'docs/adr/0001-src.md', adrMarkdown());

  const classify: GateClassifier = async ({ state, questions }) => {
    if (Object.prototype.hasOwnProperty.call(questions, 'contract_clear')) {
      return { stopReason: 'stop', answers: JEVPASS };
    }
    if (Array.isArray(state.cells)) {
      const items = Array.isArray(state.items) ? (state.items as Array<{ id: string }>) : [];
      const criteria = Array.isArray(state.criteria) ? (state.criteria as Array<{ id: string }>) : [];
      const answers: Record<string, unknown> = {};
      for (const item of items) {
        for (const criterion of criteria) {
          answers[`cell:${item.id}:${criterion.id}`] = {
            type: 'choice',
            choice: 'contradicts',
            confidence: 0.95,
          };
        }
      }
      return { stopReason: 'stop', answers };
    }
    return { stopReason: 'stop', answers: { AC1: bool(0.95) } };
  };

  const spawnPi = () => {
    writeFileSync(join(repo.dir, 'src', 'app.ts'), 'export const value = 1;\n');
    return {
      status: 0,
      stdout: stream({ type: 'session', id: 'adr-session' }, assistant(), { type: 'agent_settled' }),
      stderr: '',
    };
  };

  const task = okTask(repo, {
    id: 'adr-run',
    provider: 'openrouter',
    model: COMMODITY_MODEL,
  });
  const result = await run(task, false, { spawnPi, classify });
  return { result, artifact: artifactFor(repo, 'adr-run') };
}

test('a code run with a contradicting ADR finding ends needs_adr_decision', async (t) => {
  const { result } = await blockedCodeRun(t);
  assert.equal(result.status, 'needs_adr_decision');
});

test('a blocked code run writes the ADR findings to adr-gate.md', async (t) => {
  const { artifact } = await blockedCodeRun(t);
  assert.ok(existsSync(join(artifact, 'adr-gate.md')));
});

test('a code run with an ADR config records an unavailable classifier instead of a silent pass', async (t) => {
  const repo = gitRepo();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  mkdirSync(join(repo.dir, 'docs', 'adr'), { recursive: true });
  mkdirSync(join(repo.dir, 'src'), { recursive: true });
  commitFile(repo, 'delivery.config.json', JSON.stringify({
    adr: { dir: 'docs/adr', format: 'junior', gate: 'enforce' },
  }));
  commitFile(repo, 'docs/adr/0001-src.md', adrMarkdown());

  const spawnPi = () => {
    writeFileSync(join(repo.dir, 'src', 'app.ts'), 'export const value = 1;\n');
    return {
      status: 0,
      stdout: stream({ type: 'session', id: 'adr-session' }, assistant(), { type: 'agent_settled' }),
      stderr: '',
    };
  };
  const jevPi = (async () => {
    throw new Error('offline classifier');
  }) as any;
  const result = await run(
    okTask(repo, { id: 'adr-no-classifier', provider: 'openrouter', model: COMMODITY_MODEL }),
    false,
    { spawnPi, jevPi },
  );
  assert.ok(result.unresolved.includes('ADR gate skipped: classifier unavailable'));
});

// --- inconclusive implementation gate (ADR 0018 R9) ------------------------

function foreignAdrProject(t: { after(fn: () => void): void }): string {
  const root = project(t);
  const dir = join(root, 'docs', 'adr');
  mkdirSync(dir, {recursive: true });
  writeFileSync(
    join(dir, '0002-queue.md'),
    ['# 2. Use a queue', '', 'Status: Accepted', '', '## Decision', '', 'Use one durable queue.', ''].join('\n'),
  );
  writeFileSync(
    join(root, 'delivery.config.json'),
    JSON.stringify({ adr: { dir: 'docs/adr', format: 'nygard', gate: 'enforce' } }),
  );
  return root;
}

test('implementationGate carries inconclusive when every accepted ADR was skipped', async (t) => {
  const root = foreignAdrProject(t);
  const { classify } = fakeGateClassifier('conforms');
  const outcome = await implementationGate({ cwd: root, changedFiles: ['src/app.ts'], classify });
  assert.equal(outcome.result?.inconclusive, true);
});

test('implementationGate does not render an inconclusive check as PASS', async (t) => {
  const root = foreignAdrProject(t);
  const { classify } = fakeGateClassifier('conforms');
  const outcome = await implementationGate({ cwd: root, changedFiles: ['src/app.ts'], classify });
  assert.match(outcome.markdown ?? '', /INCONCLUSIVE/);
});

test('implementationGate does not stop an unattended inconclusive run', async (t) => {
  const root = foreignAdrProject(t);
  const { classify } = fakeGateClassifier('conforms');
  const outcome = await implementationGate({ cwd: root, changedFiles: ['src/app.ts'], classify, unattended: true });
  assert.equal(outcome.status, null);
});
