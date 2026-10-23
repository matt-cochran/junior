// Behavioral tests for the machine-readable route manifest.
//
// `routes.ts` is the one map from a manager job to the Junior route that does
// it: each route names the first command, the follow-up commands, the
// companion skill and the `junior tools call` form. `rankRoutes` recovers the
// right route from a free-text trigger so an agent can route in one call after
// compaction. Every scenario here is offline and deterministic and each test
// asserts exactly one observable outcome through a public interface.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { ROUTES, rankRoutes, main, COMPANION_METHODS } from './routes.ts';
import { isReadTool, TOOL_NAMES, type ToolName } from './tools/tools.ts';

const ROOT = import.meta.dirname;

/** Capture `main`'s stdout without touching the real process stream. */
async function captureMain(argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const io = { out: (text: string) => { chunks.push(text); } };
  const code = await main(argv, io);
  return { code, out: chunks.join('') };
}

test('rankRoutes ranks the plan route first for a CPM plan request', () => {
  assert.equal(rankRoutes('use Junior to create a CPM plan')[0].id, 'plan');
});

test('rankRoutes ranks the plan route first for a bare CPM plan request', () => {
  assert.equal(rankRoutes('create a CPM plan')[0].id, 'plan');
});

test('rankRoutes ranks the risk route first for a failure question', () => {
  assert.equal(rankRoutes('what could go wrong with this migration')[0].id, 'risk');
});

test('rankRoutes ranks the delegate route first for an implementation request', () => {
  assert.equal(rankRoutes('implement this function with junior')[0].id, 'delegate');
});

test('rankRoutes ranks the matrix route first for a traceability request', () => {
  assert.equal(rankRoutes('traceability between requirements and tests')[0].id, 'matrix');
});

test('rankRoutes ranks the restore-context route first after a compaction', () => {
  assert.equal(rankRoutes('rebuild context after compaction')[0].id, 'restore-context');
});

test('rankRoutes returns a score for every route so the ranking is total', () => {
  assert.equal(rankRoutes('create a CPM plan').length, ROUTES.length);
});

test('every junior command a route names exists in the junior CLI', () => {
  const source = readFileSync(`${ROOT}/junior.ts`, 'utf8');
  const commands = new Set<string>();
  for (const m of source.matchAll(/^\s*([a-z][a-z0-9-]*):\s*\{\s*flags:/gm)) commands.add(m[1]);
  for (const m of source.matchAll(/command === '([a-z][a-z0-9-]*)'/g)) commands.add(m[1]);
  const missing: string[] = [];
  for (const route of ROUTES) {
    for (const line of [route.first, ...route.then]) {
      const m = /^junior\s+([a-z][a-z0-9-]*)/.exec(line);
      if (m && !commands.has(m[1])) missing.push(`${route.id}: junior ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

/** The companion method a `tools call` line invokes, or null for the stdin
 * (`-`) and file (`request.json`) forms, which carry no literal method. */
function toolsCallMethod(line: string): { tool: string; method: string } | null {
  const m = /junior tools call\s+(\S+)\s+(\S+)/.exec(line);
  if (!m) return null;
  const [, tool, method] = m;
  if (method === '-' || method.endsWith('.json')) return null;
  return { tool, method };
}

test('COMPANION_METHODS lists exactly the state-mutating methods each server exposes', () => {
  assert.deepEqual(COMPANION_METHODS, {
    cpm: ['plan.submit', 'plan.sync', 'plan.export', 'plan.snapshot', 'plan.baseline', 'plan.acquire_cohort', 'plan.heartbeat', 'plan.mark_status', 'plan.accept', 'plan.force_release', 'plan.fork', 'plan.select', 'plan.archive', 'plan.revise'],
    fmeca: ['session.open', 'append'],
    crossmatrix: ['crossmatrix.command'],
    'scientific-process': ['session.open', 'append'],
    elicitation: ['session.open', 'append'],
  });
});

test('every tools-call method a route names is an allowlisted companion method', () => {
  const bad: string[] = [];
  for (const route of ROUTES) {
    for (const line of [route.first, ...route.then, ...(route.toolsCall ?? [])]) {
      const call = toolsCallMethod(line);
      if (!call) continue;
      const allowed = (COMPANION_METHODS as Record<string, readonly string[]>)[call.tool] ?? [];
      if (!isReadTool(call.tool as ToolName, call.method) && !allowed.includes(call.method)) {
        bad.push(`${route.id}: ${call.tool} ${call.method}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('the declared command allowlist never names a read method', () => {
  const bad: string[] = [];
  for (const tool of TOOL_NAMES) {
    for (const method of COMPANION_METHODS[tool]) {
      if (isReadTool(tool as ToolName, method)) bad.push(`${tool} ${method}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('main with --json prints parseable JSON listing every route id', () => {
  return captureMain(['--json']).then(({ out }) => {
    const ids = JSON.parse(out).map((r: { id: string }) => r.id).sort();
    assert.deepEqual(ids, ROUTES.map((r) => r.id).sort());
  });
});

test('main with a query ranks the best route first in text mode', async () => {
  const { out } = await captureMain(['what could go wrong with this migration']);
  assert.match(out.split('\n')[0], /\brisk\b/);
});

test('main with a query prints at most the top three routes', async () => {
  const { out } = await captureMain(['create a CPM plan']);
  assert.equal(out.trim().split('\n').length, 3);
});
