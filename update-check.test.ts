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
import type { ModelUpdate } from './model-updates.ts';

const HOUR = 60 * 60 * 1000;

const DEEPSEEK_UPDATE: ModelUpdate = {
  profile: 'general',
  provider: 'openrouter',
  current: 'deepseek/deepseek-v4.1-flash',
  newer: ['deepseek/deepseek-v4.1-flash-1017'],
  latest: 'deepseek/deepseek-v4.1-flash-1017',
  isDefault: true,
};

const PRICEY_UPDATE: ModelUpdate = {
  ...DEEPSEEK_UPDATE,
  price: {
    from: { inputPerM: 0.033, outputPerM: 0.08, cacheReadPerM: null },
    to: { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: null },
    inputRatio: 4.55,
    outputRatio: 7.5,
    pricier: true,
  },
  comparable: false,
};

const COMPARABLE_UPDATE: ModelUpdate = {
  ...DEEPSEEK_UPDATE,
  price: {
    from: { inputPerM: 0.033, outputPerM: 0.08, cacheReadPerM: null },
    to: { inputPerM: 0.04, outputPerM: 0.09, cacheReadPerM: null },
    inputRatio: 1.21,
    outputRatio: 1.13,
    pricier: true,
  },
  comparable: true,
};

/** A model-detection seam that reports nothing, keeping tests offline. */
const NO_MODEL_UPDATES = async () => ({ catalog: null as const, updates: [] as ModelUpdate[] });

/** Offline self/tool/companion probes so only the model seam under test runs. */
const OFFLINE_PROBES = {
  checkSelf: () => ({ installed: '1.0.0', latest: '1.0.0', outdated: false, kind: 'npm-global' }),
  checkTools: async () => ({ tools: [], outdated: [] }),
  inspect: () => ({ ready: true, checkedUpdates: true, remediation: [], companions: [] }),
};

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
    models: { catalog: null, updates: [] },
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
    modelUpdates: NO_MODEL_UPDATES,
    checkSelf: () => ({ installed: '1.0.0', latest: '1.0.0', outdated: false, kind: 'npm-global' }),
    checkTools: async () => ({ tools: [], outdated: [] }),
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
    modelUpdates: NO_MODEL_UPDATES,
    checkTools: async () => ({ tools: [], outdated: [] }),
    checkSelf: () => ({ installed: '1.0.0', latest: '1.1.0', outdated: true, kind: 'source' }),
    inspect: () => ({ ready: true, checkedUpdates: true, remediation: [], companions: [] }),
  });
  assert.match(String(updates.remediation), /git pull/);
});

test('collectUpdates exposes the doctor update keys', async () => {
  const { collectUpdates } = await import('./update-check.ts');
  const updates = await collectUpdates({
    modelUpdates: NO_MODEL_UPDATES,
    checkSelf: () => ({ installed: '1.0.0', latest: '1.1.0', outdated: true, kind: 'npm-global' }),
    checkTools: async () => ({ tools: [], outdated: [] }),
    inspect: () => ({ ready: true, checkedUpdates: true, remediation: [], companions: [] }),
  });
  assert.deepEqual(Object.keys(updates).sort(), ['companions', 'junior', 'managed', 'models', 'remediation']);
});

