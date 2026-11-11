// ---------------------------------------------------------------------------
// Synchronous child processes that survive restrictive sandboxes.
//
// Inside a Codex `workspace-write` sandbox (reproduced 2026-11-10 with
// `codex sandbox -P :workspace`), Node's spawnSync reports `error.code ===
// 'EPERM'` for every child even though the child ran, exited and produced its
// output, and a Node child (Pi, npm, jevitate) cannot write to a pipe at all: its
// stdout and stderr arrive empty while it exits 0. Plain file descriptors work.
//
// runSync therefore captures stdout and stderr through private temp files and
// drops an EPERM that comes with a real exit status. A spawn that really failed
// has no exit status, so its error is kept. Every synchronous child Junior
// starts goes through here (#201, #203).
// ---------------------------------------------------------------------------

import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Node's spawnSync default output limit, applied when no maxBuffer is given. */
export const DEFAULT_MAX_BUFFER = 1024 * 1024;

export interface RunSyncOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Milliseconds before the child is killed; 0 or absent means no limit. */
  timeout?: number;
  /** Text written to the child's stdin; without it stdin is empty. */
  input?: string;
  /** Byte limit per stream, like spawnSync's; exceeding it sets ENOBUFS. */
  maxBuffer?: number;
  shell?: boolean | string;
  killSignal?: NodeJS.Signals | number;
  /** `inherit` passes the parent's stdio through; `ignore` discards output. */
  stdio?: 'capture' | 'inherit' | 'ignore';
  /** Test seam: the spawnSync implementation to call. */
  spawn?: typeof spawnSync;
  /** Test seam: the directory temp capture files are created in. */
  tempRoot?: string;
}

export interface RunSyncResult {
  pid: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  /** The raw stdout bytes, for binary output such as `tar -xO` (#210). `stdout`
   * is these bytes decoded as UTF-8, which is lossy for non-text output. */
  stdoutBytes: Buffer;
  stderr: string;
  error?: NodeJS.ErrnoException;
  /** True when spawnSync reported EPERM although the child exited normally. */
  spuriousEperm?: boolean;
  /** How output was captured: temp files, or pipes when no temp dir could be made. */
  capture: 'files' | 'pipes' | 'none';
}

/** True for the sandbox artefact: EPERM from spawnSync while the child has an exit status. */
export function isSpuriousEperm(r: { error?: NodeJS.ErrnoException | Error; status: number | null }): boolean {
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' && typeof r.status === 'number';
}

function normalize(raw: ReturnType<typeof spawnSync>, stdout: Buffer, stderr: string, capture: RunSyncResult['capture']): RunSyncResult {
  const result: RunSyncResult = {
    pid: raw.pid ?? 0,
    status: raw.status,
    signal: raw.signal,
    stdout: stdout.toString('utf8'),
    stdoutBytes: stdout,
    stderr,
    capture,
  };
  const error = raw.error as NodeJS.ErrnoException | undefined;
  if (error && isSpuriousEperm({ error, status: raw.status })) result.spuriousEperm = true;
  else if (error) result.error = error;
  return result;
}

function readCapped(path: string, limit: number): { bytes: Buffer; overflow: boolean } {
  const size = statSync(path).size;
  if (size <= limit) return { bytes: readFileSync(path), overflow: false };
  return { bytes: readFileSync(path).subarray(0, limit), overflow: true };
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value === null || value === undefined) return Buffer.alloc(0);
  return Buffer.from(String(value), 'utf8');
}

function enobufs(command: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(`spawnSync ${command} ENOBUFS`);
  e.code = 'ENOBUFS';
  e.syscall = `spawnSync ${command}`;
  return e;
}

/**
 * Run a command synchronously and return its exit status and decoded output.
 * Unlike spawnSync, output is captured through temp files, so it is complete
 * inside sandboxes that break pipes, and a spurious EPERM is not an error.
 */
export function runSync(command: string, args: readonly string[] = [], opts: RunSyncOptions = {}): RunSyncResult {
  const spawn = opts.spawn ?? spawnSync;
  const base: SpawnSyncOptions = {
    cwd: opts.cwd,
    env: opts.env,
    shell: opts.shell,
    killSignal: opts.killSignal,
    windowsHide: true,
  };
  if (typeof opts.timeout === 'number' && opts.timeout > 0) base.timeout = opts.timeout;
  const limit = typeof opts.maxBuffer === 'number' && opts.maxBuffer > 0 ? opts.maxBuffer : DEFAULT_MAX_BUFFER;

  if (opts.stdio === 'inherit' || opts.stdio === 'ignore') {
    const raw = spawn(command, [...args], { ...base, stdio: opts.stdio === 'inherit' ? 'inherit' : 'ignore', input: undefined });
    return normalize(raw, Buffer.alloc(0), '', 'none');
  }

  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(opts.tempRoot ?? tmpdir(), 'junior-run-'));
  } catch {
    dir = undefined;
  }
  if (!dir) {
    // No writable temp dir: fall back to pipes, which still work outside a sandbox.
    const raw = spawn(command, [...args], { ...base, encoding: 'buffer', input: opts.input ?? '', maxBuffer: limit });
    return normalize(raw, toBuffer(raw.stdout), toBuffer(raw.stderr).toString('utf8'), 'pipes');
  }

  const fds: number[] = [];
  try {
    const outPath = join(dir, 'stdout');
    const errPath = join(dir, 'stderr');
    let stdin: number | 'ignore' = 'ignore';
    if (typeof opts.input === 'string') {
      const inPath = join(dir, 'stdin');
      writeFileSync(inPath, opts.input, { mode: 0o600 });
      stdin = openSync(inPath, 'r');
      fds.push(stdin);
    }
    const out = openSync(outPath, 'w', 0o600);
    fds.push(out);
    const err = openSync(errPath, 'w', 0o600);
    fds.push(err);
    const raw = spawn(command, [...args], { ...base, stdio: [stdin, out, err] });
    for (const fd of fds.splice(0)) closeSync(fd);
    const stdout = readCapped(outPath, limit);
    const stderr = readCapped(errPath, limit);
    const result = normalize(raw, stdout.bytes, stderr.bytes.toString('utf8'), 'files');
    if ((stdout.overflow || stderr.overflow) && !result.error) result.error = enobufs(command);
    return result;
  } finally {
    for (const fd of fds) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
