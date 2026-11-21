// Machine-wide admission control (#277), lane M1.
// Every scenario uses a temp state dir, a fake procRoot and a manual clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManualClock } from './clock.ts';
import {
  DEFAULT_MACHINE_CONFIG,
  admit,
  admissionSnapshot,
  poolFor,
  resolveMachineConfig,
  validateMachineConfig,
  type AdmissionWait,
  type ResolvedMachineConfig,
} from './admission.ts';

const DEAD_PID = 2_147_483_647;
const EMPTY_PROC = mkdtempSync(join(tmpdir(), 'junior-admission-proc-'));

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function config(overrides: Partial<ResolvedMachineConfig> = {}): ResolvedMachineConfig {
  return { ...DEFAULT_MACHINE_CONFIG, ...overrides };
}

function writeMeminfo(procRoot: string, availableKb: number): void {
  writeFileSync(join(procRoot, 'meminfo'), `MemTotal: 16000000 kB\nMemAvailable: ${availableKb} kB\n`);
}

function writePswpout(procRoot: string, pages: number): void {
  writeFileSync(join(procRoot, 'vmstat'), `nr_free_pages 1\npswpout ${pages}\n`);
}

function slotFile(stateDir: string, index: number): string {
  return join(stateDir, 'admission', 'slots', `${index}.json`);
}

function writeSlot(stateDir: string, index: number, pid: number, holder: string): void {
  const path = slotFile(stateDir, index);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ holder, pid, kind: 'worker', pool: null, acquiredAt: '2026-01-01T00:00:00.000Z' }));
}

test('validateMachineConfig rejects an unknown key', () => {
  assert.throws(() => validateMachineConfig({ slotz: 2 }), /Unknown machine field: slotz/);
});

test('validateMachineConfig rejects a non-positive integer slots value', () => {
  assert.throws(() => validateMachineConfig({ slots: 0 }), /machine\.slots/);
});

test('validateMachineConfig rejects a negative threshold', () => {
  assert.throws(() => validateMachineConfig({ minAvailableMb: -1 }), /machine\.minAvailableMb/);
});

test('validateMachineConfig rejects a pool without a non-empty match array', () => {
  assert.throws(() => validateMachineConfig({ pools: { dotnet: { match: [], limit: 2 } } }), /pools\.dotnet\.match/);
});

test('validateMachineConfig accepts a valid partial machine block', () => {
  assert.doesNotThrow(() => validateMachineConfig({ slots: 2, pools: { dotnet: { match: ['dotnet'], limit: 2 } } }));
});

test('resolveMachineConfig lets the contract override the project field by field', () => {
  const cwd = tempDir('junior-admission-cfg-');
  writeFileSync(join(cwd, 'delivery.config.json'), JSON.stringify({ machine: { slots: 2, minAvailableMb: 100 } }));
  const resolved = resolveMachineConfig(cwd, { machine: { slots: 3 } });
  assert.equal(resolved.slots, 3);
});

test('resolveMachineConfig keeps the project value the contract omits', () => {
  const cwd = tempDir('junior-admission-cfg-');
  writeFileSync(join(cwd, 'delivery.config.json'), JSON.stringify({ machine: { slots: 2, minAvailableMb: 100 } }));
  const resolved = resolveMachineConfig(cwd, { machine: { slots: 3 } });
  assert.equal(resolved.minAvailableMb, 100);
});

test('JUNIOR_ADMISSION=off turns admission off', () => {
  const cwd = tempDir('junior-admission-cfg-');
  const previous = process.env.JUNIOR_ADMISSION;
  process.env.JUNIOR_ADMISSION = 'off';
  try {
    assert.equal(resolveMachineConfig(cwd).enabled, false);
  } finally {
    if (previous === undefined) delete process.env.JUNIOR_ADMISSION;
    else process.env.JUNIOR_ADMISSION = previous;
  }
});

test('poolFor matches a pool on an exact command', () => {
  const resolved = config({ pools: { dotnet: { match: ['dotnet test'], limit: 2 } } });
  assert.equal(poolFor(['dotnet', 'test'], resolved), 'dotnet');
});

