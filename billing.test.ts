// ---------------------------------------------------------------------------
// Optional bounded authoritative OpenRouter billing capture.
//
// Every test injects the network and credential seams; no test reads a real
// credential or makes a live request.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate, run, parseReceipt, estimateCost } from './worker.ts';
import { compactHandoff } from './handoff.ts';
import { captureBilling, validateBilling, resolveOpenRouterApiKey, resolveApiKeyFromEnvironment, readOpenRouterAuthFile, BILLING_MAX_GENERATIONS, BILLING_MAX_TIMEOUT_MS } from './billing.ts';

// --- fixtures and injected seams ---
const gen = (over: any = {}) => ({ provider: 'openrouter', model: 'm', responseId: 'gen-1', ...over });
const receiptFor = (generations: any[]) => ({
 generations,
 observed: [{ provider: 'openrouter', model: 'm' }],
 responseIds: generations.map((g) => g.responseId).filter(Boolean),
});
const config = { mode: 'openrouter' as const, timeoutMs: 1000 };
const budget = () => ({ timeoutMs: 1000, deadlineAt: Date.now() + 5000 });
const apiKey = () => 'sk-secret-key';
const okBody = (id: string, model: string, total: number) => ({ ok: true, status: 200, json: async () => ({ data: { id, model, total_cost: total } }) });
const U = { input: 1, output: 2, totalTokens: 3, cost: { total: 0 } };
const assistant = (over: any = {}) => JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'openrouter', model: 'm', usage: U, stopReason: 'stop', ...over } });
const stream = (...records: any[]) => records.map((r: any) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const task = (extra: any = {}) => ({ id: 'billing', deliverable: 'billing', cwd: mkdtempSync(join(tmpdir(), 'billing-')), acceptance: ['a'], checks: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }], ...extra });
const spawnOk = (responseId?: string) => (_c: string, _a: string[]) => ({ status: 0, stdout: stream({ type: 'session', id: 's' }, assistant(responseId ? { responseId } : {}), { type: 'agent_settled' }), stderr: '' });

// --- contract validation (offline) ---
test('Billing accepts the openrouter mode with a bounded timeout', () => {
 assert.doesNotThrow(() => validateBilling({ mode: 'openrouter', timeoutMs: 500 }));
});
test('Billing rejects an unknown mode', () => {
 assert.throws(() => validateBilling({ mode: 'anthropic' }), /Invalid billing\.mode/);
});
test('Billing rejects an unknown key', () => {
 assert.throws(() => validateBilling({ mode: 'openrouter', retries: 1 }), /Unknown billing field/);
});
test('Billing rejects a non-positive timeout', () => {
 assert.throws(() => validateBilling({ mode: 'openrouter', timeoutMs: 0 }), /Invalid billing\.timeoutMs/);
});
test('Billing rejects a timeout above the bound', () => {
 assert.throws(() => validateBilling({ mode: 'openrouter', timeoutMs: BILLING_MAX_TIMEOUT_MS + 1 }), /Invalid billing\.timeoutMs/);
});
test('Contract rejects a billing object with an unknown field', () => {
 assert.throws(() => validate({ ...task(), billing: { mode: 'openrouter', retries: 1 } }), /Unknown billing field/);
});

