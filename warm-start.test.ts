// ---------------------------------------------------------------------------
// Behavioral tests for warm-start provisioning (#278, lane W1).
//
// Every scenario builds a disposable source/cache fixture under os.tmpdir() and
// drives the public validateWarmFrom / warmStart APIs. Each test asserts exactly
// one observable outcome: a copied file, a skipped symlink, a reported metric or
// a cold-start reason. No production clock or real home directory is read.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManualClock } from './clock.ts';
import { validateWarmFrom, warmStart } from './warm-start.ts';

const arena = (t: any): string => {
  const dir = mkdtempSync(join(tmpdir(), 'junior-warm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const fixture = (t: any) => {
  const root = arena(t);
  const source = join(root, 'source');
  const worktree = join(root, 'worktree');
  mkdirSync(source, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  return { root, source, worktree };
};

const write = (path: string, content: string): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};

const opts = (source: string, worktree: string, extra: any = {}) => ({
  sourceCwd: source,
  worktree,
  deadlineAt: Number.MAX_SAFE_INTEGER,
  ...extra,
});

// --- validation --------------------------------------------------------------

test('validateWarmFrom accepts a path and the default include', () => {
  assert.doesNotThrow(() => validateWarmFrom({ path: 'prebuilt' }));
});

test('validateWarmFrom rejects an unknown key', () => {
  assert.throws(() => validateWarmFrom({ path: 'prebuilt', exclude: [], extra: true }), /Unknown warmFrom field/);
});

test('validateWarmFrom rejects an absolute include glob', () => {
  assert.throws(() => validateWarmFrom({ path: 'prebuilt', include: ['/src/**/obj/'] }), /relative glob/);
});

test('validateWarmFrom rejects an escaping exclude glob', () => {
  assert.throws(() => validateWarmFrom({ path: 'prebuilt', exclude: ['../outside/**'] }), /relative glob/);
});

test('validateWarmFrom rejects an empty path', () => {
  assert.throws(() => validateWarmFrom({ path: '   ' }), /path/);
});

// --- validation: whitespace and arrays --------------------------------------

test('validateWarmFrom rejects an include glob with leading whitespace', () => {
  assert.throws(() => validateWarmFrom({ path: 'prebuilt', include: [' **/obj/'] }), /relative glob/);
});

test('validateWarmFrom rejects an exclude glob with trailing whitespace', () => {
  assert.throws(() => validateWarmFrom({ path: 'prebuilt', exclude: ['**/obj/ '] }), /relative glob/);
});

test('validateWarmFrom rejects a non-array include', () => {
  assert.throws(() => validateWarmFrom({ path: 'prebuilt', include: '**/obj/' }), /Invalid warmFrom.include/);
});

// --- copying ----------------------------------------------------------------

test('warmStart copies an obj cache file into the worktree', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'src', 'App', 'obj', 'cache.bin'), 'cache\n');
  warmStart({ path: source }, opts(source, worktree));
  assert.equal(readFileSync(join(worktree, 'src', 'App', 'obj', 'cache.bin'), 'utf8'), 'cache\n');
});

test('warmStart leaves an excluded cache directory out of the worktree', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'src', 'App', 'obj', 'cache.bin'), 'cache\n');
  write(join(source, 'src', 'App', 'obj', 'Debug', 'debug.bin'), 'debug\n');
  warmStart({ path: source, exclude: ['**/obj/Debug/'] }, opts(source, worktree));
  assert.equal(existsSync(join(worktree, 'src', 'App', 'obj', 'Debug', 'debug.bin')), false);
});

test('warmStart does not copy bin unless it is included', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'src', 'App', 'bin', 'app.dll'), 'binary\n');
  warmStart({ path: source }, opts(source, worktree));
  assert.equal(existsSync(join(worktree, 'src', 'App', 'bin', 'app.dll')), false);
});

test('warmStart copies bin when it is included', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'src', 'App', 'bin', 'app.dll'), 'binary\n');
  warmStart({ path: source, include: ['**/obj/', '**/bin/'] }, opts(source, worktree));
  assert.equal(readFileSync(join(worktree, 'src', 'App', 'bin', 'app.dll'), 'utf8'), 'binary\n');
});

test('warmStart does not recreate a symlink found in the source', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'src', 'App', 'obj', 'cache.bin'), 'cache\n');
  symlinkSync('cache.bin', join(source, 'src', 'App', 'obj', 'cache-link'));
  warmStart({ path: source }, opts(source, worktree));
  assert.equal(existsSync(join(worktree, 'src', 'App', 'obj', 'cache-link')), false);
});

