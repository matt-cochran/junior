// ---------------------------------------------------------------------------
// Focused behavioral tests for the startup update check and its 24h cache.
//
// Every scenario drives the public `update-check.ts` surface with injected
// dependencies (in-memory fs, fixed clock, stubbed collector/probes), so no
// test touches the network, the real `~/.junior`, or a spawned process.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { UpdateCheckDeps, UpdateCheckFs, CollectedUpdates } from './update-check.ts';

const HOUR = 60 * 60 * 1000;

function memoryFs(): UpdateCheckFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFileSync: (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return value;
    },
    writeFileSync: (path: string, data: string) => { files.set(path, data); },
    mkdirSync: () => { /* directories are implied by the file map */ },
    renameSync: (from: string, to: string) => {
      const value = files.get(from);
      if (value === undefined) throw new Error('ENOENT');
      files.set(to, value);
      files.delete(from);
    },
    existsSync: (path: string) => files.has(path),
    unlinkSync: (path: string) => { files.delete(path); },
  };
}

const CACHE = '/home/user/.junior/update-check.json';

function emptyUpdates(overrides: Partial<CollectedUpdates> = {}): CollectedUpdates {
  return {
    junior: { installed: '1.0.0', latest: '1.1.0', outdated: true, kind: 'npm-global' },
    managed: { tools: [], outdated: [] },
    companions: [],
    ...overrides,
  };
}

function deps(partial: Partial<UpdateCheckDeps> = {}): UpdateCheckDeps {
  return { env: {}, cachePath: CACHE, now: () => Date.now(), fs: memoryFs(), ...partial };
}

// --- collectUpdates ---------------------------------------------------------

test('collectUpdates reports the outdated companion packages', async () => {
  const { collectUpdates } = await import('./update-check.ts');
  const updates = await collectUpdates({
    inspect: () => ({
      ready: true,
      checkedUpdates: true,
      remediation: [],
      companions: [
        { id: 'crossmatrix', package: '@matthew-cochran/crossmatrix', installed: true, executable: null, version: '1.0.0', outdated: false, mcpRegister: '' },
        { id: 'jevitate', package: '@jevitate/cli', installed: true, executable: null, version: '1.0.0', outdated: true, mcpRegister: '' },
      ],
    }),
  });
  assert.deepEqual(updates.companions, ['@jevitate/cli']);
});

test('collectUpdates describes the source-checkout remediation', async () => {
  const { collectUpdates } = await import('./update-check.ts');
  const updates = await collectUpdates({
    checkSelf: () => ({ installed: '1.0.0', latest: '1.1.0', outdated: true, kind: 'source' }),
    inspect: () => ({ ready: true, checkedUpdates: true, remediation: [], companions: [] }),
  });
  assert.match(String(updates.remediation), /git pull/);
});

test('collectUpdates exposes the doctor update keys', async () => {
  const { collectUpdates } = await import('./update-check.ts');
  const updates = await collectUpdates({
    checkSelf: () => ({ installed: '1.0.0', latest: '1.1.0', outdated: true, kind: 'npm-global' }),
    checkTools: async () => ({ tools: [], outdated: [] }),
    inspect: () => ({ ready: true, checkedUpdates: true, remediation: [], companions: [] }),
  });
  assert.deepEqual(Object.keys(updates).sort(), ['companions', 'junior', 'managed', 'remediation']);
});

test('collectUpdates lists the outdated managed tools', async () => {
  const { collectUpdates } = await import('./update-check.ts');
  const updates = await collectUpdates({
    checkTools: async () => ({ tools: [], outdated: ['crossmatrix'] }),
    inspect: () => ({ ready: true, checkedUpdates: true, remediation: [], companions: [] }),
  });
  assert.deepEqual(updates.managed.outdated, ['crossmatrix']);
});

// --- cachedUpdateSummary ----------------------------------------------------

test('cachedUpdateSummary uses a fresh cache without collecting', async () => {
  const now = 1_000 * HOUR;
  const fs = memoryFs();
  fs.files.set(CACHE, JSON.stringify({ checkedAt: now - HOUR, outdated: ['junior'], remediation: undefined }));
  let collected = 0;
  const summary = await (await import('./update-check.ts')).cachedUpdateSummary({
    env: {}, cachePath: CACHE, now: () => now, fs,
    collect: async () => { collected++; return emptyUpdates(); },
  });
  assert.equal(collected, 0);
});

