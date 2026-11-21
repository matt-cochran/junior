// ---------------------------------------------------------------------------
// Behavioral tests for review-queue aging and its optional notify hook.
//
// Every scenario builds a disposable `.delivery` tree and drives the public
// review-queue API. Each test asserts exactly one observable outcome: which
// runs are listed, what command comes next, whether the hook ran, or what the
// persisted notification state says. No real home directory, network or clock
// is used.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManualClock } from './clock.ts';
import {
  agingReviews,
  reviewQueue,
  validateReviewQueueConfig,
} from './review-queue.ts';

const NOW = '2026-01-01T12:00:00.000Z';
const clock = () => createManualClock(NOW);

const arena = (t: any): string => {
  const dir = mkdtempSync(join(tmpdir(), 'junior-review-queue-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const deliveryDir = (root: string) => join(root, '.delivery');

const writeRun = (
  root: string,
  id: string,
  stamp: string,
  result: Record<string, unknown>,
  opts: { mtime?: Date } = {},
): { dir: string; resultPath: string } => {
  const dir = join(deliveryDir(root), id, stamp);
  mkdirSync(dir, { recursive: true });
  const resultPath = join(dir, 'result.json');
  writeFileSync(resultPath, JSON.stringify(result));
  if (opts.mtime) utimesSync(resultPath, opts.mtime, opts.mtime);
  return { dir, resultPath };
};

const ready = (id: string, finishedAt: string) => ({
  id,
  status: 'ready_for_review',
  runtime: { finishedAt },
});

const fakeSpawn = (calls: any[], results: any[] = [{ status: 0, stdout: '', stderr: '' }]) =>
  ((command: string, args: string[], options: any) => {
    calls.push({ command, args, options });
    return results[Math.min(calls.length - 1, results.length - 1)];
  }) as any;

// --- listing ---------------------------------------------------------------

test('agingReviews lists a ready_for_review run older than the threshold', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  const aging = agingReviews({ deliveryDir: deliveryDir(root), agingMinutes: 30, clock: clock() });
  assert.deepEqual(aging.map((r) => r.id), ['d1']);
});

test('agingReviews orders aged runs oldest first', (t) => {
  const root = arena(t);
  writeRun(root, 'newer', '2000', ready('newer', '2026-01-01T11:00:00.000Z'));
  writeRun(root, 'older', '1000', ready('older', '2026-01-01T09:00:00.000Z'));
  const aging = agingReviews({ deliveryDir: deliveryDir(root), agingMinutes: 30, clock: clock() });
  assert.deepEqual(aging.map((r) => r.id), ['older', 'newer']);
});

test('agingReviews gives an aged run the junior apply command', (t) => {
  const root = arena(t);
  const { resultPath } = writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  const aging = agingReviews({ deliveryDir: deliveryDir(root), agingMinutes: 30, clock: clock() });
  assert.equal(aging[0].next, `junior apply ${resultPath}`);
});

test('agingReviews reports the age in minutes', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  const aging = agingReviews({ deliveryDir: deliveryDir(root), agingMinutes: 30, clock: clock() });
  assert.equal(aging[0].ageMinutes, 120);
});

test('agingReviews excludes a run younger than the threshold', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T11:45:00.000Z'));
  const aging = agingReviews({ deliveryDir: deliveryDir(root), agingMinutes: 30, clock: clock() });
  assert.deepEqual(aging, []);
});

test('agingReviews excludes a run whose status is not ready_for_review', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', { id: 'd1', status: 'failed', runtime: { finishedAt: '2026-01-01T10:00:00.000Z' } });
  const aging = agingReviews({ deliveryDir: deliveryDir(root), agingMinutes: 30, clock: clock() });
  assert.deepEqual(aging, []);
});

test('agingReviews excludes a ready run with an applied record beside it', (t) => {
  const root = arena(t);
  const { dir } = writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  writeFileSync(join(dir, 'applied.json'), '{}');
  const aging = agingReviews({ deliveryDir: deliveryDir(root), agingMinutes: 30, clock: clock() });
  assert.deepEqual(aging, []);
});

test('agingReviews excludes an older ready run when a newer run of the same id is applied', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T09:00:00.000Z'));
  const newer = writeRun(root, 'd1', '2000', ready('d1', '2026-01-01T10:00:00.000Z'));
  writeFileSync(join(newer.dir, 'applied.json'), '{}');
  const aging = agingReviews({ deliveryDir: deliveryDir(root), agingMinutes: 30, clock: clock() });
  assert.deepEqual(aging, []);
});

test('agingReviews prefers runtime.finishedAt over the result file mtime', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'), { mtime: new Date(NOW) });
  const aging = agingReviews({ deliveryDir: deliveryDir(root), agingMinutes: 30, clock: clock() });
  assert.deepEqual(aging.map((r) => r.id), ['d1']);
});

test('agingReviews falls back to the result file mtime when finishedAt is absent', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', { id: 'd1', status: 'ready_for_review' }, { mtime: new Date('2026-01-01T10:00:00.000Z') });
  const aging = agingReviews({ deliveryDir: deliveryDir(root), agingMinutes: 30, clock: clock() });
  assert.deepEqual(aging.map((r) => r.id), ['d1']);
});