test('warmStart creates a real directory, never a symlink', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'src', 'App', 'obj', 'cache.bin'), 'cache\n');
  warmStart({ path: source }, opts(source, worktree));
  assert.equal(lstatSync(join(worktree, 'src', 'App', 'obj')).isSymbolicLink(), false);
});

// --- copy and discovery failures --------------------------------------------

test('warmStart reports a copy error without throwing', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'src', 'App', 'obj', 'cache.bin'), 'cache\n');
  writeFileSync(join(worktree, 'src'), 'not a directory\n');
  const result = warmStart({ path: source }, opts(source, worktree));
  assert.match(result.reason ?? '', /could not copy/);
});

test('warmStart reports a warmFrom path that is a file', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'prebuilt'), 'not a tree\n');
  const result = warmStart({ path: 'prebuilt' }, opts(source, worktree));
  assert.match(result.reason ?? '', /not a directory/);
});

test('warmStart keeps copying other obj directories after an unreadable one', (t) => {
  const { source, worktree } = fixture(t);
  const bad = join(source, 'src', 'Bad', 'obj');
  write(join(source, 'src', 'Good', 'obj', 'cache.bin'), 'good\n');
  mkdirSync(bad, { recursive: true });
  chmodSync(bad, 0o000);
  try {
    warmStart({ path: source }, opts(source, worktree));
  } finally {
    chmodSync(bad, 0o755);
  }
  assert.equal(existsSync(join(worktree, 'src', 'Good', 'obj', 'cache.bin')), true);
});

test('warmStart names an unreadable subdirectory in its reason', (t) => {
  const { source, worktree } = fixture(t);
  const bad = join(source, 'src', 'Bad');
  write(join(source, 'src', 'Good', 'obj', 'cache.bin'), 'good\n');
  mkdirSync(bad, { recursive: true });
  chmodSync(bad, 0o000);
  let result;
  try {
    result = warmStart({ path: source }, opts(source, worktree));
  } finally {
    chmodSync(bad, 0o755);
  }
  assert.match(result.reason ?? '', /Bad/);
});

test('warmStart copies other obj directories after skipping an unreadable one', (t) => {
  const { source, worktree } = fixture(t);
  const bad = join(source, 'src', 'Bad');
  write(join(source, 'src', 'Good', 'obj', 'cache.bin'), 'good\n');
  mkdirSync(bad, { recursive: true });
  chmodSync(bad, 0o000);
  try {
    warmStart({ path: source }, opts(source, worktree));
  } finally {
    chmodSync(bad, 0o755);
  }
  assert.equal(readFileSync(join(worktree, 'src', 'Good', 'obj', 'cache.bin'), 'utf8'), 'good\n');
});

// --- target symlinks --------------------------------------------------------

test('warmStart never copies through a symlinked target parent', (t) => {
  const { root, source, worktree } = fixture(t);
  const outside = join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  write(join(source, 'src', 'App', 'obj', 'cache.bin'), 'cache\n');
  mkdirSync(join(worktree, 'src'), { recursive: true });
  symlinkSync(outside, join(worktree, 'src', 'App'));
  warmStart({ path: source }, opts(source, worktree));
  assert.equal(existsSync(join(outside, 'obj', 'cache.bin')), false);
});

test('warmStart explains a skipped symlinked target parent', (t) => {
  const { root, source, worktree } = fixture(t);
  const outside = join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  write(join(source, 'src', 'App', 'obj', 'cache.bin'), 'cache\n');
  mkdirSync(join(worktree, 'src'), { recursive: true });
  symlinkSync(outside, join(worktree, 'src', 'App'));
  const result = warmStart({ path: source }, opts(source, worktree));
  assert.match(result.reason ?? '', /symlink/);
});

// --- deadlines --------------------------------------------------------------

test('warmStart reports a deadline reached during discovery', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'src', 'App', 'obj', 'cache.bin'), 'cache\n');
  const clock = createManualClock(0);
  let now = 0;
  clock.now = () => {
    now += 10;
    return now;
  };
  const result = warmStart({ path: source }, opts(source, worktree, { clock, deadlineAt: 25 }));
  assert.match(result.reason ?? '', /deadline/);
});

