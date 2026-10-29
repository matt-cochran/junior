// ---------------------------------------------------------------------------
// Behavioral tests for the run-local Pi agent overlay and resume import.
//
// Fixture credentials are deliberately fake and are never logged.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import {
  OVERLAY_FILES,
  cleanupPiAgentOverlay,
  importResumeSession,
  preparePiAgentOverlay,
} from './pi-overlay.ts';

const SESSION_ID = 'fixture-session-abc123';
const SESSION_LINE = `${JSON.stringify({ type: 'session', id: SESSION_ID })}\n`;

function tempRoot(t: any): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-overlay-'));
  t.after(() => {
    try { chmodSync(join(root, 'source-agent'), 0o700); } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function sourceAgentDir(root: string, names: readonly string[] = OVERLAY_FILES): string {
  const source = join(root, 'source-agent');
  mkdirSync(source, { recursive: true });
  for (const name of names) writeFileSync(join(source, name), `fixture ${name}\n`);
  return source;
}

function priorSession(priorArtifactDir: string, id = SESSION_ID, contents = SESSION_LINE): string {
  const sessions = join(priorArtifactDir, 'pi-agent', 'sessions', '--work--');
  mkdirSync(sessions, { recursive: true });
  const path = join(sessions, `2026-10-29T10-00-00_${id}.jsonl`);
  writeFileSync(path, contents);
  return path;
}

function filesBelow(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry: any) => entry.isFile())
    .map((entry: any) => join(entry.parentPath ?? entry.path, entry.name).slice(dir.length + 1))
    .sort();
}

test('preparePiAgentOverlay succeeds when the source agent directory is read-only', (t) => {
  const root = tempRoot(t);
  const source = sourceAgentDir(root);
  chmodSync(source, 0o500);

  const result = preparePiAgentOverlay(join(root, 'run'), { PI_CODING_AGENT_DIR: source });

  assert.equal(result.error, undefined);
});

test('preparePiAgentOverlay creates the overlay directory with mode 0700', (t) => {
  const root = tempRoot(t);
  const source = sourceAgentDir(root);

  const result = preparePiAgentOverlay(join(root, 'run'), { PI_CODING_AGENT_DIR: source });

  assert.equal(statSync(result.dir!).mode & 0o777, 0o700);
});

test('preparePiAgentOverlay writes auth.json as a regular file with mode 0600', (t) => {
  const root = tempRoot(t);
  const source = sourceAgentDir(root);
  chmodSync(source, 0o500);

  const result = preparePiAgentOverlay(join(root, 'run'), { PI_CODING_AGENT_DIR: source });
  const auth = join(result.dir!, 'auth.json');
  const stat = statSync(auth);

  assert.deepEqual({ isFile: stat.isFile(), isSymlink: lstatSync(auth).isSymbolicLink(), mode: stat.mode & 0o777 }, {
    isFile: true,
    isSymlink: false,
    mode: 0o600,
  });
});

test('preparePiAgentOverlay copies every credential file that exists in the source', (t) => {
  const root = tempRoot(t);
  const source = sourceAgentDir(root);

  const result = preparePiAgentOverlay(join(root, 'run'), { PI_CODING_AGENT_DIR: source });

  assert.deepEqual(result.copied, [...OVERLAY_FILES]);
});

test('preparePiAgentOverlay succeeds when no credential files exist', (t) => {
  const root = tempRoot(t);
  const source = join(root, 'source-agent');
  mkdirSync(source, { recursive: true });

  const result = preparePiAgentOverlay(join(root, 'run'), { PI_CODING_AGENT_DIR: source });

  assert.deepEqual({ dir: result.dir, error: result.error, copied: result.copied }, {
    dir: join(root, 'run', 'pi-agent'),
    error: undefined,
    copied: [],
  });
});

test('cleanupPiAgentOverlay removes the copied credential files', (t) => {
  const root = tempRoot(t);
  const source = sourceAgentDir(root);
  const result = preparePiAgentOverlay(join(root, 'run'), { PI_CODING_AGENT_DIR: source });

  cleanupPiAgentOverlay(result.dir!);

  assert.deepEqual(OVERLAY_FILES.map((name) => existsSync(join(result.dir!, name))), [false, false, false]);
});

