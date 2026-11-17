import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createManualClock, systemClock } from './clock.ts';

// --- guard: production code reads time only through the clock (#265) --------

const ROOT = import.meta.dirname;
const CLOCK_MODULE = 'clock.ts';
const SKIPPED_DIRS = new Set(['node_modules', 'dist']);
const TIMING_CALLS: Array<[string, RegExp]> = [
  ['Date.now()', /\bDate\.now\s*\(/],
  ['new Date()', /\bnew\s+Date\s*\(\s*\)/],
  ['performance.now()', /\bperformance\.now\s*\(/],
  ['a global timer', /(?<![.\w$])(?:setTimeout|setInterval|clearTimeout|clearInterval)\s*\(/],
];

function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) productionSources(join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Blank out comments so prose that names an API is not mistaken for a call. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

test('no production module reads the time or schedules a timer outside the clock', () => {
  const offenders: string[] = [];
  for (const file of productionSources(ROOT)) {
    const rel = relative(ROOT, file);
    if (rel === CLOCK_MODULE) continue;
    const lines = withoutComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      for (const [name, pattern] of TIMING_CALLS) {
        if (pattern.test(line)) offenders.push(`${rel}:${index + 1} uses ${name}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});

test('the timing guard recognises each direct call it forbids', () => {
  const samples = ['Date.now()', 'new Date()', 'performance.now()', 'setTimeout(f, 1)', 'clearInterval(t)'];
  assert.deepEqual(samples.map((s) => TIMING_CALLS.some(([, p]) => p.test(s))), [true, true, true, true, true]);
});

test('the timing guard allows clock methods, parsed dates and comments', () => {
  const allowed = ['clock.setTimeout(f, 1)', 'deps.clock.clearTimeout(t)', "new Date('2026-01-01')", 'new Date(ms)'];
  assert.deepEqual(allowed.map((s) => TIMING_CALLS.some(([, p]) => p.test(s))), [false, false, false, false]);
  assert.equal(withoutComments('x(); // Date.now() here').includes('Date.now'), false);
});

test('a manual clock reports the time it was started at', () => {
  const clock = createManualClock('2026-11-17T00:00:00.000Z');
  assert.equal(clock.iso(), '2026-11-17T00:00:00.000Z');
});

test('a manual clock does not move until advanced', () => {
  const clock = createManualClock(1_000);
  clock.setTimeout(() => {}, 10);
  assert.equal(clock.now(), 1_000);
});

test('advance runs a timer that falls due', () => {
  const clock = createManualClock(0);
  let fired = false;
  clock.setTimeout(() => { fired = true; }, 50);
  clock.advance(50);
  assert.equal(fired, true);
});

test('advance leaves a timer that is not yet due', () => {
  const clock = createManualClock(0);
  let fired = false;
  clock.setTimeout(() => { fired = true; }, 50);
  clock.advance(49);
  assert.equal(fired, false);
});

test('timers fire in due order, ties in scheduling order', () => {
  const clock = createManualClock(0);
  const order: string[] = [];
  clock.setTimeout(() => order.push('b'), 20);
  clock.setTimeout(() => order.push('a'), 10);
  clock.setTimeout(() => order.push('c'), 20);
  clock.advance(30);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('a timer callback observes its own due time', () => {
  const clock = createManualClock(0);
  let seen = -1;
  clock.setTimeout(() => { seen = clock.now(); }, 25);
  clock.advance(100);
  assert.equal(seen, 25);
});

test('a cleared timer never fires', () => {
  const clock = createManualClock(0);
  let fired = false;
  const timer = clock.setTimeout(() => { fired = true; }, 5);
  clock.clearTimeout(timer);
  clock.advance(10);
  assert.equal(fired, false);
});

test('an interval fires once per period', () => {
  const clock = createManualClock(0);
  let count = 0;
  clock.setInterval(() => { count += 1; }, 10);
  clock.advance(35);
  assert.equal(count, 3);
});

test('a timer scheduled by a firing timer runs in the same advance when due', () => {
  const clock = createManualClock(0);
  let inner = false;
  clock.setTimeout(() => clock.setTimeout(() => { inner = true; }, 5), 5);
  clock.advance(10);
  assert.equal(inner, true);
});

test('advanceAsync lets async code chained on a timer settle', async () => {
  const clock = createManualClock(0);
  let done = false;
  void clock.sleep(100).then(async () => { await Promise.resolve(); done = true; });
  await clock.advanceAsync(100);
  assert.equal(done, true);
});

test('sleep rejects with the abort reason when its signal aborts', async () => {
  const clock = createManualClock(0);
  const controller = new AbortController();
  const slept = clock.sleep(1_000, controller.signal);
  controller.abort(new Error('stop'));
  await assert.rejects(slept, /stop/);
});

test('an aborted sleep leaves no pending timer', async () => {
  const clock = createManualClock(0);
  const controller = new AbortController();
  const slept = clock.sleep(1_000, controller.signal).catch(() => {});
  controller.abort();
  await slept;
  assert.equal(clock.pending(), 0);
});

test('runAll drains timers and reports how many fired', async () => {
  const clock = createManualClock(0);
  clock.setTimeout(() => {}, 5);
  clock.setTimeout(() => {}, 500);
  assert.equal(await clock.runAll(), 2);
});

test('the system clock reads the current time', () => {
  const before = Date.now();
  const now = systemClock.now();
  assert.ok(now >= before && now <= Date.now());
});

test('a system clock timer can be cleared before it fires', () => {
  let fired = false;
  const timer = systemClock.setTimeout(() => { fired = true; }, 0).unref();
  systemClock.clearTimeout(timer);
  return new Promise<void>((resolve) => setImmediate(() => { assert.equal(fired, false); resolve(); }));
});