test('poolFor matches a pool prefix at a word boundary', () => {
  const resolved = config({ pools: { dotnet: { match: ['dotnet'], limit: 2 } } });
  assert.equal(poolFor(['dotnet', 'test', '--no-build'], resolved), 'dotnet');
});

test('poolFor does not match a longer word with the same prefix', () => {
  const resolved = config({ pools: { dotnet: { match: ['dotnet'], limit: 2 } } });
  assert.equal(poolFor(['dotnetfoo'], resolved), null);
});

test('poolFor sees through an env prefix', () => {
  const resolved = config({ pools: { dotnet: { match: ['dotnet'], limit: 2 } } });
  assert.equal(poolFor(['env', 'DOTNET_CLI=1', 'dotnet', 'test'], resolved), 'dotnet');
});

test('admission is disabled so a slot is granted at once', async () => {
  const stateDir = tempDir('junior-admission-state-');
  const result = await admit({ kind: 'check', holder: 'r-1', config: config({ enabled: false, slots: 1 }), procRoot: EMPTY_PROC, stateDir });
  assert.equal(result.ok, true);
});

test('a request beyond the slot limit waits with reason slots', async () => {
  const stateDir = tempDir('junior-admission-state-');
  const clock = createManualClock('2026-01-01T00:00:00.000Z');
  const held = await admit({ kind: 'worker', holder: 'r-1', config: config({ slots: 1 }), procRoot: EMPTY_PROC, stateDir, clock });
  assert.equal(held.ok, true);
  const waits: AdmissionWait[] = [];
  const waiting = admit({ kind: 'worker', holder: 'r-2', config: config({ slots: 1 }), procRoot: EMPTY_PROC, stateDir, clock, onWait: (w) => waits.push(w) });
  await clock.advanceAsync(0);
  assert.equal(waits[0]?.reason, 'slots');
  held.grant.release();
  await clock.advanceAsync(2_000);
  await waiting;
});

test('a waiting request is admitted when the holder releases its slot', async () => {
  const stateDir = tempDir('junior-admission-state-');
  const clock = createManualClock('2026-01-01T00:00:00.000Z');
  const held = await admit({ kind: 'worker', holder: 'r-1', config: config({ slots: 1 }), procRoot: EMPTY_PROC, stateDir, clock });
  assert.ok(held.ok);
  const waiting = admit({ kind: 'worker', holder: 'r-2', config: config({ slots: 1 }), procRoot: EMPTY_PROC, stateDir, clock });
  await clock.advanceAsync(0);
  held.grant.release();
  await clock.advanceAsync(2_000);
  const result = await waiting;
  assert.equal(result.ok, true);
});

test('a third check matching a full pool waits with reason pool', async () => {
  const stateDir = tempDir('junior-admission-state-');
  const clock = createManualClock('2026-01-01T00:00:00.000Z');
  const resolved = config({ slots: 4, pools: { dotnet: { match: ['dotnet'], limit: 2 } } });
  const first = await admit({ kind: 'check', holder: 'r-1', argv: ['dotnet', 'test'], config: resolved, procRoot: EMPTY_PROC, stateDir, clock });
  const second = await admit({ kind: 'check', holder: 'r-2', argv: ['dotnet', 'test'], config: resolved, procRoot: EMPTY_PROC, stateDir, clock });
  assert.ok(first.ok && second.ok);
  const waits: AdmissionWait[] = [];
  const waiting = admit({ kind: 'check', holder: 'r-3', argv: ['dotnet', 'test'], config: resolved, procRoot: EMPTY_PROC, stateDir, clock, onWait: (w) => waits.push(w) });
  await clock.advanceAsync(0);
  assert.equal(waits[0]?.reason, 'pool');
  first.grant.release();
  second.grant.release();
  await clock.advanceAsync(2_000);
  await waiting;
});