test('cachedUpdateSummary refreshes a stale cache', async () => {
  const now = 100 * HOUR;
  const fs = memoryFs();
  fs.files.set(CACHE, JSON.stringify({ checkedAt: now - 25 * HOUR, outdated: ['junior'], remediation: '' }));
  const summary = await (await import('./update-check.ts')).cachedUpdateSummary({
    env: {}, cachePath: CACHE, now: () => now, fs,
    collect: async () => emptyUpdates({ companions: ['@jevitate/cli'], junior: { installed: '1.0.0', latest: '1.1.0', outdated: false, kind: 'npm-global' } }),
  });
  assert.deepEqual(summary?.outdated, ['@jevitate/cli']);
});

test('cachedUpdateSummary writes the refreshed summary to the cache', async () => {
  const now = 100 * HOUR;
  const fs = memoryFs();
  await (await import('./update-check.ts')).cachedUpdateSummary({
    env: {}, cachePath: CACHE, now: () => now, fs,
    collect: async () => emptyUpdates({ junior: { installed: '1.0.0', latest: '1.1.0', outdated: false, kind: 'npm-global' }, companions: ['crossmatrix'] }),
  });
  const stored = JSON.parse(fs.files.get(CACHE) ?? 'null');
  assert.deepEqual(stored.outdated, ['crossmatrix']);
});

test('cachedUpdateSummary returns null when the refresh fails', async () => {
  const fs = memoryFs();
  const summary = await (await import('./update-check.ts')).cachedUpdateSummary({
    env: {}, cachePath: CACHE, now: () => 100 * HOUR, fs,
    collect: async () => { throw new Error('offline'); },
  });
  assert.equal(summary, null);
});

test('cachedUpdateSummary keeps the previous cache when the refresh fails', async () => {
  const fs = memoryFs();
  const previous = JSON.stringify({ checkedAt: 1, outdated: ['junior'], remediation: '' });
  fs.files.set(CACHE, previous);
  await (await import('./update-check.ts')).cachedUpdateSummary({
    env: {}, cachePath: CACHE, now: () => 100 * HOUR, fs,
    collect: async () => { throw new Error('offline'); },
  });
  assert.equal(fs.files.get(CACHE), previous);
});

test('cachedUpdateSummary withholds a summary when no probe resolved', async () => {
  const fs = memoryFs();
  const summary = await (await import('./update-check.ts')).cachedUpdateSummary({
    env: {}, cachePath: CACHE, now: () => 100 * HOUR, fs,
    collect: async () => emptyUpdates({
      junior: { installed: '1.0.0', latest: null, outdated: null, kind: 'source' },
      managed: { tools: [{ tool: 'crossmatrix', installed: null, latest: null, outdated: null }], outdated: [] },
    }),
  });
  assert.equal(summary, null);
});

// --- refreshUpdateCache -----------------------------------------------------

test('refreshUpdateCache stops listing a component that was just updated', async () => {
  const fs = memoryFs();
  fs.files.set(CACHE, JSON.stringify({ checkedAt: 1, outdated: ['junior', 'crossmatrix'], remediation: '' }));
  await (await import('./update-check.ts')).refreshUpdateCache({
    env: {}, cachePath: CACHE, now: () => 100 * HOUR, fs,
    collect: async () => emptyUpdates({ junior: { installed: '1.0.0', latest: '1.0.0', outdated: false, kind: 'npm-global' } }),
  });
  const stored = JSON.parse(fs.files.get(CACHE) ?? 'null');
  assert.deepEqual(stored.outdated, []);
});

test('refreshUpdateCache never rejects when the cache write fails', async () => {
  const fs = memoryFs();
  fs.writeFileSync = () => { throw new Error('read-only cache'); };
  await assert.doesNotReject((await import('./update-check.ts')).refreshUpdateCache({
    env: {}, cachePath: CACHE, now: () => 100 * HOUR, fs,
    collect: async () => emptyUpdates(),
  }));
});

test('refreshUpdateCache removes the stale summary when the refresh fails', async () => {
  const fs = memoryFs();
  fs.files.set(CACHE, JSON.stringify({ checkedAt: 1, outdated: ['junior'], remediation: '' }));
  await (await import('./update-check.ts')).refreshUpdateCache({
    env: {}, cachePath: CACHE, now: () => 100 * HOUR, fs,
    collect: async () => { throw new Error('offline'); },
  });
  assert.equal(fs.files.has(CACHE), false);
});

