// ---------------------------------------------------------------------------
// Exclusive lock files that record their holder.
//
// A lock is created with `open(path, 'wx')` and stamped with the holder's pid,
// hostname and creation time. When the holder dies without running its cleanup
// (Node aborting on an unhandled error, a kill -9), the lock file stays behind.
// On contention, a lock left by a dead holder on this host is reaped. A lock
// from another host, an unparseable or legacy lock, or a live pid is never
// removed. Used by the HOP manifest lock and the tool install lock (#210).
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import process from "node:process";

export type LockHolder = { pid?: number; hostname?: string };

/** Read the holder recorded by an existing lock file, or null when it is
 * unreadable, malformed (legacy) or already gone. */
export function readLockHolder(lockPath: string): LockHolder | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const pid = typeof rec.pid === "number" && Number.isInteger(rec.pid) && rec.pid > 0 ? rec.pid : undefined;
  const hostname = typeof rec.hostname === "string" && rec.hostname.length > 0 ? rec.hostname : undefined;
  return { pid, hostname };
}

/** True when `pid` names a live process (or liveness cannot be proven). Only a
 * `process.kill(pid, 0)` that throws ESRCH proves the holder is gone. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Remove a lock left by a dead same-host holder. A lock from another host, an
 * unparseable/legacy lock, or a live pid is never removed (returns false). */
export function reapDeadHolderLock(lockPath: string): boolean {
  const holder = readLockHolder(lockPath);
  if (!holder || holder.hostname !== os.hostname() || holder.pid === undefined) return false;
  if (isPidAlive(holder.pid)) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/** Stamp a freshly created lock file descriptor with this process as holder. */
export function writeLockHolder(fd: number, at: string = new Date().toISOString()): void {
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname(), at }));
}
