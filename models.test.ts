// Behavioral tests for model-id lineage parsing and catalog reads.
//
// Every scenario is offline and deterministic: online catalog reads always go
// through an injected `fetch`, and local catalog reads through an injected fs.
// Each test asserts exactly one observable outcome through the module's public
// API.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  OPENROUTER_MODELS_URL,
  compareModelIds,
  fetchOnlineCatalog,
  newerInLineage,
  parseModelId,
  readLocalCatalog,
  type CatalogFetch,
} from './models.ts';

// --- parseModelId ----------------------------------------------------------

test('parseModelId returns null when the id has no vendor separator', () => {
  assert.equal(parseModelId('deepseek-chat'), null);
});

test('parseModelId marks a leading tilde as an alias', () => {
  assert.equal(parseModelId('~deepseek/deepseek-flash-latest')?.alias, true);
});

test('parseModelId extracts the variant after the colon', () => {
  assert.equal(parseModelId('deepseek/deepseek-v4.1-flash:batch')?.variant, 'batch');
});

test('parseModelId extracts a four-digit snapshot', () => {
  assert.equal(parseModelId('deepseek/deepseek-v4.1-flash-1017')?.snapshot, '1017');
});

test('parseModelId normalizes a dashed date snapshot to digits', () => {
  assert.equal(parseModelId('qwen/qwen-plus-2025-07-28')?.snapshot, '20250728');
});

test('parseModelId parses a version with a leading prefix letter', () => {
  assert.deepEqual(parseModelId('kimi/kimi-k2.6')?.version, [2, 6]);
});

test('parseModelId keeps a single prefix letter in the family', () => {
  assert.equal(parseModelId('deepseek/deepseek-v4.1-flash')?.family, 'deepseek-v');
});

test('parseModelId treats a letter glued before the version as the family', () => {
  assert.equal(parseModelId('qwen/qwen3.6-flash')?.family, 'qwen');
});

test('parseModelId extracts the tier after the version', () => {
  assert.equal(parseModelId('deepseek/deepseek-v4.1-flash')?.tier, 'flash');
});

test('parseModelId keeps letters glued after the version in the tier', () => {
  assert.equal(parseModelId('z-ai/glm-5v-turbo')?.tier, 'v-turbo');
});

test('parseModelId flags an unstable tier', () => {
  assert.equal(parseModelId('deepseek/deepseek-v4-flash-vision-exp')?.unstable, true);
});

test('parseModelId parses an id with no numeric version with an empty version', () => {
  assert.deepEqual(parseModelId('deepseek/deepseek-chat')?.version, []);
});

test('parseModelId builds the lineage from vendor family and tier', () => {
  assert.equal(parseModelId('deepseek/deepseek-v4.1-flash')?.lineage, 'deepseek/deepseek-v|flash');
});

test('parseModelId gives qwen-plus a lineage distinct from qwen3.6-plus', () => {
  assert.notEqual(
    parseModelId('qwen/qwen-plus-2025-07-28')?.lineage,
    parseModelId('qwen/qwen3.6-plus')?.lineage,
  );
});

// --- compareModelIds -------------------------------------------------------

test('compareModelIds orders a missing version part as zero', () => {
  assert.ok(compareModelIds(parseModelId('x/y-4')!, parseModelId('x/y-4.1')!) < 0);
});

test('compareModelIds treats a missing snapshot as older than a present one', () => {
  assert.ok(compareModelIds(parseModelId('x/y-4.1')!, parseModelId('x/y-4.1-1017')!) < 0);
});

test('compareModelIds compares snapshots as digit strings', () => {
  assert.ok(compareModelIds(parseModelId('x/y-4.1-1017')!, parseModelId('x/y-4.1-0731')!) > 0);
});

// --- newerInLineage --------------------------------------------------------

test('newerInLineage returns same-lineage releases newest first for deepseek', () => {
  assert.deepEqual(
    newerInLineage('deepseek/deepseek-v4.1-flash', [
      'deepseek/deepseek-v4.1-flash-1017',
      'deepseek/deepseek-v4-flash-0731',
      'deepseek/deepseek-v4.1-flash:batch',
      '~deepseek/deepseek-flash-latest',
      'deepseek/deepseek-v4-pro-0813',
      'deepseek/deepseek-v5-flash',
    ]),
    ['deepseek/deepseek-v5-flash', 'deepseek/deepseek-v4.1-flash-1017'],
  );
});

test('newerInLineage ignores a different tier for kimi', () => {
  assert.deepEqual(
    newerInLineage('moonshotai/kimi-k2.6', [
      'moonshotai/kimi-k3',
      'moonshotai/kimi-k2.7-code',
      'moonshotai/kimi-k2-0905',
    ]),
    ['moonshotai/kimi-k3'],
  );
});

test('newerInLineage ignores a different tier for glm', () => {
  assert.deepEqual(
    newerInLineage('z-ai/glm-5.2', ['z-ai/glm-5.3', 'z-ai/glm-5.3-flash', 'z-ai/glm-4.7']),
    ['z-ai/glm-5.3'],
  );
});

test('newerInLineage excludes alias ids', () => {
  assert.deepEqual(newerInLineage('deepseek/deepseek-v4-flash', ['~deepseek/deepseek-v5-flash']), []);
});

test('newerInLineage excludes variant ids', () => {
  assert.deepEqual(newerInLineage('deepseek/deepseek-v4-flash', ['deepseek/deepseek-v5-flash:free']), []);
});

test('newerInLineage excludes unstable ids in the same lineage', () => {
  assert.deepEqual(newerInLineage('deepseek/deepseek-v4-preview', ['deepseek/deepseek-v5-preview']), []);
});