test('agingReviews ignores a malformed result.json', (t) => {
  const root = arena(t);
  const dir = join(deliveryDir(root), 'd1', '1000');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'result.json'), '{not json');
  const aging = agingReviews({ deliveryDir: deliveryDir(root), agingMinutes: 30, clock: clock() });
  assert.deepEqual(aging, []);
});

// --- config validation -----------------------------------------------------

test('validateReviewQueueConfig accepts a valid config', () => {
  assert.doesNotThrow(() => validateReviewQueueConfig({ agingMinutes: 5, notify: { command: 'notify', args: ['--x'] } }));
});

test('validateReviewQueueConfig rejects an unknown key', () => {
  assert.throws(() => validateReviewQueueConfig({ agingMinutes: 5, extra: true }), /Unknown/);
});

test('validateReviewQueueConfig rejects a non-positive agingMinutes', () => {
  assert.throws(() => validateReviewQueueConfig({ agingMinutes: 0 }), /agingMinutes/);
});

test('validateReviewQueueConfig rejects a notify hook without a command', () => {
  assert.throws(() => validateReviewQueueConfig({ notify: { args: [] } }), /command/);
});

test('validateReviewQueueConfig rejects an unknown notify key', () => {
  assert.throws(() => validateReviewQueueConfig({ notify: { command: 'notify', shell: true } }), /Unknown/);
});

// --- reviewQueue config ----------------------------------------------------

test('reviewQueue reads agingMinutes from delivery.config.json', (t) => {
  const root = arena(t);
  writeFileSync(join(root, 'delivery.config.json'), JSON.stringify({ reviewQueue: { agingMinutes: 5 } }));
  writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T11:50:00.000Z'));
  const report = reviewQueue({ cwd: root, clock: clock(), spawn: fakeSpawn([]) });
  assert.deepEqual(report.aging.map((r) => r.id), ['d1']);
});

test('reviewQueue defaults agingMinutes to 30', (t) => {
  const root = arena(t);
  const report = reviewQueue({ cwd: root, clock: clock(), spawn: fakeSpawn([]) });
  assert.equal(report.agingMinutes, 30);
});

test('reviewQueue throws on an invalid reviewQueue config in delivery.config.json', (t) => {
  const root = arena(t);
  writeFileSync(join(root, 'delivery.config.json'), JSON.stringify({ reviewQueue: { agingMinutes: -1 } }));
  assert.throws(() => reviewQueue({ cwd: root, clock: clock(), spawn: fakeSpawn([]) }), /agingMinutes/);
});

test('reviewQueue throws on malformed delivery.config.json', (t) => {
  const root = arena(t);
  writeFileSync(join(root, 'delivery.config.json'), '{not json');
  assert.throws(() => reviewQueue({ cwd: root, clock: clock(), spawn: fakeSpawn([]) }), /not valid JSON/);
});

// --- notify hook -----------------------------------------------------------