const midCopyRun = (t: any) => {
  const { source, worktree } = fixture(t);
  const cache = join(source, 'src', 'App', 'obj');
  for (let index = 0; index < 5; index += 1) write(join(cache, `${index}.bin`), `cache-${index}\n`);
  const clock = createManualClock(0);
  const realNow = clock.now.bind(clock);
  let copying = false;
  const copyFile = () => {
    copying = true;
  };
  clock.now = () => {
    const value = realNow();
    if (!copying) return value;
    const advanced = value + 300;
    clock.set(advanced);
    return advanced;
  };
  const result = warmStart({ path: source }, opts(source, worktree, { clock, deadlineAt: 1_000, copyFile }));
  return { source, worktree, result };
};

const copiedFileCount = (worktree: string): number => {
  const target = join(worktree, 'src', 'App', 'obj');
  return existsSync(target) ? readdirSync(target).filter((name) => name.endsWith('.bin')).length : 0;
};

test('warmStart stops copying when the deadline passes mid-directory', (t) => {
  const { worktree } = midCopyRun(t);
  assert.ok(copiedFileCount(worktree) < 5);
});

test('warmStart keeps files copied before the deadline passed mid-directory', (t) => {
  const { worktree } = midCopyRun(t);
  assert.ok(copiedFileCount(worktree) > 0);
});

test('warmStart reports a deadline reached mid-copy', (t) => {
  const { result } = midCopyRun(t);
  assert.match(result.reason ?? '', /deadline/);
});

test('warmStart stays warm when the deadline passes after a file was copied', (t) => {
  const { result } = midCopyRun(t);
  assert.equal(result.warm, true);
});

// --- cold starts ------------------------------------------------------------

test('warmStart reports a missing source as cold', (t) => {
  const { source, worktree } = fixture(t);
  const result = warmStart({ path: join(source, 'missing') }, opts(source, worktree));
  assert.equal(result.warm, false);
});

test('warmStart explains a missing source', (t) => {
  const { source, worktree } = fixture(t);
  const result = warmStart({ path: join(source, 'missing') }, opts(source, worktree));
  assert.match(result.reason ?? '', /does not exist/);
});

test('warmStart reports no matching directories as cold', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'src', 'App', 'source.cs'), 'class App {}\n');
  const result = warmStart({ path: source }, opts(source, worktree));
  assert.equal(result.warm, false);
});

test('warmStart stops before copying when the deadline has passed', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'src', 'App', 'obj', 'cache.bin'), 'cache\n');
  const clock = createManualClock(1_000);
  warmStart({ path: source }, opts(source, worktree, { clock, deadlineAt: 1_000 }));
  assert.equal(existsSync(join(worktree, 'src', 'App', 'obj', 'cache.bin')), false);
});

test('warmStart explains a passed deadline', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'src', 'App', 'obj', 'cache.bin'), 'cache\n');
  const clock = createManualClock(1_000);
  const result = warmStart({ path: source }, opts(source, worktree, { clock, deadlineAt: 1_000 }));
  assert.match(result.reason ?? '', /deadline/);
});

// --- copy method ------------------------------------------------------------

test('warmStart reports reflink when the first-file probe succeeds', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'src', 'App', 'obj', 'cache.bin'), 'cache\n');
  const copyFile = () => {};
  const result = warmStart({ path: source }, opts(source, worktree, { copyFile }));
  assert.equal(result.method, 'reflink');
});

// --- reporting --------------------------------------------------------------

test('warmStart reports a warm run', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'src', 'App', 'obj', 'cache.bin'), 'cache\n');
  assert.equal(warmStart({ path: source }, opts(source, worktree)).warm, true);
});

test('warmStart reports a copy method', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'src', 'App', 'obj', 'cache.bin'), 'cache\n');
  assert.match(warmStart({ path: source }, opts(source, worktree)).method ?? '', /^(reflink|copy)$/);
});

test('warmStart counts the copied file', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'src', 'App', 'obj', 'cache.bin'), 'cache\n');
  assert.equal(warmStart({ path: source }, opts(source, worktree)).files, 1);
});

test('warmStart counts the copied bytes', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'src', 'App', 'obj', 'cache.bin'), 'cache\n');
  assert.equal(warmStart({ path: source }, opts(source, worktree)).bytes, 6);
});

test('warmStart reports the copied directory', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'src', 'App', 'obj', 'cache.bin'), 'cache\n');
  assert.deepEqual(warmStart({ path: source }, opts(source, worktree)).dirs, ['src/App/obj']);
});

test('warmStart reads elapsed time from the injected clock', (t) => {
  const { source, worktree } = fixture(t);
  write(join(source, 'src', 'App', 'obj', 'cache.bin'), 'cache\n');
  const clock = createManualClock(1_000);
  assert.equal(warmStart({ path: source }, opts(source, worktree, { clock, deadlineAt: 10_000 })).durationMs, 0);
});