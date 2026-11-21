// Machine-wide admission control across concurrent Junior runs (#277), lane M1.
//
// Every Junior process on the machine shares one slot semaphore: a lock
// directory under the user state dir (`$JUNIOR_STATE_DIR` or `~/.junior`,
// then `admission/`). A worker or a check takes a slot before it spawns and
// releases it when it exits. Checks whose command matches a pool also take a
// pool slot. Nothing starts while available memory is below
// `minAvailableMb` or swap-out is above `maxSwapOutPerSec`. A run that cannot
// be admitted within `admissionTimeoutMs` stops with `admission_timeout`.

import type { Clock } from './clock.ts';

export interface MachinePool {
  /** Command prefixes (argv joined by spaces) that belong to this pool, e.g. `["dotnet", "msbuild"]`. */
  match: string[];
  limit: number;
}

/** `machine` in delivery.config.json, or on a contract (the contract wins field by field). */
export interface MachineConfig {
  /** Machine-wide slots shared by workers and checks. */
  slots?: number;
  minAvailableMb?: number;
  /** Pages swapped out per second (from /proc/vmstat pswpout) above which nothing starts. */
  maxSwapOutPerSec?: number;
  admissionTimeoutMs?: number;
  pools?: Record<string, MachinePool>;
  /** `false` turns admission off for this project or contract. */
  enabled?: boolean;
}

export interface ResolvedMachineConfig {
  enabled: boolean;
  slots: number;
  minAvailableMb: number;
  maxSwapOutPerSec: number;
  admissionTimeoutMs: number;
  pools: Record<string, MachinePool>;
}

export interface AdmissionWait {
  reason: 'slots' | 'pool' | 'memory' | 'swap';
  /** Human-readable, e.g. `pool dotnet 2/2 held by r-1, r-2` or `available 1,204 MB < 2,048 MB`. */
  detail: string;
  pool: string | null;
  since: string;
}

export interface AdmissionRequest {
  kind: 'worker' | 'check';
  /** Run id plus kind/index, e.g. `A1/1795213751149:check-2`; recorded in the slot file. */
  holder: string;
  /** Check argv; selects the pool. */
  argv?: string[];
  config: ResolvedMachineConfig;
  clock?: Clock;
  signal?: AbortSignal;
  /** Overrides for tests. */
  stateDir?: string;
  procRoot?: string;
  pid?: number;
  /** Called when the run starts waiting and each time the reason changes. */
  onWait?: (wait: AdmissionWait) => void;
}

export interface AdmissionGrant {
  waitedMs: number;
  pool: string | null;
  /** Idempotent. */
  release(): void;
}

export type AdmissionResult =
  | { ok: true; grant: AdmissionGrant }
  | { ok: false; error: 'E_ADMISSION_TIMEOUT' | 'E_ADMISSION_INTERRUPTED'; wait: AdmissionWait | null; waitedMs: number };

export interface AdmissionSnapshot {
  enabled: boolean;
  slots: { held: number; limit: number; holders: string[] };
  pools: Record<string, { held: number; limit: number; holders: string[] }>;
  pressure: { availableMb: number | null; swapOutPerSec: number | null; minAvailableMb: number; maxSwapOutPerSec: number };
}

export const DEFAULT_MACHINE_CONFIG: ResolvedMachineConfig = {
  enabled: true,
  slots: 4,
  minAvailableMb: 2048,
  maxSwapOutPerSec: 500,
  admissionTimeoutMs: 30 * 60_000,
  pools: {},
};

/** Throws an actionable message on an unknown key or a bad value. */
export function validateMachineConfig(_value: unknown): void {}

/** delivery.config.json `machine`, then the contract's `machine`, over the defaults. */
export function resolveMachineConfig(_cwd: string, _task?: { machine?: unknown }): ResolvedMachineConfig {
  return { ...DEFAULT_MACHINE_CONFIG, enabled: false };
}

/** The pool an argv belongs to, or null. */
export function poolFor(_argv: string[], _config: ResolvedMachineConfig): string | null {
  return null;
}

/** Wait for a slot (and pool slot) under the pressure gate. */
export async function admit(req: AdmissionRequest): Promise<AdmissionResult> {
  return { ok: true, grant: { waitedMs: 0, pool: null, release() {} } };
}

/** Read-only view for `junior doctor`. */
export function admissionSnapshot(opts: { config: ResolvedMachineConfig; stateDir?: string; procRoot?: string; clock?: Clock }): AdmissionSnapshot {
  return {
    enabled: opts.config.enabled,
    slots: { held: 0, limit: opts.config.slots, holders: [] },
    pools: {},
    pressure: { availableMb: null, swapOutPerSec: null, minAvailableMb: opts.config.minAvailableMb, maxSwapOutPerSec: opts.config.maxSwapOutPerSec },
  };
}
