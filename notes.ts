// ---------------------------------------------------------------------------
// Local session notes: an append-only JSONL log under <root>/.delivery.
//
// Events describe adds and later state changes; standing is always computed
// by folding the log in order. Nothing here talks to the network or to the
// companion tools.

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type NoteKind = 'note' | 'decision' | 'question' | 'risk' | 'hypothesis' | 'todo';

export type Note = {
  id: string;
  kind: NoteKind;
  text: string;
  source: 'manager' | 'capture';
  createdAt: string;
  captureId?: string;
  evidence?: string;
  promoted?: boolean;
};

export type NotesDeps = {
  now?: () => Date;
  newId?: () => string;
  readFile?: (p: string) => string;
  appendFile?: (p: string, data: string) => void;
  exists?: (p: string) => boolean;
  mkdir?: (p: string) => void;
};

type Event = {
  op: 'add' | 'done' | 'promote' | 'dismiss';
  id: string;
  at?: string;
  kind?: NoteKind;
  text?: string;
  source?: 'manager' | 'capture';
  captureId?: string;
  evidence?: string;
};

type Entry = Note & { done: boolean; dismissed: boolean };

type ResolvedDeps = Required<NotesDeps>;

const MAX_TEXT = 500;
const MAX_EVIDENCE = 300;
const KNOWN_OPS = new Set(['add', 'done', 'promote', 'dismiss']);

function resolveDeps(deps: NotesDeps = {}): ResolvedDeps {
  return {
    now: deps.now ?? (() => new Date()),
    newId:
      deps.newId ??
      (() => `n-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`),
    readFile: deps.readFile ?? ((path) => readFileSync(path, 'utf8')),
    appendFile: deps.appendFile ?? ((path, data) => appendFileSync(path, data)),
    exists: deps.exists ?? ((path) => existsSync(path)),
    mkdir: deps.mkdir ?? ((path) => mkdirSync(path, { recursive: true })),
  };
}

function checkedText(raw: string): string {
  const text = String(raw ?? '').trim();
  if (text.length < 1 || text.length > MAX_TEXT) {
    throw new RangeError(`note text must be 1-${MAX_TEXT} characters`);
  }
  return text;
}

function normalised(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function notesPath(root: string): string {
  return join(root, '.delivery', 'notes.jsonl');
}

function readEvents(root: string, deps: ResolvedDeps): Event[] {
  const path = notesPath(root);
  if (!deps.exists(path)) return [];
  let raw: string;
  try {
    raw = deps.readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  const events: Event[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object') continue;
      if (!KNOWN_OPS.has(parsed.op)) continue;
      if (typeof parsed.id !== 'string' || parsed.id.length === 0) continue;
      events.push(parsed as Event);
    } catch {
      // A damaged line is ignored; the rest of the log remains readable.
    }
  }
  return events;
}

function fold(events: Event[]): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const event of events) {
    if (event.op === 'add') {
      if (typeof event.text !== 'string') continue;
      if (event.source !== 'manager' && event.source !== 'capture') continue;
      const capture = event.source === 'capture';
      entries.set(event.id, {
        id: event.id,
        kind: event.kind ?? 'note',
        text: event.text,
        source: event.source,
        createdAt: event.at ?? '',
        ...(capture && event.captureId !== undefined ? { captureId: event.captureId } : {}),
        ...(capture && event.evidence !== undefined ? { evidence: event.evidence } : {}),
        ...(capture ? { promoted: false } : {}),
        done: false,
        dismissed: false,
      });
      continue;
    }
    const entry = entries.get(event.id);
    if (!entry) continue;
    if (event.op === 'done') entry.done = true;
    if (event.op === 'promote') {
      entry.promoted = true;
    }
    if (event.op === 'dismiss') entry.dismissed = true;
  }
  return entries;
}

function publicNote(entry: Entry): Note {
  const { done: _done, dismissed: _dismissed, ...note } = entry;
  return note;
}

function appendEvent(root: string, event: Event, deps: ResolvedDeps): void {
  const path = notesPath(root);
  const dir = dirname(path);
  if (!deps.exists(dir)) deps.mkdir(dir);
  deps.appendFile(path, `${JSON.stringify(event)}\n`);
}

function isOpenNote(entry: Entry): boolean {
  if (entry.done || entry.dismissed) return false;
  if (entry.source === 'manager') return true;
  return entry.promoted === true;
}

function isPendingProposal(entry: Entry): boolean {
  return entry.source === 'capture' && entry.promoted !== true && !entry.dismissed && !entry.done;
}

function appendStateChange(
  root: string,
  id: string,
  op: 'done' | 'promote' | 'dismiss',
  deps: NotesDeps,
): boolean {
  const resolved = resolveDeps(deps);
  const entry = fold(readEvents(root, resolved)).get(id);
  if (!entry) return false;
  if (op === 'done' ? !isOpenNote(entry) : !isPendingProposal(entry)) return false;
  appendEvent(root, { op, id, at: resolved.now().toISOString() }, resolved);
  return true;
}

export function addNote(
  root: string,
  input: { text: string; kind?: NoteKind },
  deps?: NotesDeps,
): Note {
  const resolved = resolveDeps(deps);
  const text = checkedText(input.text);
  const note: Note = {
    id: resolved.newId(),
    kind: input.kind ?? 'note',
    text,
    source: 'manager',
    createdAt: resolved.now().toISOString(),
  };
  appendEvent(
    root,
    { op: 'add', id: note.id, kind: note.kind, text: note.text, source: 'manager', at: note.createdAt },
    resolved,
  );
  return note;
}

export function writeProposal(
  root: string,
  input: { kind: NoteKind; text: string; evidence?: string; captureId: string },
  deps?: NotesDeps,
): Note | null {
  const resolved = resolveDeps(deps);
  const text = checkedText(input.text);
  const entries = [...fold(readEvents(root, resolved)).values()];
  if (entries.some((entry) => (isOpenNote(entry) || isPendingProposal(entry)) && normalised(entry.text) === normalised(text))) {
    return null;
  }

  const note: Note = {
    id: resolved.newId(),
    kind: input.kind,
    text,
    source: 'capture',
    createdAt: resolved.now().toISOString(),
    captureId: input.captureId,
    ...(input.evidence !== undefined ? { evidence: String(input.evidence).slice(0, MAX_EVIDENCE) } : {}),
  };
  appendEvent(
    root,
    {
      op: 'add',
      id: note.id,
      kind: note.kind,
      text: note.text,
      source: 'capture',
      captureId: note.captureId,
      ...(note.evidence !== undefined ? { evidence: note.evidence } : {}),
      at: note.createdAt,
    },
    resolved,
  );
  return note;
}

export function markDone(root: string, id: string, deps?: NotesDeps): boolean {
  return appendStateChange(root, id, 'done', deps);
}

export function promote(root: string, id: string, deps?: NotesDeps): boolean {
  return appendStateChange(root, id, 'promote', deps);
}

export function dismiss(root: string, id: string, deps?: NotesDeps): boolean {
  return appendStateChange(root, id, 'dismiss', deps);
}

export function listOpen(
  root: string,
  deps?: NotesDeps,
): { notes: Note[]; proposals: Note[] } {
  const entries = [...fold(readEvents(root, resolveDeps(deps))).values()];
  return {
    notes: entries.filter(isOpenNote).map(publicNote),
    proposals: entries.filter(isPendingProposal).map(publicNote),
  };
}