// --- capture behavior ---
test('Complete coverage captures the summed authoritative total_cost', async () => {
 const cap = await captureBilling(receiptFor([gen(), gen({ responseId: 'gen-2' })]), config, budget(), {
  resolveApiKey: apiKey,
  fetch: async (url) => url.includes('gen-2') ? okBody('gen-2', 'm', 0.75) : okBody('gen-1', 'm', 0.25),
 });
 assert.equal(cap.billedUsd, 1);
});
test('Complete coverage labels the source provider', async () => {
 const cap = await captureBilling(receiptFor([gen()]), config, budget(), { resolveApiKey: apiKey, fetch: async () => okBody('gen-1', 'm', 0.1) });
 assert.equal(cap.source, 'provider');
});
test('A duplicate generation id triggers only one lookup request', async () => {
 let calls = 0;
 await captureBilling(receiptFor([gen(), gen()]), config, budget(), { resolveApiKey: apiKey, fetch: async () => { calls++; return okBody('gen-1', 'm', 0.5); } });
 assert.equal(calls, 1);
});
test('A duplicate generation id is billed once', async () => {
 const cap = await captureBilling(receiptFor([gen(), gen()]), config, budget(), { resolveApiKey: apiKey, fetch: async () => okBody('gen-1', 'm', 0.5) });
 assert.equal(cap.billedUsd, 0.5);
});
test('A zero total_cost is a captured bill, not unknown', async () => {
 const cap = await captureBilling(receiptFor([gen()]), config, budget(), { resolveApiKey: apiKey, fetch: async () => okBody('gen-1', 'm', 0) });
 assert.equal(cap.billedUsd, 0);
});
test('A missing response id refuses the bill', async () => {
 const cap = await captureBilling(receiptFor([gen({ responseId: null })]), config, budget(), { resolveApiKey: apiKey, fetch: async () => okBody('gen-1', 'm', 0.1) });
 assert.equal(cap.billedUsd, null);
});
test('A missing response id records a concise reason', async () => {
 const cap = await captureBilling(receiptFor([gen({ responseId: null })]), config, budget(), { resolveApiKey: apiKey, fetch: async () => okBody('gen-1', 'm', 0.1) });
 assert.match(String(cap.reason), /missing a response id/i);
});
test('Mixed providers refuse a single authoritative bill', async () => {
 const cap = await captureBilling(receiptFor([gen(), gen({ provider: 'anthropic', responseId: 'gen-2' })]), config, budget(), { resolveApiKey: apiKey, fetch: async () => okBody('gen-1', 'm', 0.1) });
 assert.match(String(cap.reason), /mixed providers/i);
});
test('Partial coverage leaves the bill unknown', async () => {
 let calls = 0;
 const cap = await captureBilling(receiptFor([gen(), gen({ responseId: 'gen-2' })]), config, budget(), {
  resolveApiKey: apiKey,
  fetch: async () => { calls++; return calls === 1 ? okBody('gen-1', 'm', 0.1) : { ok: false, status: 500, json: async () => ({}) }; },
 });
 assert.equal(cap.billedUsd, null);
});
test('Partial coverage records how many generations were captured', async () => {
 let calls = 0;
 const cap = await captureBilling(receiptFor([gen(), gen({ responseId: 'gen-2' })]), config, budget(), {
  resolveApiKey: apiKey,
  fetch: async () => { calls++; return calls === 1 ? okBody('gen-1', 'm', 0.1) : { ok: false, status: 500, json: async () => ({}) }; },
 });
 assert.equal(cap.capturedCount, 1);
});
test('An invalid negative total_cost refuses the bill', async () => {
 const cap = await captureBilling(receiptFor([gen()]), config, budget(), { resolveApiKey: apiKey, fetch: async () => okBody('gen-1', 'm', -1) });
 assert.match(String(cap.reason), /total_cost/i);
});
test('A mismatched response id refuses the bill', async () => {
 const cap = await captureBilling(receiptFor([gen()]), config, budget(), { resolveApiKey: apiKey, fetch: async () => okBody('gen-other', 'm', 0.1) });
 assert.match(String(cap.reason), /id mismatch/i);
});
test('A mismatched model refuses the bill', async () => {
 const cap = await captureBilling(receiptFor([gen()]), config, budget(), { resolveApiKey: apiKey, fetch: async () => okBody('gen-1', 'other', 0.1) });
 assert.match(String(cap.reason), /model mismatch/i);
});
test('A lookup timeout is bounded and refuses the bill', async () => {
 const cap = await captureBilling(receiptFor([gen()]), { mode: 'openrouter', timeoutMs: 20 }, { timeoutMs: 20, deadlineAt: Date.now() + 20 }, { resolveApiKey: apiKey, fetch: () => new Promise(() => {}) as any });
 assert.match(String(cap.reason), /timed out/i);
});
test('An expired deadline refuses the bill without a request', async () => {
 let calls = 0;
 const cap = await captureBilling(receiptFor([gen()]), config, { timeoutMs: 1000, deadlineAt: Date.now() - 1 }, { resolveApiKey: apiKey, fetch: async () => { calls++; return okBody('gen-1', 'm', 0.1); } });
 assert.equal(calls, 0);
});
test('An expired deadline records a concise reason', async () => {
 const cap = await captureBilling(receiptFor([gen()]), config, { timeoutMs: 1000, deadlineAt: Date.now() - 1 }, { resolveApiKey: apiKey, fetch: async () => okBody('gen-1', 'm', 0.1) });
 assert.match(String(cap.reason), /deadline/i);
});
test('A missing credential refuses the bill without a request', async () => {
 let calls = 0;
 const cap = await captureBilling(receiptFor([gen()]), config, budget(), { resolveApiKey: () => null, fetch: async () => { calls++; return okBody('gen-1', 'm', 0.1); } });
 assert.equal(calls, 0);
});
test('A missing credential records a concise reason', async () => {
 const cap = await captureBilling(receiptFor([gen()]), config, budget(), { resolveApiKey: () => null, fetch: async () => okBody('gen-1', 'm', 0.1) });
 assert.match(String(cap.reason), /API key/i);
});
test('A run with no OpenRouter generations records a concise reason', async () => {
 const cap = await captureBilling({ generations: [] }, config, budget(), { resolveApiKey: apiKey, fetch: async () => okBody('gen-1', 'm', 0.1) });
 assert.match(String(cap.reason), /no OpenRouter generations/i);
});
test('Too many unique generations are refused', async () => {
 const generations = Array.from({ length: BILLING_MAX_GENERATIONS + 1 }, (_, i) => gen({ responseId: `gen-${i}` }));
 const cap = await captureBilling(receiptFor(generations), config, budget(), { resolveApiKey: apiKey, fetch: async () => okBody('gen-1', 'm', 0.1) });
 assert.match(String(cap.reason), /unique generations/i);
});
test('An unreadable provider response records a concise reason', async () => {
 const cap = await captureBilling(receiptFor([gen()]), config, budget(), { resolveApiKey: apiKey, fetch: async () => ({ ok: true, status: 200, json: async () => { throw Error('bad json'); } }) });
 assert.match(String(cap.reason), /unreadable response/i);
});
test('A non-success provider response records a concise reason', async () => {
 const cap = await captureBilling(receiptFor([gen()]), config, budget(), { resolveApiKey: apiKey, fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
 assert.match(String(cap.reason), /request failed/i);
});
test('A provider error never leaks the resolved credential', async () => {
 const cap = await captureBilling(receiptFor([gen()]), config, budget(), { resolveApiKey: apiKey, fetch: async () => { throw Error('upstream failed with sk-secret-key'); } });
 assert.equal(JSON.stringify(cap).includes('sk-secret-key'), false);
});

// --- receipt exposure ---
test('Receipt exposes one generation entry per assistant message_end', () => {
 const r = parseReceipt(stream(assistant({ responseId: 'gen-a' }), assistant(), { type: 'agent_settled' }));
 assert.deepEqual(r.generations, [{ provider: 'openrouter', model: 'm', responseId: 'gen-a' }, { provider: 'openrouter', model: 'm', responseId: null }]);
});

// --- credential resolution (temp fake auth file; no real credential) ---
test('The environment key is preferred over the auth file', () => {
 const dir = mkdtempSync(join(tmpdir(), 'billing-auth-'));
 const env: any = { PI_CODING_AGENT_DIR: dir, OPENROUTER_API_KEY: 'sk-env' };
 assert.equal(resolveOpenRouterApiKey(env), 'sk-env');
});
test('An auth.json api_key credential is resolved when the environment is empty', () => {
 const dir = mkdtempSync(join(tmpdir(), 'billing-auth-'));
 writeFileSync(join(dir, 'auth.json'), JSON.stringify({ openrouter: { type: 'api_key', key: 'sk-file' } }));
 assert.equal(resolveOpenRouterApiKey({ PI_CODING_AGENT_DIR: dir }), 'sk-file');
});
test('Missing credential returns null', () => {
 assert.equal(resolveOpenRouterApiKey({ PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), 'billing-auth-')) }), null);
});
test('A malformed auth file yields no credential', () => {
 const dir = mkdtempSync(join(tmpdir(), 'billing-auth-'));
 const path = join(dir, 'auth.json');
 writeFileSync(path, '{not json');
 assert.equal(readOpenRouterAuthFile(path), null);
});
test('The environment resolver ignores a blank key', () => {
 assert.equal(resolveApiKeyFromEnvironment({ OPENROUTER_API_KEY: '   ' } as any), null);
});

