// ---------------------------------------------------------------------------
// Run-local Pi agent overlay and durable-session import.
//
// Pi creates auth.json.lock beside auth.json. A symlinked credential makes Pi
// write that lock into the protected source store, which fails when HOME is
// read-only. The overlay holds regular-file copies instead, so all lock and
// transient state stays below the run artifact directory. Sessions are kept
// there because resume needs them.
// ---------------------------------------------------------------------------

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { piAgentDir } from './model-updates.ts';

export { piAgentDir };

export const OVERLAY_FILES = ['auth.json', 'models.json', 'models-store.json'] as const;

export interface OverlayError {
  code: 'resume_session_unavailable';
  missing: string;
  message: string;
}

export interface PrepareOverlayResult {
  dir?: string;
  copied?: string[];
  error?: string;
}

/**
 * Create the writable, run-local Pi agent directory. Credential sources are
 * only read: each existing file is copied, made owner-only, and left in place.
 */
export function preparePiAgentOverlay(
  artifactDir: string,
  env: NodeJS.ProcessEnv = process.env,
): PrepareOverlayResult {
  const source = piAgentDir(env);
  const dir = join(artifactDir, 'pi-agent');
  const copied: string[] = [];
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    for (const name of OVERLAY_FILES) {
      const from = join(source, name);
      const to = join(dir, name);
      if (!existsSync(from) || existsSync(to)) continue;
      copyFileSync(from, to);
      chmodSync(to, 0o600);
      copied.push(name);
    }
    return { dir, copied };
  } catch (e: any) {
    return { error: `cannot create workspace-local Pi credential state at ${dir}: ${e?.message ?? String(e)}` };
  }
}

/**
 * Remove only the copied credentials and Pi lock files. Session files stay so
 * a later resume can import them. This is safe to call on every run path.
 */
export function cleanupPiAgentOverlay(dir: string): void {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
    for (const name of readdirSync(dir)) {
      if (!(OVERLAY_FILES as readonly string[]).includes(name) && !name.endsWith('.lock')) continue;
      try {
        unlinkSync(join(dir, name));
      } catch {
        // Cleanup is best effort and never changes the run outcome.
      }
    }
  } catch {
    // A missing or inaccessible overlay is already clean enough.
  }
}

function resumeError(code: OverlayError['code'], missing: string, message: string): { error: OverlayError } {
  return { error: { code, missing, message } };
}

function isMalformedSession(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Copy exactly the referenced Pi session JSONL from a prior run's overlay into
 * the new overlay at the same sessions/<cwd-dir>/ relative path. Credentials
 * and other sessions are never copied. Missing, empty, unreadable or malformed
 * sessions produce a typed resume_session_unavailable error.
 */
export function importResumeSession(
  priorArtifactDir: string,
  sessionId: string,
  overlayDir: string,
): { path?: string; error?: OverlayError } {
  const sessionsRoot = join(priorArtifactDir, 'pi-agent', 'sessions');
  let directories: string[] = [];
  try {
    directories = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return resumeError('resume_session_unavailable', sessionsRoot, `session ${sessionId} was not found under ${sessionsRoot}`);
  }

  const suffix = `_${sessionId}.jsonl`;
  let sourcePath: string | undefined;
  for (const directory of directories) {
    const candidateDir = join(sessionsRoot, directory);
    let candidates: string[] = [];
    try {
      candidates = readdirSync(candidateDir)
        .filter((name) => name.endsWith(suffix))
        .sort();
    } catch {
      continue;
    }
    if (candidates.length) {
      sourcePath = join(candidateDir, candidates[0]);
      break;
    }
  }

  if (!sourcePath) {
    return resumeError('resume_session_unavailable', sessionsRoot, `session ${sessionId} was not found under ${sessionsRoot}`);
  }

  let text: string;
  try {
    text = readFileSync(sourcePath, 'utf8');
  } catch {
    return resumeError('resume_session_unavailable', sourcePath, `session ${sessionId} is empty or unreadable at ${sourcePath}`);
  }
  if (!text.trim()) {
    return resumeError('resume_session_unavailable', sourcePath, `session ${sessionId} is empty or unreadable at ${sourcePath}`);
  }
  if (isMalformedSession(text)) {
    return resumeError('resume_session_unavailable', sourcePath, `session ${sessionId} is malformed at ${sourcePath}`);
  }

  const relative = sourcePath.slice(sessionsRoot.length + 1);
  const destination = join(overlayDir, 'sessions', relative);
  try {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(sourcePath, destination);
    chmodSync(destination, 0o600);
  } catch (e: any) {
    return resumeError('resume_session_unavailable', sourcePath, `session ${sessionId} is unreadable at ${sourcePath}: ${e?.message ?? String(e)}`);
  }

  return { path: destination };
}
