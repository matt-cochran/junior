// Machine-wide admission control across concurrent Junior runs (#277), lane M1.
//
// Every Junior process on the machine shares one slot semaphore: a lock
// directory under the user state dir (`$JUNIOR_STATE_DIR` or `~/.junior`,
// then `admission/`). A worker or a check takes a slot before it spawns and
// releases it when it exits. Checks whose command matches a pool also take a
// pool slot. Nothing starts while available memory is below
// `minAvailableMb` or swap-out is above `maxSwapOutPerSec`. A run that cannot
// be admitted within `admissionTimeoutMs` stops with `admission_timeout`.

import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { systemClock, type Clock } from './clock.ts';
import { stripCommandPrefixes } from './command-policy.ts';

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

const MACHINE_FIELDS = ['enabled', 'slots', 'minAvailableMb', 'maxSwapOutPerSec', 'admissionTimeoutMs', 'pools'] as const;
const POOL_FIELDS = ['match', 'limit'] as const;
const POLL_INTERVAL_MS = 2_000;
const PRESSURE_SAMPLE_MS = 1_000;
const UNPARSEABLE_STALE_MS = 60_000;

interface SlotRecord {
  holder: string;
  pid: number;
  kind: 'worker' | 'check';
  pool: string | null;
  acquiredAt: string;
}

type PressureBlock = { reason: 'memory' | 'swap'; detail: string; pool: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Throws an actionable message on an unknown key or a bad value. */
export function validateMachineConfig(value: unknown): void {
  if (!isRecord(value)) throw Error('Invalid machine config (expected an object)');
  for (const key of Object.keys(value)) {
    if (!(MACHINE_FIELDS as readonly string[]).includes(key)) throw Error(`Unknown machine field: ${key}`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw Error('Invalid machine.enabled (expected a boolean)');
  }
  if (value.slots !== undefined && !isPositiveInteger(value.slots)) {
    throw Error('Invalid machine.slots (expected a positive integer)');
  }
  if (value.minAvailableMb !== undefined && !isNonNegativeNumber(value.minAvailableMb)) {
    throw Error('Invalid machine.minAvailableMb (expected a non-negative number)');
  }
  if (value.maxSwapOutPerSec !== undefined && !isNonNegativeNumber(value.maxSwapOutPerSec)) {
    throw Error('Invalid machine.maxSwapOutPerSec (expected a non-negative number)');
  }
  if (value.admissionTimeoutMs !== undefined && !isNonNegativeNumber(value.admissionTimeoutMs)) {
    throw Error('Invalid machine.admissionTimeoutMs (expected a non-negative number)');
  }
  if (value.pools !== undefined) {
    if (!isRecord(value.pools)) throw Error('Invalid machine.pools (expected an object)');
    for (const [name, pool] of Object.entries(value.pools)) {
      if (!isRecord(pool)) throw Error(`Invalid machine.pools.${name} (expected an object)`);
      for (const key of Object.keys(pool)) {
        if (!(POOL_FIELDS as readonly string[]).includes(key)) throw Error(`Unknown machine pool field: ${name}.${key}`);
      }
      if (!Array.isArray(pool.match) || pool.match.length === 0 || pool.match.some((entry) => typeof entry !== 'string' || !entry.trim())) {
        throw Error(`Invalid machine.pools.${name}.match (expected a non-empty array of strings)`);
      }
      if (!isPositiveInteger(pool.limit)) {
        throw Error(`Invalid machine.pools.${name}.limit (expected a positive integer)`);
      }
    }
  }
}

function machineFromConfigFile(cwd: string): unknown {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(cwd, 'delivery.config.json'), 'utf8'));
    return isRecord(parsed) ? parsed.machine : undefined;
  } catch {
    return undefined;
  }
}