// --- estimate integration (no network) ---
test('Estimate merges a captured authoritative bill into billedUsd', () => {
 const r = parseReceipt(stream(assistant({ responseId: 'gen-a' }), { type: 'agent_settled' }));
 const cost = estimateCost(r, undefined, { billedUsd: 2, source: 'provider', generationCount: 1, capturedCount: 1 });
 assert.equal(cost.billedUsd, 2);
});
test('Estimate never promotes an unavailable estimate to a bill', () => {
 const r = parseReceipt(stream(assistant({ responseId: 'gen-a' }), { type: 'agent_settled' }));
 const cost = estimateCost(r, undefined, { billedUsd: null, source: null, reason: 'no OpenRouter API key available', generationCount: 1, capturedCount: 0 });
 assert.equal(cost.billedUsd, null);
});

// --- run integration (injected seams only) ---
test('A run without billing config makes no billing request', async () => {
 let calls = 0;
 await run(task({ provider: 'openrouter', model: 'm' }), false, { spawnPi: spawnOk('gen-1'), billingFetch: async () => { calls++; return okBody('gen-1', 'm', 1); } });
 assert.equal(calls, 0);
});
test('A mock run never makes a billing request', async () => {
 let calls = 0;
 await run(task({ provider: 'openrouter', model: 'm', billing: { mode: 'openrouter' } }), true, { billingFetch: async () => { calls++; return okBody('gen-1', 'm', 1); } });
 assert.equal(calls, 0);
});
test('A live run with billing captures the authoritative total_cost', async () => {
 const r = await run(task({ provider: 'openrouter', model: 'm', billing: { mode: 'openrouter' } }), false, { spawnPi: spawnOk('gen-1'), billingResolveApiKey: apiKey, billingFetch: async () => okBody('gen-1', 'm', 1.25) });
 assert.equal(r.cost.billedUsd, 1.25);
});
test('A live run with a missing generation id leaves billedUsd null', async () => {
 const r = await run(task({ provider: 'openrouter', model: 'm', billing: { mode: 'openrouter' } }), false, { spawnPi: spawnOk(), billingResolveApiKey: apiKey, billingFetch: async () => okBody('gen-1', 'm', 1) });
 assert.equal(r.cost.billedUsd, null);
});
test('A live run with a missing generation id records the billing limitation', async () => {
 const r = await run(task({ provider: 'openrouter', model: 'm', billing: { mode: 'openrouter' } }), false, { spawnPi: spawnOk(), billingResolveApiKey: apiKey, billingFetch: async () => okBody('gen-1', 'm', 1) });
 assert.match(String(r.cost.billingReason), /missing a response id/i);
});
test('Compact handoff labels a captured bill as provider cost', async () => {
 const r = await run(task({ provider: 'openrouter', model: 'm', billing: { mode: 'openrouter' } }), false, { spawnPi: spawnOk('gen-1'), billingResolveApiKey: apiKey, billingFetch: async () => okBody('gen-1', 'm', 1.25) });
 assert.equal(compactHandoff(r).model.cost.source, 'provider');
});
test('Compact handoff surfaces the billing limitation when capture fails', async () => {
 const r = await run(task({ provider: 'openrouter', model: 'm', billing: { mode: 'openrouter' } }), false, { spawnPi: spawnOk(), billingResolveApiKey: apiKey, billingFetch: async () => okBody('gen-1', 'm', 1) });
 assert.match(String(compactHandoff(r).model.cost.billingReason), /missing a response id/i);
});
test('Billing times out when response JSON never resolves', async () => {
 const result = await captureBilling(receiptFor([gen()]), config,
  { timeoutMs: 20, deadlineAt: Date.now() + 1000 },
  { resolveApiKey: apiKey, fetch: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) });
 assert.equal(result.billedUsd, null);
});

test('Billing rejects one generation attributed to conflicting models', async () => {
 const result = await captureBilling(receiptFor([gen(), gen({ model: 'other' })]), config, budget(),
  { resolveApiKey: apiKey, fetch: async () => okBody('gen-1', 'm', 1) });
 assert.equal(result.billedUsd, null);
});