test('newerInLineage returns an empty array when the pinned id does not parse', () => {
  assert.deepEqual(newerInLineage('not-a-model', ['deepseek/deepseek-v5-flash']), []);
});

test('newerInLineage de-duplicates repeated ids', () => {
  assert.deepEqual(
    newerInLineage('deepseek/deepseek-v4-flash', ['deepseek/deepseek-v5-flash', 'deepseek/deepseek-v5-flash']),
    ['deepseek/deepseek-v5-flash'],
  );
});

// --- readLocalCatalog ------------------------------------------------------

/** An fs seam backed by an in-memory file map. */
function fakeFs(files: Record<string, string>, mtimes: Record<string, number> = {}) {
  return {
    existsSync: (p: string) => p in files,
    readFileSync: (p: string, _e: 'utf8') => files[p],
    statSync: (p: string) => ({ mtimeMs: mtimes[p] ?? 0 }),
  };
}

test('readLocalCatalog reads provider entries from models-store.json', () => {
  const fs = fakeFs({
    '/agent/models-store.json': JSON.stringify({ openrouter: { models: [{ id: 'a/b', name: 'Model B' }] } }),
  });
  assert.deepEqual(readLocalCatalog('/agent', 'openrouter', fs), {
    entries: [{ id: 'a/b', provider: 'openrouter', name: 'Model B' }],
    source: 'models-store.json',
    mtimeMs: 0,
  });
});

test('readLocalCatalog returns empty entries and null source when files are missing', () => {
  assert.deepEqual(readLocalCatalog('/agent', 'openrouter', fakeFs({})), {
    entries: [],
    source: null,
    mtimeMs: null,
  });
});

test('readLocalCatalog returns empty entries and null source when a catalog is malformed', () => {
  const fs = fakeFs({ '/agent/models-store.json': 'not json' });
  assert.deepEqual(readLocalCatalog('/agent', 'openrouter', fs), {
    entries: [],
    source: null,
    mtimeMs: null,
  });
});

test('readLocalCatalog falls back to models.json when models-store.json is missing', () => {
  const fs = fakeFs({
    '/agent/models.json': JSON.stringify({ providers: { openrouter: { models: [{ id: 'x/y' }] } } }),
  });
  assert.equal(readLocalCatalog('/agent', 'openrouter', fs).source, 'models.json');
});

test('readLocalCatalog prefers models-store.json over models.json', () => {
  const fs = fakeFs({
    '/agent/models-store.json': JSON.stringify({ openrouter: { models: [{ id: 'store/a' }] } }),
    '/agent/models.json': JSON.stringify({ providers: { openrouter: { models: [{ id: 'custom/b' }] } } }),
  });
  assert.deepEqual(readLocalCatalog('/agent', 'openrouter', fs).entries.map((e) => e.id), ['store/a']);
});

test('readLocalCatalog reads only the requested provider', () => {
  const fs = fakeFs({
    '/agent/models-store.json': JSON.stringify({
      openrouter: { models: [{ id: 'a/b' }] },
      other: { models: [{ id: 'c/d' }] },
    }),
  });
  assert.deepEqual(readLocalCatalog('/agent', 'openrouter', fs).entries.map((e) => e.id), ['a/b']);
});

// --- fetchOnlineCatalog ----------------------------------------------------

/** A fetch seam returning a fixed status and JSON body. */
function fetchReturning(status: number, body: any): CatalogFetch {
  return async () => ({ status, json: async () => body });
}

test('fetchOnlineCatalog parses entries from a 200 response', () => {
  const fetch = fetchReturning(200, { data: [{ id: 'a/b', name: 'Model B', created: 7 }] });
  return fetchOnlineCatalog({ fetch }).then((entries) => {
    assert.deepEqual(entries, [{ id: 'a/b', provider: 'openrouter', name: 'Model B', created: 7 }]);
  });
});

test('fetchOnlineCatalog returns null on a non-200 response', async () => {
  assert.equal(await fetchOnlineCatalog({ fetch: fetchReturning(503, { data: [] }) }), null);
});

test('fetchOnlineCatalog returns null when the request throws', async () => {
  const fetch: CatalogFetch = async () => {
    throw new Error('offline');
  };
  assert.equal(await fetchOnlineCatalog({ fetch }), null);
});

test('fetchOnlineCatalog returns null on a bad JSON shape', async () => {
  assert.equal(await fetchOnlineCatalog({ fetch: fetchReturning(200, { notData: true }) }), null);
});

test('fetchOnlineCatalog returns null when the body JSON is malformed', async () => {
  const fetch: CatalogFetch = async () => ({ status: 200, json: async () => { throw new Error('bad json'); } });
  assert.equal(await fetchOnlineCatalog({ fetch }), null);
});

test('fetchOnlineCatalog returns null when the request times out', async () => {
  const fetch: CatalogFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  assert.equal(await fetchOnlineCatalog({ fetch, timeoutMs: 5 }), null);
});

test('fetchOnlineCatalog requests the OpenRouter models endpoint by default', async () => {
  let seen = '';
  const fetch: CatalogFetch = async (url) => {
    seen = url;
    return { status: 200, json: async () => ({ data: [] }) };
  };
  await fetchOnlineCatalog({ fetch });
  assert.equal(seen, OPENROUTER_MODELS_URL);
});

test('fetchOnlineCatalog returns null when a fetch ignores the abort signal past the timeout', async () => {
  const fetch: CatalogFetch = () => new Promise(() => {});
  assert.equal(await fetchOnlineCatalog({ fetch, timeoutMs: 5 }), null);
});
