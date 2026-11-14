// Behavioral tests for the append-only ADR decision ledger (ADR 0018 R6, R7,
// R8). Every scenario uses a fresh temporary root; no network or real project
// state is touched. Each test makes one behavioral assertion through the public
// exports of `adr-ledger.ts`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEDGER_PATH,
  activeDecision,
  adrContentHash,
  appendDecision,
  carriedForward,
  lapsedStanding,
  readLedger,
  toObservation,
  type AdrDecisionInput,
} from './adr-ledger.ts';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function rootDir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-adr-ledger-'));
}

function decision(overrides: Partial<AdrDecisionInput> = {}): AdrDecisionInput {
  return {
    by: 'reviewer',
    stage: 'design',
    adrId: 'ADR-0001',
    ruleId: 'R1',
    target: 'src/store.ts',
    verdict: 'contradicts',
    probability: 0.9,
    confidence: 'high',
    decision: 'override',
    rationale: 'the migration has to land first',
    deliverable: 'D1',
    standing: false,
    ...overrides,
  };
}

function key(overrides: Record<string, unknown> = {}) {
  return {
    adrId: 'ADR-0001',
    ruleId: 'R1',
    target: 'src/store.ts',
    deliverable: 'D1',
    ...overrides,
  } as {
    adrId: string;
    ruleId: string;
    target: string;
    deliverable?: string;
    stage?: 'design' | 'implementation' | 'ticket';
  };
}

const ctx = (adrHash = 'hash-a') => ({now: NOW, adrHash});

test('LEDGER_PATH is the committed ledger location', () => {
  assert.equal(LEDGER_PATH, '.delivery/adr-overrides.jsonl');
});

test('appendDecision stores schemaVersion 1', () => {
  const stored = appendDecision(rootDir(), decision(), {clock: () => NOW});
  assert.equal(stored.schemaVersion, 1);
});

test('appendDecision generates an adrd- id with twelve hexadecimal characters', () => {
  const stored = appendDecision(rootDir(), decision(), {clock: () => NOW});
  assert.match(stored.id, /^adrd-[0-9a-f]{12}$/);
});

test('appendDecision records the injected clock time as an RFC 3339 timestamp', () => {
  const stored = appendDecision(rootDir(), decision(), {clock: () => NOW});
  assert.equal(stored.at, '2026-06-01T12:00:00.000Z');
});

test('appendDecision rejects an override with an empty rationale', () => {
  assert.throws(
    () => appendDecision(rootDir(), decision({rationale: '   '}), {clock: () => NOW}),
    /rationale/,
  );
});

test('appendDecision rejects a standing decision without expires', () => {
  assert.throws(
    () => appendDecision(rootDir(), decision({standing: true}), {clock: () => NOW}),
    /expires/,
  );
});

test('appendDecision rejects a standing decision with a non-RFC-3339 expires', () => {
  assert.throws(
    () =>
      appendDecision(rootDir(), decision({standing: true, expires: 'next quarter'}), {
        clock: () => NOW,
      }),
    /expires/,
  );
});

test('appendDecision rejects an amend decision without amendmentAdr', () => {
  assert.throws(
    () => appendDecision(rootDir(), decision({decision: 'amend'}), {clock: () => NOW}),
    /amendmentAdr/,
  );
});

test('appendDecision rejects an unknown stage', () => {
  assert.throws(
    () =>
      appendDecision(rootDir(), decision({stage: 'release' as never}), {clock: () => NOW}),
    /stage/,
  );
});

test('appendDecision rejects an unknown decision kind', () => {
  assert.throws(
    () =>
      appendDecision(rootDir(), decision({decision: 'ignore' as never}), {clock: () => NOW}),
    /decision/,
  );
});

test('two appends produce exactly two ledger lines', () => {
  const root = rootDir();
  appendDecision(root, decision(), {clock: () => NOW});
  appendDecision(root, decision({deliverable: 'D2'}), {clock: () => NOW});
  const lines = readFileSync(join(root, LEDGER_PATH), 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 2);
});

test('a second append leaves the first line byte-for-byte unchanged', () => {
  const root = rootDir();
  appendDecision(root, decision(), {clock: () => NOW});
  const first = readFileSync(join(root, LEDGER_PATH), 'utf8');
  appendDecision(root, decision({deliverable: 'D2'}), {clock: () => NOW});
  const after = readFileSync(join(root, LEDGER_PATH), 'utf8');
  assert.ok(after.startsWith(first));
});

test('readLedger returns an empty list when the ledger file is absent', () => {
  assert.deepEqual(readLedger(rootDir()), []);
});