test('collectUpdates lists the outdated managed tools', async () => {
  const { collectUpdates } = await import('./update-check.ts');
  const updates = await collectUpdates({
    modelUpdates: NO_MODEL_UPDATES,
    checkSelf: () => ({ installed: '1.0.0', latest: '1.0.0', outdated: false, kind: 'npm-global' }),
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

test('startupNotice appends local outdated entries after the cached entries', async () => {
  const fs = memoryFs();
  fs.files.set(CACHE, JSON.stringify({ checkedAt: 1_000 * HOUR, outdated: ['crossmatrix'], remediation: '' }));
  const line = await (await import('./update-check.ts')).startupNotice('validate', {
    env: {}, cachePath: CACHE, now: () => 1_000 * HOUR, fs, writeNotice: () => {},
    localOutdated: () => ['junior skill (claude, codex)'],
  });
  assert.equal(line, 'junior: 2 updates available (crossmatrix, junior skill (claude, codex)); run `junior update`');
});

test('startupNotice prints a notice when only the local entries are outdated', async () => {
  const fs = memoryFs();
  fs.files.set(CACHE, JSON.stringify({ checkedAt: 1_000 * HOUR, outdated: [], remediation: '' }));
  const line = await (await import('./update-check.ts')).startupNotice('validate', {
    env: {}, cachePath: CACHE, now: () => 1_000 * HOUR, fs, writeNotice: () => {},
    localOutdated: () => ['junior skill (claude, codex)'],
  });
  assert.equal(line, 'junior: 1 update available (junior skill (claude, codex)); run `junior update`');
});

test('startupNotice prints a notice when there is no cache but local entries are outdated', async () => {
  const fs = memoryFs();
  const line = await (await import('./update-check.ts')).startupNotice('validate', {
    env: {}, cachePath: CACHE, now: () => 100 * HOUR, fs, writeNotice: () => {},
    collect: async () => { throw new Error('offline'); },
    localOutdated: () => ['junior skill (claude, codex)'],
  });
  assert.equal(line, 'junior: 1 update available (junior skill (claude, codex)); run `junior update`');
});

test('startupNotice ignores a throwing localOutdated callback and still prints the cached notice', async () => {
  const fs = memoryFs();
  fs.files.set(CACHE, JSON.stringify({ checkedAt: 1_000 * HOUR, outdated: ['junior'], remediation: '' }));
  const line = await (await import('./update-check.ts')).startupNotice('validate', {
    env: {}, cachePath: CACHE, now: () => 1_000 * HOUR, fs, writeNotice: () => {},
    localOutdated: () => { throw new Error('skill scan failed'); },
  });
  assert.equal(line, 'junior: 1 update available (junior); run `junior update`');
});

test('startupNotice stays silent when a throwing localOutdated callback is the only source', async () => {
  const fs = memoryFs();
  fs.files.set(CACHE, JSON.stringify({ checkedAt: 1_000 * HOUR, outdated: [], remediation: '' }));
  const line = await (await import('./update-check.ts')).startupNotice('validate', {
    env: {}, cachePath: CACHE, now: () => 1_000 * HOUR, fs, writeNotice: () => {},
    localOutdated: () => { throw new Error('skill scan failed'); },
  });
  assert.equal(line, null);
});

test('startupNotice does not call localOutdated for an ineligible command', async () => {
  const fs = memoryFs();
  fs.files.set(CACHE, JSON.stringify({ checkedAt: 1_000 * HOUR, outdated: ['junior'], remediation: '' }));
  let called = false;
  await (await import('./update-check.ts')).startupNotice('handoff', {
    env: {}, cachePath: CACHE, now: () => 1_000 * HOUR, fs, writeNotice: () => {},
    localOutdated: () => { called = true; return ['junior skill (claude, codex)']; },
  });
  assert.equal(called, false);
});

test('startupNotice does not call localOutdated when JUNIOR_NO_UPDATE_CHECK is set', async () => {
  const fs = memoryFs();
  fs.files.set(CACHE, JSON.stringify({ checkedAt: 1_000 * HOUR, outdated: ['junior'], remediation: '' }));
  let called = false;
  await (await import('./update-check.ts')).startupNotice('validate', {
    env: { JUNIOR_NO_UPDATE_CHECK: '1' }, cachePath: CACHE, now: () => 1_000 * HOUR, fs, writeNotice: () => {},
    localOutdated: () => { called = true; return ['junior skill (claude, codex)']; },
  });
  assert.equal(called, false);
});

// --- model update detection -------------------------------------------------

test('collectUpdates exposes an injected model update under models.updates', async () => {
  const { collectUpdates } = await import('./update-check.ts');
  const updates = await collectUpdates({
    ...OFFLINE_PROBES,
    modelUpdates: async () => ({ catalog: 'online', updates: [DEEPSEEK_UPDATE] }),
  });
  assert.deepEqual(updates.models.updates, [DEEPSEEK_UPDATE]);
});

test('collectUpdates reports the catalog that produced the model updates', async () => {
  const { collectUpdates } = await import('./update-check.ts');
  const updates = await collectUpdates({
    ...OFFLINE_PROBES,
    modelUpdates: async () => ({ catalog: 'online', updates: [DEEPSEEK_UPDATE] }),
  });
  assert.equal(updates.models.catalog, 'online');
});

test('collectUpdates survives a throwing model detection', async () => {
  const { collectUpdates } = await import('./update-check.ts');
  const updates = await collectUpdates({
    ...OFFLINE_PROBES,
    modelUpdates: async () => { throw new Error('offline'); },
  });
  assert.deepEqual(updates.models, { catalog: null, updates: [] });
});

test('collectUpdates keeps the companion results when model detection throws', async () => {
  const { collectUpdates } = await import('./update-check.ts');
  const updates = await collectUpdates({
    ...OFFLINE_PROBES,
    modelUpdates: async () => { throw new Error('offline'); },
    inspect: () => ({
      ready: true,
      checkedUpdates: true,
      remediation: [],
      companions: [{ id: 'jevitate', package: '@jevitate/cli', installed: true, executable: null, version: '1.0.0', outdated: true, mcpRegister: '' }],
    }),
  });
  assert.deepEqual(updates.companions, ['@jevitate/cli']);
});

test('collectUpdates points remediation at junior model upgrade', async () => {
  const { collectUpdates } = await import('./update-check.ts');
  const updates = await collectUpdates({
    ...OFFLINE_PROBES,
    modelUpdates: async () => ({ catalog: 'online', updates: [DEEPSEEK_UPDATE] }),
  });
  assert.match(String(updates.remediation), /junior model upgrade/);
});

test('collectUpdates adds no model remediation when no model is newer', async () => {
  const { collectUpdates } = await import('./update-check.ts');
  const updates = await collectUpdates({
    ...OFFLINE_PROBES,
    modelUpdates: async () => ({ catalog: 'online', updates: [] }),
  });
  assert.doesNotMatch(String(updates.remediation ?? ''), /junior model upgrade/);
});

test('collectUpdates omits the model upgrade remediation when the only update is pricier', async () => {
  const { collectUpdates } = await import('./update-check.ts');
  const updates = await collectUpdates({
    ...OFFLINE_PROBES,
    modelUpdates: async () => ({ catalog: 'online', updates: [PRICEY_UPDATE] }),
  });
  assert.doesNotMatch(String(updates.remediation ?? ''), /junior model upgrade/);
});

test('collectUpdates suggests the model upgrade remediation for a comparable update', async () => {
  const { collectUpdates } = await import('./update-check.ts');
  const updates = await collectUpdates({
    ...OFFLINE_PROBES,
    modelUpdates: async () => ({ catalog: 'online', updates: [COMPARABLE_UPDATE] }),
  });
  assert.match(String(updates.remediation ?? ''), /junior model upgrade/);
});

test('cachedUpdateSummary records a model update in the outdated list', async () => {
  const fs = memoryFs();
  await (await import('./update-check.ts')).cachedUpdateSummary({
    env: {}, cachePath: CACHE, now: () => 100 * HOUR, fs,
    collect: async () => emptyUpdates({
      junior: { installed: '1.0.0', latest: '1.0.0', outdated: false, kind: 'npm-global' },
      models: { catalog: 'online', updates: [DEEPSEEK_UPDATE] },
    }),
  });
  const stored = JSON.parse(fs.files.get(CACHE) ?? 'null');
  assert.ok(stored.outdated.includes('model:deepseek/deepseek-v4.1-flash-1017'));
});

test('cachedUpdateSummary omits model entries when no model is newer', async () => {
  const fs = memoryFs();
  await (await import('./update-check.ts')).cachedUpdateSummary({
    env: {}, cachePath: CACHE, now: () => 100 * HOUR, fs,
    collect: async () => emptyUpdates({
      models: { catalog: 'online', updates: [] },
      junior: { installed: '1.0.0', latest: '1.0.0', outdated: false, kind: 'npm-global' },
    }),
  });
  const stored = JSON.parse(fs.files.get(CACHE) ?? 'null');
  assert.equal(stored.outdated.some((entry: string) => entry.startsWith('model:')), false);
});

test('cachedUpdateSummary writes a summary when only the online catalog resolved', async () => {
  const fs = memoryFs();
  const summary = await (await import('./update-check.ts')).cachedUpdateSummary({
    env: {}, cachePath: CACHE, now: () => 100 * HOUR, fs,
    collect: async () => emptyUpdates({
      junior: { installed: '1.0.0', latest: null, outdated: null, kind: 'source' },
      managed: { tools: [{ tool: 'crossmatrix', installed: null, latest: null, outdated: null }], outdated: [] },
      models: { catalog: 'online', updates: [] },
    }),
  });
  assert.notEqual(summary, null);
});

test('the cached outdated entry for a pricier newer model says waiting for price parity with its ratios', async () => {
  const fs = memoryFs();
  await (await import('./update-check.ts')).cachedUpdateSummary({
    env: {}, cachePath: CACHE, now: () => 100 * HOUR, fs,
    collect: async () => emptyUpdates({
      junior: { installed: '1.0.0', latest: '1.0.0', outdated: false, kind: 'npm-global' },
      models: { catalog: 'online', updates: [PRICEY_UPDATE] },
    }),
  });
  const stored = JSON.parse(fs.files.get(CACHE) ?? 'null');
  assert.ok(stored.outdated.includes('model:deepseek/deepseek-v4.1-flash-1017 (waiting for price parity 4.55x/7.5x)'));
});

test('the startup notice line names the price-parity wait and its ratios', async () => {
  let line: string | null = null;
  await (await import('./update-check.ts')).startupNotice('validate', {
    env: {}, cachePath: CACHE, now: () => 100 * HOUR, fs: memoryFs(), writeNotice: (text: string) => { line = text; },
    collect: async () => emptyUpdates({
      junior: { installed: '1.0.0', latest: '1.0.0', outdated: false, kind: 'npm-global' },
      models: { catalog: 'online', updates: [PRICEY_UPDATE] },
    }),
  });
  assert.match(String(line), /waiting for price parity 4\.55x\/7\.5x/);
});

test('the cached outdated entry for a comparable newer model says price-comparable', async () => {
  const fs = memoryFs();
  await (await import('./update-check.ts')).cachedUpdateSummary({
    env: {}, cachePath: CACHE, now: () => 100 * HOUR, fs,
    collect: async () => emptyUpdates({
      junior: { installed: '1.0.0', latest: '1.0.0', outdated: false, kind: 'npm-global' },
      models: { catalog: 'online', updates: [COMPARABLE_UPDATE] },
    }),
  });
  const stored = JSON.parse(fs.files.get(CACHE) ?? 'null');
  assert.ok(stored.outdated.includes('model:deepseek/deepseek-v4.1-flash-1017 (price-comparable)'));
});

test('startupNotice names the model update in its one line', async () => {
  const fs = memoryFs();
  fs.files.set(CACHE, JSON.stringify({ checkedAt: 1_000 * HOUR, outdated: ['model:deepseek/deepseek-v4.1-flash-1017'], remediation: '' }));
  const line = await (await import('./update-check.ts')).startupNotice('validate', {
    env: {}, cachePath: CACHE, now: () => 1_000 * HOUR, fs, writeNotice: () => {},
  });
  assert.match(String(line), /model:deepseek\/deepseek-v4\.1-flash-1017/);
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
