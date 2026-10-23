// Behavioral tests for the append-only session notes store.
//
// Every scenario uses a temporary project root; no test touches the
// repository's own .delivery directory.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addNote,
  dismiss,
  listOpen,
  markDone,
  notesPath,
  promote,
  writeProposal,
  type NotesDeps,
} from './notes.ts';

function workspace(t: any): string {
  const dir = mkdtempSync(join(tmpdir(), 'junior-notes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lineCount(root: string): number {
  try {
    return readFileSync(notesPath(root), 'utf8').split('\n').filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

function fixedDeps(ids: string[], at = '2026-10-23T15:49:11.000Z'): NotesDeps {
  let next = 0;
  return {
    now: () => new Date(at),
    newId: () => ids[next++] ?? `n-extra-${next}`,
  };
}

function proposal(root: string, text: string, captureId = 'c1', id?: string) {
  return writeProposal(root, { kind: 'risk', text, captureId }, fixedDeps([id ?? 'n-proposal']));
}

test('addNote stores the given text in listOpen notes', (t) => {
  const root = workspace(t);
  addNote(root, { text: 'Call Bob' });
  assert.equal(listOpen(root).notes[0]?.text, 'Call Bob');
});

test('addNote defaults the kind to note', (t) => {
  const root = workspace(t);
  addNote(root, { text: 'Call Bob' });
  assert.equal(listOpen(root).notes[0]?.kind, 'note');
});

test('addNote records a manager source', (t) => {
  const root = workspace(t);
  addNote(root, { text: 'Call Bob' });
  assert.equal(listOpen(root).notes[0]?.source, 'manager');
});

test('addNote trims surrounding whitespace from the text', (t) => {
  const root = workspace(t);
  addNote(root, { text: '  Call Bob  ' });
  assert.equal(listOpen(root).notes[0]?.text, 'Call Bob');
});

test('addNote rejects text that is empty after trimming', (t) => {
  const root = workspace(t);
  assert.throws(() => addNote(root, { text: '   ' }), RangeError);
});

test('addNote rejects text longer than 500 characters', (t) => {
  const root = workspace(t);
  assert.throws(() => addNote(root, { text: 'x'.repeat(501) }), RangeError);
});

test('addNote creates the .delivery directory when it is missing', (t) => {
  const root = workspace(t);
  addNote(root, { text: 'Call Bob' });
  assert.equal(existsSync(notesPath(root)), true);
});

test('markDone removes a manager note from the open notes', (t) => {
  const root = workspace(t);
  const note = addNote(root, { text: 'Call Bob' });
  markDone(root, note.id);
  assert.deepEqual(listOpen(root).notes, []);
});

test('markDone returns false for an unknown id', (t) => {
  const root = workspace(t);
  assert.equal(markDone(root, 'n-missing'), false);
});

test('markDone appends nothing for an unknown id', (t) => {
  const root = workspace(t);
  addNote(root, { text: 'Call Bob' });
  const before = lineCount(root);
  markDone(root, 'n-missing');
  assert.equal(lineCount(root), before);
});

test('writeProposal lists a capture note as a proposal', (t) => {
  const root = workspace(t);
  proposal(root, 'Gate may miss X');
  assert.deepEqual(listOpen(root).proposals.map((note) => note.text), ['Gate may miss X']);
});

test('writeProposal keeps a capture note out of the open notes', (t) => {
  const root = workspace(t);
  proposal(root, 'Gate may miss X');
  assert.deepEqual(listOpen(root).notes, []);
});

test('writeProposal truncates evidence to 300 characters', (t) => {
  const root = workspace(t);
  writeProposal(root, { kind: 'risk', text: 'Gate may miss X', captureId: 'c1', evidence: 'e'.repeat(400) });
  assert.equal(listOpen(root).proposals[0]?.evidence?.length, 300);
});

test('promote moves a pending proposal into the open notes', (t) => {
  const root = workspace(t);
  const note = proposal(root, 'Gate may miss X');
  promote(root, note!.id);
  assert.deepEqual(listOpen(root).notes.map((entry) => entry.id), [note!.id]);
});

test('promote removes the proposal from the pending proposals', (t) => {
  const root = workspace(t);
  const note = proposal(root, 'Gate may miss X');
  promote(root, note!.id);
  assert.deepEqual(listOpen(root).proposals, []);
});

test('promote returns false for a manager note', (t) => {
  const root = workspace(t);
  const note = addNote(root, { text: 'Call Bob' });
  assert.equal(promote(root, note.id), false);
});

test('dismiss removes a pending proposal', (t) => {
  const root = workspace(t);
  const note = proposal(root, 'Gate may miss X');
  dismiss(root, note!.id);
  assert.deepEqual(listOpen(root).proposals, []);
});

test('dismiss keeps a dismissed proposal out of the open notes', (t) => {
  const root = workspace(t);
  const note = proposal(root, 'Gate may miss X');
  dismiss(root, note!.id);
  assert.deepEqual(listOpen(root).notes, []);
});

test('dismiss returns false for an unknown id', (t) => {
  const root = workspace(t);
  assert.equal(dismiss(root, 'n-missing'), false);
});

test('a duplicate proposal with normalised text returns null', (t) => {
  const root = workspace(t);
  proposal(root, 'Gate may miss X');
  assert.equal(proposal(root, '  gate MAY   miss x ', 'c2', 'n-second'), null);
});

test('a duplicate proposal with normalised text appends no event', (t) => {
  const root = workspace(t);
  proposal(root, 'Gate may miss X');
  const before = lineCount(root);
  proposal(root, '  gate MAY   miss x ', 'c2', 'n-second');
  assert.equal(lineCount(root), before);
});

test('a proposal duplicating an open manager note returns null', (t) => {
  const root = workspace(t);
  addNote(root, { text: 'Gate may miss X' });
  assert.equal(proposal(root, 'gate may miss x'), null);
});

test('listOpen on a missing file returns empty lists', (t) => {
  const root = workspace(t);
  assert.deepEqual(listOpen(root), { notes: [], proposals: [] });
});

test('listOpen skips a line that is not valid JSON', (t) => {
  const root = workspace(t);
  addNote(root, { text: 'Call Bob' });
  appendFileSync(notesPath(root), 'not json\n');
  assert.equal(listOpen(root).notes.length, 1);
});

test('listOpen skips an event with an unknown op', (t) => {
  const root = workspace(t);
  addNote(root, { text: 'Call Bob' });
  appendFileSync(notesPath(root), JSON.stringify({ op: 'explode', id: 'n-x' }) + '\n');
  assert.equal(listOpen(root).notes.length, 1);
});

test('listOpen returns open notes oldest first', (t) => {
  const root = workspace(t);
  const first = addNote(root, { text: 'First' }, fixedDeps(['n-first']));
  const second = addNote(root, { text: 'Second' }, fixedDeps(['n-second']));
  assert.deepEqual(listOpen(root).notes.map((note) => note.id), [first.id, second.id]);
});