test('readLedger names the malformed line number', () => {
  const root = rootDir();
  const path = join(root, LEDGER_PATH);
  mkdirSync(join(root, '.delivery'), {recursive: true});
  writeFileSync(path, `${JSON.stringify({id: 'adrd-000000000001'})}\n{not json}\n`, {
    encoding: 'utf8',
    flag: 'w+',
  });
  assert.throws(() => readLedger(root), /line 2/);
});

test('activeDecision ignores a non-standing entry for another deliverable', () => {
  const root = rootDir();
  appendDecision(root, decision({deliverable: 'D1'}), {clock: () => NOW});
  assert.equal(activeDecision(readLedger(root), key({deliverable: 'D2'}), ctx()), null);
});

test('activeDecision applies a non-standing entry to its own deliverable', () => {
  const root = rootDir();
  const stored = appendDecision(root, decision({deliverable: 'D1'}), {clock: () => NOW});
  assert.equal(activeDecision(readLedger(root), key({deliverable: 'D1'}), ctx())?.id, stored.id);
});

test('activeDecision drops a standing entry whose expiry date has passed', () => {
  const root = rootDir();
  appendDecision(root, decision({standing: true, expires: '2026-05-31'}), {clock: () => NOW});
  assert.equal(activeDecision(readLedger(root), key(), ctx()), null);
});

test('activeDecision keeps a standing until-adr-change entry while the ADR hash matches', () => {
  const root = rootDir();
  const stored = appendDecision(
    root,
    decision({standing: true, expires: 'until-adr-change', adrHash: 'hash-a'}),
    {clock: () => NOW},
  );
  assert.equal(activeDecision(readLedger(root), key(), ctx('hash-a'))?.id, stored.id);
});

test('activeDecision drops a standing until-adr-change entry when the ADR hash changes', () => {
  const root = rootDir();
  appendDecision(
    root,
    decision({standing: true, expires: 'until-adr-change', adrHash: 'hash-a'}),
    {clock: () => NOW},
  );
  assert.equal(activeDecision(readLedger(root), key(), ctx('hash-b')), null);
});

test('activeDecision returns the later entry that supersedes an earlier one', () => {
  const root = rootDir();
  const first = appendDecision(root, decision(), {clock: () => NOW});
  const second = appendDecision(root, decision({supersedes: first.id}), {clock: () => NOW});
  assert.equal(activeDecision(readLedger(root), key(), ctx())?.id, second.id);
});

test('lapsedStanding returns the expired standing entry for citation', () => {
  const root = rootDir();
  const stored = appendDecision(
    root,
    decision({standing: true, expires: '2026-05-31'}),
    {clock: () => NOW},
  );
  assert.equal(lapsedStanding(readLedger(root), key(), ctx())?.id, stored.id);
});

test('lapsedStanding returns null while the standing entry still applies', () => {
  const root = rootDir();
  appendDecision(root, decision({standing: true, expires: '2026-12-31'}), {clock: () => NOW});
  assert.equal(lapsedStanding(readLedger(root), key(), ctx()), null);
});

test('carriedForward returns the latest ticket-stage entry for the deliverable', () => {
  const root = rootDir();
  appendDecision(root, decision({stage: 'ticket', deliverable: 'D1'}), {clock: () => NOW});
  const later = appendDecision(
    root,
    decision({stage: 'ticket', deliverable: 'D1', rationale: 'confirmed at ticket stage'}),
    {clock: () => NOW},
  );
  assert.equal(carriedForward(readLedger(root), {adrId: 'ADR-0001', ruleId: 'R1', deliverable: 'D1'})?.id, later.id);
});

test('carriedForward ignores a design-stage entry for the same deliverable', () => {
  const root = rootDir();
  appendDecision(root, decision({stage: 'design', deliverable: 'D1'}), {clock: () => NOW});
  assert.equal(carriedForward(readLedger(root), {adrId: 'ADR-0001', ruleId: 'R1', deliverable: 'D1'}), null);
});

test('adrContentHash is unchanged by CRLF line endings', () => {
  assert.equal(adrContentHash('line one\r\nline two\r\n'), adrContentHash('line one\nline two\n'));
});

test('toObservation maps an entry to an adr-conformance observation', () => {
  const stored = appendDecision(rootDir(), decision(), {clock: () => NOW});
  assert.deepEqual(toObservation(stored), {
    relation: 'adr-conformance',
    from: 'adr:ADR-0001/R1',
    to: 'src/store.ts',
    token: 'override',
    evidence: stored.id,
  });
});