test('reviewQueue sends the aged run JSON to the notify hook on stdin', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  const captured = join(root, 'stdin.json');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(captured)}, require('node:fs').readFileSync(0))`;
  reviewQueue({ cwd: root, config: { notify: { command: process.execPath, args: ['-e', script] } }, clock: clock(), spawn: spawnSync });
  assert.equal(JSON.parse(readFileSync(captured, 'utf8')).id, 'd1');
});

test('reviewQueue passes the configured notify arguments', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  const calls: any[] = [];
  reviewQueue({ cwd: root, config: { notify: { command: 'notify', args: ['--flag'] } }, clock: clock(), spawn: fakeSpawn(calls) });
  assert.deepEqual(calls[0].args, ['--flag']);
});

test('reviewQueue runs the notify hook without a shell', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  const calls: any[] = [];
  reviewQueue({ cwd: root, config: { notify: { command: 'notify' } }, clock: clock(), spawn: fakeSpawn(calls) });
  assert.equal(calls[0].options.shell, false);
});

test('reviewQueue bounds the notify hook with a ten second timeout', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  const calls: any[] = [];
  reviewQueue({ cwd: root, config: { notify: { command: 'notify' } }, clock: clock(), spawn: fakeSpawn(calls) });
  assert.equal(calls[0].options.timeout, 10_000);
});

test('reviewQueue does not run a notify hook when none is configured', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  const calls: any[] = [];
  reviewQueue({ cwd: root, clock: clock(), spawn: fakeSpawn(calls) });
  assert.equal(calls.length, 0);
});

test('reviewQueue records a successful notification by result path in review-queue.json', (t) => {
  const root = arena(t);
  const { resultPath } = writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  reviewQueue({ cwd: root, config: { notify: { command: 'notify' } }, clock: clock(), spawn: fakeSpawn([]) });
  const state = JSON.parse(readFileSync(join(deliveryDir(root), 'review-queue.json'), 'utf8'));
  assert.deepEqual(state.notified, [resultPath]);
});

test('reviewQueue does not notify a run whose result path is already recorded', (t) => {
  const root = arena(t);
  const { resultPath } = writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  writeFileSync(join(deliveryDir(root), 'review-queue.json'), JSON.stringify({ notified: [resultPath] }));
  const calls: any[] = [];
  reviewQueue({ cwd: root, config: { notify: { command: 'notify' } }, clock: clock(), spawn: fakeSpawn(calls) });
  assert.equal(calls.length, 0);
});

test('reviewQueue treats a legacy bare id as not matching any result path', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  writeFileSync(join(deliveryDir(root), 'review-queue.json'), JSON.stringify({ notified: ['d1'] }));
  const calls: any[] = [];
  reviewQueue({ cwd: root, config: { notify: { command: 'notify' } }, clock: clock(), spawn: fakeSpawn(calls) });
  assert.equal(calls.length, 1);
});

test('reviewQueue notifies a later run of an already-notified id', (t) => {
  const root = arena(t);
  const first = writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T09:00:00.000Z'));
  const spawn = fakeSpawn([]);
  reviewQueue({ cwd: root, config: { notify: { command: 'notify' } }, clock: clock(), spawn });
  writeFileSync(join(first.dir, 'applied.json'), '{}');
  const second = writeRun(root, 'd1', '2000', ready('d1', '2026-01-01T10:00:00.000Z'));
  const report = reviewQueue({ cwd: root, config: { notify: { command: 'notify' } }, clock: clock(), spawn });
  assert.deepEqual(report.notified, [second.resultPath]);
});

test('reviewQueue prunes a notified run that is no longer aging', (t) => {
  const root = arena(t);
  const { dir } = writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  const spawn = fakeSpawn([]);
  reviewQueue({ cwd: root, config: { notify: { command: 'notify' } }, clock: clock(), spawn });
  writeFileSync(join(dir, 'applied.json'), '{}');
  reviewQueue({ cwd: root, config: { notify: { command: 'notify' } }, clock: clock(), spawn });
  const state = JSON.parse(readFileSync(join(deliveryDir(root), 'review-queue.json'), 'utf8'));
  assert.deepEqual(state.notified, []);
});

test('reviewQueue notifies an aged run only once across calls', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  const calls: any[] = [];
  const spawn = fakeSpawn(calls);
  reviewQueue({ cwd: root, config: { notify: { command: 'notify' } }, clock: clock(), spawn });
  reviewQueue({ cwd: root, config: { notify: { command: 'notify' } }, clock: clock(), spawn });
  assert.equal(calls.length, 1);
});

test('reviewQueue reports a failing notify hook in notifyErrors', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  const report = reviewQueue({
    cwd: root,
    config: { notify: { command: 'notify' } },
    clock: clock(),
    spawn: fakeSpawn([], [{ status: 1, stdout: '', stderr: 'boom' }]),
  });
  assert.deepEqual(report.notifyErrors.map((e) => e.id), ['d1']);
});

test('reviewQueue reports a notify hook that cannot start in notifyErrors', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  const spawn = (() => { throw Error('cannot start'); }) as any;
  const report = reviewQueue({ cwd: root, config: { notify: { command: 'notify' } }, clock: clock(), spawn });
  assert.deepEqual(report.notifyErrors.map((e) => e.id), ['d1']);
});

test('reviewQueue reports a notification it could not record', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  mkdirSync(join(deliveryDir(root), 'review-queue.json'), { recursive: true });
  const report = reviewQueue({ cwd: root, config: { notify: { command: 'notify' } }, clock: clock(), spawn: fakeSpawn([]) });
  assert.deepEqual(report.notifyErrors.map((e) => e.id), ['d1']);
});

test('reviewQueue attempts a failing notify hook once per aged run', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T09:00:00.000Z'));
  writeRun(root, 'd1', '2000', ready('d1', '2026-01-01T10:00:00.000Z'));
  const calls: any[] = [];
  reviewQueue({
    cwd: root,
    config: { notify: { command: 'notify' } },
    clock: clock(),
    spawn: fakeSpawn(calls, [{ status: 1, stdout: '', stderr: 'boom' }]),
  });
  assert.equal(calls.length, 2);
});

test('reviewQueue records a notify hook that writes more than one megabyte to stdout', (t) => {
  const root = arena(t);
  const { resultPath } = writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  const report = reviewQueue({
    cwd: root,
    config: { notify: { command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(2 * 1024 * 1024))"] } },
    clock: clock(),
    spawn: spawnSync,
  });
  assert.deepEqual(report.notified, [resultPath]);
});

test('reviewQueue retries a failed notification on the next call', (t) => {
  const root = arena(t);
  writeRun(root, 'd1', '1000', ready('d1', '2026-01-01T10:00:00.000Z'));
  const calls: any[] = [];
  const spawn = fakeSpawn(calls, [
    { status: 1, stdout: '', stderr: 'boom' },
    { status: 0, stdout: '', stderr: '' },
  ]);
  reviewQueue({ cwd: root, config: { notify: { command: 'notify' } }, clock: clock(), spawn });
  const second = reviewQueue({ cwd: root, config: { notify: { command: 'notify' } }, clock: clock(), spawn });
  assert.deepEqual(second.notified, [join(deliveryDir(root), 'd1', '1000', 'result.json')]);
});