test('a non-matching check is admitted while the matching pool is full', async () => {
  const stateDir = tempDir('junior-admission-state-');
  const clock = createManualClock('2026-01-01T00:00:00.000Z');
  const resolved = config({ slots: 4, pools: { dotnet: { match: ['dotnet'], limit: 2 } } });
  await admit({ kind: 'check', holder: 'r-1', argv: ['dotnet', 'test'], config: resolved, procRoot: EMPTY_PROC, stateDir, clock });
  await admit({ kind: 'check', holder: 'r-2', argv: ['dotnet', 'test'], config: resolved, procRoot: EMPTY_PROC, stateDir, clock });
  const result = await admit({ kind: 'check', holder: 'r-3', argv: ['npm', 'test'], config: resolved, procRoot: EMPTY_PROC, stateDir, clock });
  assert.equal(result.ok, true);
});

test('a worker never takes a pool slot', async () => {
  const stateDir = tempDir('junior-admission-state-');
  const clock = createManualClock('2026-01-01T00:00:00.000Z');
  const resolved = config({ slots: 4, pools: { dotnet: { match: ['dotnet'], limit: 1 } } });
  await admit({ kind: 'check', holder: 'r-1', argv: ['dotnet', 'test'], config: resolved, procRoot: EMPTY_PROC, stateDir, clock });
  const result = await admit({ kind: 'worker', holder: 'r-2', argv: ['dotnet', 'test'], config: resolved, procRoot: EMPTY_PROC, stateDir, clock });
  assert.equal(result.ok, true);
});

test('a slot held by a dead pid is reclaimed', async () => {
  const stateDir = tempDir('junior-admission-state-');
  writeSlot(stateDir, 0, DEAD_PID, 'ghost');
  const result = await admit({ kind: 'worker', holder: 'r-1', config: config({ slots: 1 }), procRoot: EMPTY_PROC, stateDir });
  assert.equal(result.ok, true);
});

test('low available memory blocks admission with reason memory', async () => {
  const stateDir = tempDir('junior-admission-state-');
  const procRoot = tempDir('junior-admission-proc-');
  writeMeminfo(procRoot, 1024);
  const clock = createManualClock('2026-01-01T00:00:00.000Z');
  const controller = new AbortController();
  const waits: AdmissionWait[] = [];
  const waiting = admit({ kind: 'worker', holder: 'r-1', config: config({ minAvailableMb: 2048 }), stateDir, procRoot, clock, signal: controller.signal, onWait: (w) => waits.push(w) });
  await clock.advanceAsync(0);
  assert.equal(waits[0]?.reason, 'memory');
  controller.abort(new Error('stop'));
  await clock.advanceAsync(2_000);
  await waiting;
});

test('high swap-out blocks admission with reason swap', async () => {
  const stateDir = tempDir('junior-admission-state-');
  const procRoot = tempDir('junior-admission-proc-');
  writeMeminfo(procRoot, 8_000_000);
  writePswpout(procRoot, 0);
  const clock = createManualClock('2026-01-01T00:00:00.000Z');
  const controller = new AbortController();
  const waits: AdmissionWait[] = [];
  const waiting = admit({ kind: 'worker', holder: 'r-1', config: config({ maxSwapOutPerSec: 500 }), stateDir, procRoot, clock, signal: controller.signal, onWait: (w) => waits.push(w) });
  writePswpout(procRoot, 1_000);
  await clock.advanceAsync(1_000);
  assert.equal(waits[0]?.reason, 'swap');
  controller.abort(new Error('stop'));
  await clock.advanceAsync(2_000);
  await waiting;
});

test('an unreadable procRoot never blocks admission', async () => {
  const stateDir = tempDir('junior-admission-state-');
  const result = await admit({ kind: 'worker', holder: 'r-1', config: config(), stateDir, procRoot: join(stateDir, 'missing-proc') });
  assert.equal(result.ok, true);
});

test('a request not admitted within admissionTimeoutMs returns E_ADMISSION_TIMEOUT', async () => {
  const stateDir = tempDir('junior-admission-state-');
  const clock = createManualClock('2026-01-01T00:00:00.000Z');
  const held = await admit({ kind: 'worker', holder: 'r-1', config: config({ slots: 1 }), procRoot: EMPTY_PROC, stateDir, clock });
  assert.ok(held.ok);
  const waiting = admit({ kind: 'worker', holder: 'r-2', config: config({ slots: 1, admissionTimeoutMs: 2_000 }), procRoot: EMPTY_PROC, stateDir, clock });
  await clock.advanceAsync(0);
  await clock.advanceAsync(2_000);
  const result = await waiting;
  assert.equal(result.ok === false ? result.error : null, 'E_ADMISSION_TIMEOUT');
});