test('cleanupPiAgentOverlay removes overlay lock files', (t) => {
  const root = tempRoot(t);
  const source = sourceAgentDir(root);
  const result = preparePiAgentOverlay(join(root, 'run'), { PI_CODING_AGENT_DIR: source });
  writeFileSync(join(result.dir!, 'auth.json.lock'), 'fixture lock\n');

  cleanupPiAgentOverlay(result.dir!);

  assert.equal(existsSync(join(result.dir!, 'auth.json.lock')), false);
});

test('cleanupPiAgentOverlay leaves session files in place for resume', (t) => {
  const root = tempRoot(t);
  const source = sourceAgentDir(root);
  const result = preparePiAgentOverlay(join(root, 'run'), { PI_CODING_AGENT_DIR: source });
  const session = join(result.dir!, 'sessions', '--work--', `2026-10-29T10-00-00_${SESSION_ID}.jsonl`);
  mkdirSync(join(session, '..'), { recursive: true });
  writeFileSync(session, SESSION_LINE);

  cleanupPiAgentOverlay(result.dir!);

  assert.equal(existsSync(session), true);
});

test('cleanupPiAgentOverlay never throws for a missing overlay', (t) => {
  const root = tempRoot(t);

  assert.doesNotThrow(() => cleanupPiAgentOverlay(join(root, 'absent')));
});

test('importResumeSession copies exactly the referenced session file', (t) => {
  const root = tempRoot(t);
  const prior = join(root, 'prior');
  priorSession(prior, SESSION_ID);
  priorSession(prior, 'another-session');
  const overlay = join(root, 'overlay');

  importResumeSession(prior, SESSION_ID, overlay);

  assert.deepEqual(filesBelow(overlay), [`sessions/--work--/2026-10-29T10-00-00_${SESSION_ID}.jsonl`]);
});

test('importResumeSession returns the copied session path at the same relative location', (t) => {
  const root = tempRoot(t);
  const prior = join(root, 'prior');
  priorSession(prior, SESSION_ID);
  const overlay = join(root, 'overlay');

  const result = importResumeSession(prior, SESSION_ID, overlay);

  assert.equal(result.path, join(overlay, 'sessions', '--work--', `2026-10-29T10-00-00_${SESSION_ID}.jsonl`));
});

test('importResumeSession returns a typed error when the prior session is missing', (t) => {
  const root = tempRoot(t);
  const prior = join(root, 'prior');
  const overlay = join(root, 'overlay');

  const result = importResumeSession(prior, SESSION_ID, overlay);

  assert.deepEqual(result.error, {
    code: 'resume_session_unavailable',
    missing: join(prior, 'pi-agent', 'sessions'),
    message: `session ${SESSION_ID} was not found under ${join(prior, 'pi-agent', 'sessions')}`,
  });
});

test('importResumeSession returns a typed error when the prior session is empty', (t) => {
  const root = tempRoot(t);
  const prior = join(root, 'prior');
  const path = priorSession(prior, SESSION_ID, '');
  const overlay = join(root, 'overlay');

  const result = importResumeSession(prior, SESSION_ID, overlay);

  assert.deepEqual(result.error, {
    code: 'resume_session_unavailable',
    missing: path,
    message: `session ${SESSION_ID} is empty or unreadable at ${path}`,
  });
});

test('importResumeSession returns a typed error when the prior session is malformed', (t) => {
  const root = tempRoot(t);
  const prior = join(root, 'prior');
  const path = priorSession(prior, SESSION_ID, 'not json\n');
  const overlay = join(root, 'overlay');

  const result = importResumeSession(prior, SESSION_ID, overlay);

  assert.deepEqual(result.error, {
    code: 'resume_session_unavailable',
    missing: path,
    message: `session ${SESSION_ID} is malformed at ${path}`,
  });
});