// --- startupNotice ----------------------------------------------------------

test('startupNotice prints the one-line notice for validate', async () => {
  const fs = memoryFs();
  fs.files.set(CACHE, JSON.stringify({ checkedAt: 1_000 * HOUR, outdated: ['crossmatrix', '@jevitate/cli'], remediation: '' }));
  const line = await (await import('./update-check.ts')).startupNotice('validate', {
    env: {}, cachePath: CACHE, now: () => 1_000 * HOUR, fs, writeNotice: () => {},
  });
  assert.equal(line, 'junior: 2 updates available (crossmatrix, @jevitate/cli); run `junior update`');
});

test('startupNotice writes the notice through the injected writer', async () => {
  const fs = memoryFs();
  fs.files.set(CACHE, JSON.stringify({ checkedAt: 1_000 * HOUR, outdated: ['junior'], remediation: '' }));
  const written: string[] = [];
  await (await import('./update-check.ts')).startupNotice('validate', {
    env: {}, cachePath: CACHE, now: () => 1_000 * HOUR, fs, writeNotice: (line) => written.push(line),
  });
  assert.deepEqual(written, ['junior: 1 update available (junior); run `junior update`']);
});

test('startupNotice stays silent for handoff', async () => {
  const fs = memoryFs();
  fs.files.set(CACHE, JSON.stringify({ checkedAt: 1_000 * HOUR, outdated: ['junior'], remediation: '' }));
  const line = await (await import('./update-check.ts')).startupNotice('handoff', {
    env: {}, cachePath: CACHE, now: () => 1_000 * HOUR, fs, writeNotice: () => {},
  });
  assert.equal(line, null);
});

test('startupNotice is suppressed by JUNIOR_NO_UPDATE_CHECK', async () => {
  const fs = memoryFs();
  fs.files.set(CACHE, JSON.stringify({ checkedAt: 1_000 * HOUR, outdated: ['junior'], remediation: '' }));
  const line = await (await import('./update-check.ts')).startupNotice('validate', {
    env: { JUNIOR_NO_UPDATE_CHECK: '1' }, cachePath: CACHE, now: () => 1_000 * HOUR, fs, writeNotice: () => {},
  });
  assert.equal(line, null);
});

test('startupNotice stays silent for doctor --check-updates', async () => {
  const fs = memoryFs();
  fs.files.set(CACHE, JSON.stringify({ checkedAt: 1_000 * HOUR, outdated: ['junior'], remediation: '' }));
  const line = await (await import('./update-check.ts')).startupNotice('doctor', {
    env: {}, cachePath: CACHE, now: () => 1_000 * HOUR, fs, writeNotice: () => {}, checkUpdates: true,
  });
  assert.equal(line, null);
});

test('startupNotice returns null when nothing is outdated', async () => {
  const fs = memoryFs();
  fs.files.set(CACHE, JSON.stringify({ checkedAt: 1_000 * HOUR, outdated: [], remediation: '' }));
  const line = await (await import('./update-check.ts')).startupNotice('validate', {
    env: {}, cachePath: CACHE, now: () => 1_000 * HOUR, fs, writeNotice: () => {},
  });
  assert.equal(line, null);
});

test('startupNotice resolves without throwing when the refresh fails', async () => {
  const fs = memoryFs();
  const promise = (await import('./update-check.ts')).startupNotice('validate', {
    env: {}, cachePath: CACHE, now: () => 100 * HOUR, fs, writeNotice: () => {},
    collect: async () => { throw new Error('offline'); },
  });
  await assert.doesNotReject(promise);
});

// --- cache path convention --------------------------------------------------

test('cachedUpdateSummary derives the cache path from JUNIOR_TOOLS_ROOT', async () => {
  const fs = memoryFs();
  await (await import('./update-check.ts')).cachedUpdateSummary({
    env: { JUNIOR_TOOLS_ROOT: '/root/.junior/tools' }, now: () => 100 * HOUR, fs,
    collect: async () => emptyUpdates(),
  });
  assert.ok(fs.files.has('/root/.junior/update-check.json'));
});