test('release deletes the held slot files and is idempotent', async () => {
  const stateDir = tempDir('junior-admission-state-');
  const result = await admit({ kind: 'worker', holder: 'r-1', config: config({ slots: 1 }), procRoot: EMPTY_PROC, stateDir });
  assert.ok(result.ok);
  result.grant.release();
  result.grant.release();
  assert.deepEqual(readdirSync(join(stateDir, 'admission', 'slots')), []);
});

test('admissionSnapshot lists live holders only', () => {
  const stateDir = tempDir('junior-admission-state-');
  writeSlot(stateDir, 0, process.pid, 'live-holder');
  writeSlot(stateDir, 1, DEAD_PID, 'ghost');
  const snapshot = admissionSnapshot({ config: config({ slots: 2 }), stateDir, procRoot: EMPTY_PROC });
  assert.deepEqual(snapshot.slots.holders, ['live-holder']);
});

test('admissionSnapshot reports the unreadable pressure as unknown', () => {
  const stateDir = tempDir('junior-admission-state-');
  const snapshot = admissionSnapshot({ config: config(), stateDir, procRoot: join(stateDir, 'missing-proc') });
  assert.equal(snapshot.pressure.availableMb, null);
});

test('admissionSnapshot reports available memory from meminfo', () => {
  const stateDir = tempDir('junior-admission-state-');
  const procRoot = tempDir('junior-admission-proc-');
  writeMeminfo(procRoot, 4096 * 1024);
  const snapshot = admissionSnapshot({ config: config(), stateDir, procRoot });
  assert.equal(snapshot.pressure.availableMb, 4096);
});

test('a corrupt machine block is rejected by resolveMachineConfig', () => {
  const cwd = tempDir('junior-admission-cfg-');
  writeFileSync(join(cwd, 'delivery.config.json'), JSON.stringify({ machine: { slots: -2 } }));
  assert.throws(() => resolveMachineConfig(cwd), /machine\.slots/);
});

test('an abort while waiting returns E_ADMISSION_INTERRUPTED', async () => {
  const stateDir = tempDir('junior-admission-state-');
  const clock = createManualClock('2026-01-01T00:00:00.000Z');
  const held = await admit({ kind: 'worker', holder: 'r-1', config: config({ slots: 1 }), procRoot: EMPTY_PROC, stateDir, clock });
  assert.ok(held.ok);
  const controller = new AbortController();
  const waiting = admit({ kind: 'worker', holder: 'r-2', config: config({ slots: 1 }), procRoot: EMPTY_PROC, stateDir, clock, signal: controller.signal });
  await clock.advanceAsync(0);
  controller.abort(new Error('stop'));
  await clock.advanceAsync(2_000);
  const result = await waiting;
  assert.equal(result.ok === false ? result.error : null, 'E_ADMISSION_INTERRUPTED');
});

test('a configured pool slot file is created while the check runs', async () => {
  const stateDir = tempDir('junior-admission-state-');
  const resolved = config({ slots: 2, pools: { dotnet: { match: ['dotnet'], limit: 1 } } });
  const result = await admit({ kind: 'check', holder: 'r-1', argv: ['dotnet', 'test'], config: resolved, procRoot: EMPTY_PROC, stateDir });
  assert.ok(result.ok);
  assert.equal(existsSync(join(stateDir, 'admission', 'pools', 'dotnet', '0.json')), true);
});


function writeRawSlot(stateDir: string, index: number, text: string): string {
  const path = slotFile(stateDir, index);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
}

test('an unparseable fresh slot file is not reclaimed', async () => {
  const stateDir = tempDir('junior-admission-state-');
  writeRawSlot(stateDir, 0, '{ not json');
  const clock = createManualClock(1_000_000);
  const controller = new AbortController();
  const waits: AdmissionWait[] = [];
  const waiting = admit({
    kind: 'worker',
    holder: 'r-1',
    config: config({ slots: 1 }),
    procRoot: EMPTY_PROC,
    stateDir,
    clock,
    signal: controller.signal,
    onWait: (w) => waits.push(w),
  });
  await clock.advanceAsync(0);
  const reason = waits[0]?.reason;
  controller.abort(new Error('stop'));
  await clock.advanceAsync(2_000);
  await waiting;
  assert.equal(reason, 'slots');
});