/** delivery.config.json `machine`, then the contract's `machine`, over the defaults. */
export function resolveMachineConfig(
  cwd: string,
  task?: { machine?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMachineConfig {
  const fromFile = machineFromConfigFile(cwd);
  const fromTask = task?.machine;
  if (fromFile !== undefined) validateMachineConfig(fromFile);
  if (fromTask !== undefined) validateMachineConfig(fromTask);

  const project = (isRecord(fromFile) ? fromFile : {}) as Partial<ResolvedMachineConfig>;
  const contract = (isRecord(fromTask) ? fromTask : {}) as Partial<ResolvedMachineConfig>;
  const merged: ResolvedMachineConfig = { ...DEFAULT_MACHINE_CONFIG, ...project, ...contract };
  const pools: Record<string, MachinePool> = {};
  for (const [name, pool] of Object.entries(merged.pools ?? {})) {
    pools[name] = { match: [...pool.match], limit: pool.limit };
  }
  const environmentOff = (env.JUNIOR_ADMISSION ?? '').trim().toLowerCase() === 'off';
  return { ...merged, pools, enabled: environmentOff ? false : merged.enabled !== false };
}

/** The pool an argv belongs to, or null. */
export function poolFor(argv: string[], config: ResolvedMachineConfig): string | null {
  if (argv.length === 0) return null;
  const command = stripCommandPrefixes(argv).argv.join(' ').trim();
  if (!command) return null;
  for (const [name, pool] of Object.entries(config.pools)) {
    for (const raw of pool.match) {
      const match = raw.trim();
      if (!match) continue;
      if (command === match || command.startsWith(`${match} `)) return name;
    }
  }
  return null;
}

function admissionDir(stateDir?: string): string {
  // An empty override falls through: `||`, not `??`, so a blank
  // JUNIOR_STATE_DIR cannot put admission state in the current directory.
  const base = stateDir || process.env.JUNIOR_STATE_DIR || join(homedir(), '.junior');
  return join(base, 'admission');
}

function slotsDir(dir: string): string {
  return join(dir, 'slots');
}

function poolDir(dir: string, pool: string): string {
  return join(dir, 'pools', pool);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

function parseSlot(text: string): SlotRecord | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    return {
      holder: typeof parsed.holder === 'string' ? parsed.holder : '',
      pid: typeof parsed.pid === 'number' ? parsed.pid : Number.NaN,
      kind: parsed.kind === 'check' ? 'check' : 'worker',
      pool: typeof parsed.pool === 'string' ? parsed.pool : null,
      acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : '',
    };
  } catch {
    return null;
  }
}

function readSlotRaw(path: string): SlotRecord | null {
  try {
    return parseSlot(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function pathExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

type SlotState = 'live' | 'stale' | 'missing';

/**
 * Classify a slot file. A file that cannot be parsed is live until it is
 * older than `UNPARSEABLE_STALE_MS` on the injected clock: it may be a slot
 * another process is writing, and mistaking it for stale would let two runs
 * hold one slot.
 */
function slotState(path: string, clock: Clock): SlotState {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'live';
  }
  const record = parseSlot(text);
  if (record) return pidAlive(record.pid) ? 'live' : 'stale';
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'live';
  }
  return clock.now() - mtimeMs > UNPARSEABLE_STALE_MS ? 'stale' : 'live';
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already released */
  }
}

let tempCounter = 0;
let reclaimCounter = 0;

/**
 * Publish `record` at `path` atomically: write the complete JSON to a unique
 * temp file in the same directory, hard-link it into place (EEXIST means the
 * slot is taken), then unlink the temp. Readers only ever see a complete file.
 */
function createSlotFile(path: string, dir: string, record: SlotRecord): 'created' | 'exists' {
  tempCounter += 1;
  const temp = join(dir, `.tmp-${process.pid}-${tempCounter}`);
  try {
    writeFileSync(temp, JSON.stringify(record));
    try {
      linkSync(temp, path);
      return 'created';
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return 'exists';
      throw error;
    }
  } finally {
    removeQuietly(temp);
  }
}

function sanitizeHolder(holder: string): string {
  const safe = holder.replace(/[^A-Za-z0-9._-]/g, '-');
  return safe.length > 0 ? safe : 'holder';
}

/**
 * Reclaim a stale slot by renaming it aside first, so only one process can be
 * holding the stale file. The winner re-reads the renamed file: a live holder
 * (a fresh slot that raced with the stale read) is linked back into place and
 * treated as held; an actually stale file is deleted.
 */
function reclaimStale(path: string, dir: string, clock: Clock, holder: string, pid: number): 'removed' | 'held' | 'lost' {
  reclaimCounter += 1;
  const stalePath = `${path}.stale-${sanitizeHolder(holder)}-${pid}-${reclaimCounter}`;
  try {
    renameSync(path, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 'lost';
    throw error;
  }
  if (slotState(stalePath, clock) === 'live') {
    try {
      linkSync(stalePath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    }
    removeQuietly(stalePath);
    return 'held';
  }
  removeQuietly(stalePath);
  return 'removed';
}

/**
 * Take the first free slot in `dir`, reclaiming stale holders as they are
 * found. Returns the slot path, or null when every slot is held.
 */
function acquireSlot(dir: string, limit: number, record: SlotRecord, clock: Clock): string | null {
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < limit; index += 1) {
    const path = join(dir, `${index}.json`);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (createSlotFile(path, dir, record) === 'created') return path;
      const state = slotState(path, clock);
      if (state === 'missing') continue;
      if (state === 'live') break;
      const reclaimed = reclaimStale(path, dir, clock, record.holder, record.pid);
      if (reclaimed === 'held') break;
      // removed or lost: the path is free again, so retry the same index.
    }
  }
  return null;
}

function liveHolders(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const names = entries
    .filter((entry) => entry.endsWith('.json'))
    .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));
  const holders: string[] = [];
  for (const entry of names) {
    const record = readSlotRaw(join(dir, entry));
    if (record && pidAlive(record.pid)) holders.push(record.holder);
  }
  return holders;
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function readEntry(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function parseMemAvailable(text: string | null): number | null {
  if (text === null) return null;
  const match = /^MemAvailable:\s*(\d+)\s*kB/m.exec(text);
  if (!match) return null;
  return Number(match[1]) / 1024;
}

function parsePswpout(text: string | null): number | null {
  if (text === null) return null;
  const match = /^pswpout\s+(\d+)\s*$/m.exec(text);
  if (!match) return null;
  return Number(match[1]);
}

interface PressureSample {
  availableMb: number | null;
  pswpout: number | null;
}

function readPressureSample(procRoot: string): PressureSample {
  return {
    availableMb: parseMemAvailable(readEntry(join(procRoot, 'meminfo'))),
    pswpout: parsePswpout(readEntry(join(procRoot, 'vmstat'))),
  };
}

/** Available memory from one read; a swap rate needs two samples, so it is unknown here. */
function readPressureOnce(procRoot: string): { availableMb: number | null; swapOutPerSec: number | null } {
  const sample = readPressureSample(procRoot);
  return { availableMb: sample.availableMb, swapOutPerSec: null };
}

/** Sample meminfo and vmstat, one second apart on the injected clock, for a swap rate. */
async function measurePressure(
  procRoot: string,
  clock: Clock,
  signal?: AbortSignal,
): Promise<{ availableMb: number | null; swapOutPerSec: number | null }> {
  const first = readPressureSample(procRoot);
  if (first.pswpout === null) return { availableMb: first.availableMb, swapOutPerSec: null };
  const started = clock.now();
  await clock.sleep(PRESSURE_SAMPLE_MS, signal);
  const second = readPressureSample(procRoot);
  if (second.pswpout === null) return { availableMb: second.availableMb, swapOutPerSec: null };
  const elapsedSeconds = Math.max((clock.now() - started) / 1000, 0.001);
  const pagesPerSecond = Math.max(0, second.pswpout - first.pswpout) / elapsedSeconds;
  return { availableMb: second.availableMb, swapOutPerSec: pagesPerSecond };
}

function pressureBlock(
  pressure: { availableMb: number | null; swapOutPerSec: number | null },
  config: ResolvedMachineConfig,
): PressureBlock | null {
  if (pressure.availableMb !== null && pressure.availableMb < config.minAvailableMb) {
    return {
      reason: 'memory',
      detail: `available ${formatNumber(pressure.availableMb)} MB < ${formatNumber(config.minAvailableMb)} MB`,
      pool: null,
    };
  }
  if (pressure.swapOutPerSec !== null && pressure.swapOutPerSec > config.maxSwapOutPerSec) {
    return {
      reason: 'swap',
      detail: `swap-out ${formatNumber(pressure.swapOutPerSec)}/s > ${formatNumber(config.maxSwapOutPerSec)}/s`,
      pool: null,
    };
  }
  return null;
}

/** Wait for a slot (and pool slot) under the pressure gate. */
export async function admit(req: AdmissionRequest): Promise<AdmissionResult> {
  const clock = req.clock ?? systemClock;
  const root = admissionDir(req.stateDir);
  const pid = req.pid ?? process.pid;
  const pool = req.kind === 'check' ? poolFor(req.argv ?? [], req.config) : null;
  const poolLimit = pool ? req.config.pools[pool]?.limit ?? 0 : 0;
  const procRoot = req.procRoot ?? '/proc';
  const startedAt = clock.now();
  let poolPath: string | null = null;
  let machinePath: string | null = null;
  let released = false;
  let waitedMs = 0;
  let lastWait: AdmissionWait | null = null;
  let waitSince: string | null = null;

  const release = (): void => {
    if (released) return;
    released = true;
    if (poolPath) removeQuietly(poolPath);
    if (machinePath) removeQuietly(machinePath);
    poolPath = null;
    machinePath = null;
  };

  const immediateGrant = (): AdmissionResult => ({
    ok: true,
    grant: { waitedMs: 0, pool, release },
  });

  if (!req.config.enabled) return immediateGrant();

  const recordWait = (reason: AdmissionWait['reason'], detail: string, waitPool: string | null): void => {
    if (waitSince === null) waitSince = clock.iso();
    const wait: AdmissionWait = { reason, detail, pool: waitPool, since: waitSince };
    const changed = !lastWait || lastWait.reason !== wait.reason || lastWait.detail !== wait.detail || lastWait.pool !== wait.pool;
    lastWait = wait;
    if (changed) req.onWait?.(wait);
  };

  const waitingResult = (error: 'E_ADMISSION_TIMEOUT' | 'E_ADMISSION_INTERRUPTED'): AdmissionResult => {
    release();
    return { ok: false, error, wait: lastWait, waitedMs: clock.now() - startedAt };
  };

  for (;;) {
    if (req.signal?.aborted) return waitingResult('E_ADMISSION_INTERRUPTED');

    let pressure: { availableMb: number | null; swapOutPerSec: number | null };
    try {
      pressure = await measurePressure(procRoot, clock, req.signal);
    } catch {
      // An interrupted pressure sample is reported as an interruption, not a
      // pressure block: an unreadable /proc never blocks admission.
      if (req.signal?.aborted) return waitingResult('E_ADMISSION_INTERRUPTED');
      pressure = { availableMb: null, swapOutPerSec: null };
    }
    if (req.signal?.aborted) return waitingResult('E_ADMISSION_INTERRUPTED');

    let block: { reason: AdmissionWait['reason']; detail: string; pool: string | null } | null = pressureBlock(pressure, req.config);

    if (!block && pool) {
      const dir = poolDir(root, pool);
      poolPath = acquireSlot(dir, poolLimit, { holder: req.holder, pid, kind: req.kind, pool, acquiredAt: clock.iso() }, clock);
      if (!poolPath) {
        const holders = liveHolders(dir);
        block = {
          reason: 'pool',
          detail: `pool ${pool} ${holders.length}/${poolLimit} held by ${holders.join(', ') || 'unknown'}`,
          pool,
        };
      }
    }

    if (!block) {
      machinePath = acquireSlot(
        slotsDir(root),
        req.config.slots,
        { holder: req.holder, pid, kind: req.kind, pool, acquiredAt: clock.iso() },
        clock,
      );
      if (!machinePath) {
        // No hold-and-wait: give the pool slot back before waiting again.
        if (poolPath) removeQuietly(poolPath);
        poolPath = null;
        const holders = liveHolders(slotsDir(root));
        block = {
          reason: 'slots',
          detail: `slots ${holders.length}/${req.config.slots} held by ${holders.join(', ') || 'unknown'}`,
          pool: null,
        };
      }
    }

    if (!block) {
      waitedMs = clock.now() - startedAt;
      return { ok: true, grant: { waitedMs, pool, release } };
    }

    recordWait(block.reason, block.detail, block.pool);
    waitedMs = clock.now() - startedAt;
    if (waitedMs >= req.config.admissionTimeoutMs) return waitingResult('E_ADMISSION_TIMEOUT');

    try {
      await clock.sleep(POLL_INTERVAL_MS, req.signal);
    } catch {
      return waitingResult('E_ADMISSION_INTERRUPTED');
    }
  }
}

/** Read-only view for `junior doctor`. */
export function admissionSnapshot(opts: { config: ResolvedMachineConfig; stateDir?: string; procRoot?: string; clock?: Clock }): AdmissionSnapshot {
  const root = admissionDir(opts.stateDir);
  const pressure = readPressureOnce(opts.procRoot ?? '/proc');
  const holders = liveHolders(slotsDir(root));
  const pools: AdmissionSnapshot['pools'] = {};
  for (const [name, pool] of Object.entries(opts.config.pools)) {
    const poolHolders = liveHolders(poolDir(root, name));
    pools[name] = { held: poolHolders.length, limit: pool.limit, holders: poolHolders };
  }
  return {
    enabled: opts.config.enabled,
    slots: { held: holders.length, limit: opts.config.slots, holders },
    pools,
    pressure: {
      availableMb: pressure.availableMb,
      swapOutPerSec: pressure.swapOutPerSec,
      minAvailableMb: opts.config.minAvailableMb,
      maxSwapOutPerSec: opts.config.maxSwapOutPerSec,
    },
  };
}