test('an unparseable slot file older than 60 seconds is reclaimed', async () => {
  const stateDir = tempDir('junior-admission-state-');
  const path = writeRawSlot(stateDir, 0, '{ not json');
  utimesSync(path, new Date(0), new Date(0));
  const result = await admit({
    kind: 'worker',
    holder: 'r-1',
    config: config({ slots: 1 }),
    procRoot: EMPTY_PROC,
    stateDir,
    clock: createManualClock(1_000_000),
  });
  assert.equal(result.ok, true);
});

test('an empty JUNIOR_STATE_DIR does not create admission state in the current directory', async () => {
  const cwd = tempDir('junior-admission-cwd-');
  const home = tempDir('junior-admission-home-');
  const previous = { cwd: process.cwd(), home: process.env.HOME, state: process.env.JUNIOR_STATE_DIR };
  process.chdir(cwd);
  process.env.HOME = home;
  process.env.JUNIOR_STATE_DIR = '';
  try {
    await admit({ kind: 'worker', holder: 'r-1', config: config({ slots: 1 }), procRoot: EMPTY_PROC });
    assert.equal(existsSync(join(cwd, 'admission')), false);
  } finally {
    process.chdir(previous.cwd);
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
    if (previous.state === undefined) delete process.env.JUNIOR_STATE_DIR;
    else process.env.JUNIOR_STATE_DIR = previous.state;
  }
});

test('an abort during the pressure sample returns E_ADMISSION_INTERRUPTED', async () => {
  const stateDir = tempDir('junior-admission-state-');
  const procRoot = tempDir('junior-admission-proc-');
  writeMeminfo(procRoot, 8_000_000);
  writePswpout(procRoot, 0);
  const clock = createManualClock('2026-01-01T00:00:00.000Z');
  const controller = new AbortController();
  const waiting = admit({
    kind: 'worker',
    holder: 'r-1',
    config: config({ slots: 1 }),
    procRoot,
    stateDir,
    clock,
    signal: controller.signal,
  });
  let outcome = 'pending';
  const tracked = waiting.then((result) => {
    outcome = result.ok === false ? result.error : 'granted';
    return outcome;
  });
  await clock.advanceAsync(0);
  controller.abort(new Error('stop'));
  await clock.advanceAsync(0);
  const observedWithoutAdvancingPastTheSample = outcome;
  await clock.advanceAsync(1_000);
  await tracked;
  assert.equal(observedWithoutAdvancingPastTheSample, 'E_ADMISSION_INTERRUPTED');
});

test('resolveMachineConfig reads JUNIOR_ADMISSION from the injected environment', () => {
  const cwd = tempDir('junior-admission-cfg-');
  const resolved = resolveMachineConfig(cwd, undefined, { JUNIOR_ADMISSION: 'off' });
  assert.equal(resolved.enabled, false);
});

test('two concurrent reclaims of one stale slot leave exactly one holder', async () => {
  const stateDir = tempDir('junior-admission-state-');
  writeSlot(stateDir, 0, DEAD_PID, 'ghost');
  const clock = createManualClock('2026-01-01T00:00:00.000Z');
  const controller = new AbortController();
  const outcomes: boolean[] = [];
  const first = admit({ kind: 'worker', holder: 'r-1', config: config({ slots: 1 }), procRoot: EMPTY_PROC, stateDir, clock, signal: controller.signal }).then((r) => outcomes.push(r.ok));
  const second = admit({ kind: 'worker', holder: 'r-2', config: config({ slots: 1 }), procRoot: EMPTY_PROC, stateDir, clock, signal: controller.signal }).then((r) => outcomes.push(r.ok));
  await clock.advanceAsync(0);
  const granted = outcomes.filter(Boolean).length;
  controller.abort(new Error('stop'));
  await clock.advanceAsync(2_000);
  await Promise.all([first, second]);
  assert.equal(granted, 1);
});
