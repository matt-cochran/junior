// Behavioral tests for the Crossmatrix ADR-0004 Dimensions adapters and the
// `junior matrix export` CLI.
//
// Every scenario is offline, uses its own temp directory or literal fixture,
// and asserts exactly one observable outcome through a public interface. No
// source text is inspected and no real tool binary is invoked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildDimensionSet,
  codeLocations,
  parseMatrixArgs,
  cpmDeliverables,
  fmecaFailureModes,
  jevitateJobs,
  jevitateJourneys,
  jevitatePersonas,
  tests as testsAdapter,
  validateDimensionSet,
  writeDimensionSet,
} from './matrix.ts';
import { ShapeError } from './companion-shapes.ts';
import { initHop } from './tools/tools.ts';

const ROOT = import.meta.dirname;
const JUNIOR = join(ROOT, 'junior.ts');
const FAKE = join(ROOT, 'tools', 'test-fixtures', 'fake-mcp.mjs');
const NODE = process.execPath;

/** The recorded cpm@0.4.0 `plan.get` response. */
function cpmPlanGetFixture(): unknown {
  return JSON.parse(
    readFileSync(join(ROOT, 'tools', 'test-fixtures', 'companions', 'cpm@0.4.0', 'plan.get.json'), 'utf8'),
  );
}

/** Minimal cpm MCP server that answers every tools/call with the plan.get fixture. */
const FAKE_CPM_SOURCE = `
import fs from 'node:fs';
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function handle(line) {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-cpm', version: '0.0.1' } } });
    return;
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/call') {
    const value = JSON.parse(fs.readFileSync(process.env.FAKE_CPM_PLAN_GET, 'utf8'));
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false } });
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
}
`;

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-matrix-'));
}

function file(path: string, content = 'x'): { path: string; content: string } {
  return { path, content };
}

function memberHash(dimension: any, id: string): string {
  return dimension.members.find((m: any) => m.id === id).sourceRef.contentHash;
}

// --- codeLocations ----------------------------------------------------------

test('codeLocations assigns loc ids to a file and its ancestor directory', () => {
  const dim = codeLocations([file('src/app.ts'), file('README.md')]);
  assert.deepEqual(dim.members.map((m: any) => m.id).sort(), [
    'loc:README.md',
    'loc:src',
    'loc:src/app.ts',
  ]);
});

test('codeLocations changes a directory hash when a child file changes', () => {
  const before = codeLocations([file('src/app.ts', 'a')]);
  const after = codeLocations([file('src/app.ts', 'b')]);
  assert.notEqual(memberHash(before, 'loc:src'), memberHash(after, 'loc:src'));
});

test('codeLocations hashes each file over its bytes', () => {
  const dim = codeLocations([file('a.txt', 'hello')]);
  const expected = 'sha256:' + createHash('sha256').update('hello').digest('hex');
  assert.equal(memberHash(dim, 'loc:a.txt'), expected);
});

// --- tests ------------------------------------------------------------------

test('tests selects only files matching test conventions', () => {
  const dim = testsAdapter([
    file('src/app.ts'),
    file('src/app.test.ts'),
    file('tests/unit/x.ts'),
    file('__tests__/y.ts'),
    file('src/a.spec.ts'),
    file('spec/not-a-test.ts'),
  ]);
  assert.deepEqual(
    dim.members.filter((m: any) => m.attributes.type === 'file').map((m: any) => m.attributes.path).sort(),
    ['__tests__/y.ts', 'src/a.spec.ts', 'src/app.test.ts', 'tests/unit/x.ts'],
  );
});

// --- jevitate ---------------------------------------------------------------

test('jevitateJobs maps a job priority to a weight observation', () => {
  const dim = jevitateJobs([
    { id: 'j1', name: 'Sign up', priority: 'high', outcome: 'Account created', personas: ['p1'] },
  ]);
  assert.equal(dim.members[0].weightObservation, 'high');
});

test('jevitateJobs reads the {jobs:[...]} envelope form', () => {
  const dim = jevitateJobs({ jobs: [{ id: 'j1', name: 'Sign up' }] });
  assert.equal(dim.members.length, 1);
});

test('jevitateJobs emits desired outcomes as weighted requirement members', () => {
  const dim = jevitateJobs([{ id: 'j1', priority: 'high', desiredOutcomes: [{ id: 'fast' }] }]);
  assert.deepEqual(
    dim.members.filter((m: any) => m.id.includes('outcome')).map((m: any) => m.id),
    ['job:j1/outcome:fast'],
  );
});

test('jevitateJobs weights a high-execution outcome above a low-evaluation one', () => {
  const dim = jevitateJobs([
    {
      id: 'j1',
      priority: 'high',
      desiredOutcomes: [
        { id: 'fast', priority: 'high', gulf: 'execution' },
        { id: 'cheap', priority: 'low', gulf: 'evaluation' },
      ],
    },
  ]);
  const weights = dim.members.filter((m: any) => m.id.includes('outcome')).map((m: any) => m.weight);
  assert.deepEqual(weights, [6, 1]);
});

test('jevitatePersonas collects distinct personas from the job catalog', () => {
  const dim = jevitatePersonas({
    jobs: [
      { id: 'j1', personas: ['buyer', 'seller'] },
      { id: 'j2', personas: ['buyer'] },
    ],
  });
  assert.deepEqual(dim.members.map((m: any) => m.id).sort(), ['persona:buyer', 'persona:seller']);
});

test('jevitateJourneys ignores json files inside dot-directories', () => {
  const dim = jevitateJourneys([
    { path: '.jevitate/journeys/checkout.json', content: JSON.stringify({ id: 'checkout' }) },
    { path: '.jevitate/journeys/.hidden/skip.json', content: JSON.stringify({ id: 'skip' }) },
  ]);
  assert.deepEqual(dim.members.map((m: any) => m.id), ['journey:checkout']);
});

// --- cpm --------------------------------------------------------------------

test('cpmDeliverables records owned files in attributes', () => {
  const dim = cpmDeliverables(
    [{ id: 'd1', title: 'Ship it', owned_files: ['a.ts'], prerequisites: ['d0'], estimated_effort_hours: 3 }],
    'plan1',
  );
  assert.deepEqual(dim.members[0].attributes.owned_files, ['a.ts']);
});

test('cpmDeliverables namespaces the source reference with the plan id', () => {
  const dim = cpmDeliverables([{ id: 'd1', title: 'Ship it' }], 'plan1');
  assert.equal(dim.members[0].sourceRef.sourceRef, 'cpm:plan1/d1');
});

test('cpmDeliverables yields one member per deliverable in the cpm@0.4.0 plan.get fixture', () => {
  const dim = cpmDeliverables(cpmPlanGetFixture(), 'plan_FIXTURE');
  assert.deepEqual(dim.members.map((m: any) => m.id), ['cpm:d-api', 'cpm:d-docs', 'cpm:ms']);
});

test('cpmDeliverables carries the cpm@0.4.0 owned_files into member attributes', () => {
  const dim = cpmDeliverables(cpmPlanGetFixture(), 'plan_FIXTURE');
  assert.deepEqual(
    dim.members.map((m: any) => m.attributes.owned_files),
    [['api.ts'], ['docs.md'], []],
  );
});

test('cpmDeliverables throws a ShapeError for an unrecognized plan.get response', () => {
  assert.throws(() => cpmDeliverables({ ok: true }, 'plan1'), ShapeError);
});

// --- fmeca ------------------------------------------------------------------

test('fmecaFailureModes computes the criticality as a numeric weight', () => {
  const dim = fmecaFailureModes(
    [{ id: 'm1', name: 'Loses data', severity: 3, occurrence: 2, detection: 4 }],
    's1',
  );
  assert.equal(dim.members[0].weight, 24);
});

test('fmecaFailureModes marks the numeric weight as a deterministic import', () => {
  const dim = fmecaFailureModes(
    [{ id: 'm1', name: 'Loses data', severity: 3, occurrence: 2, detection: 4 }],
    's1',
  );
  assert.equal(dim.members[0].sourceRef.system, 'fmeca');
});

// --- dimension set ----------------------------------------------------------

test('buildDimensionSet yields the same version for an unchanged roster', () => {
  const roster = () => [codeLocations([file('a.ts', 'same')])];
  assert.equal(buildDimensionSet('s', roster()).version, buildDimensionSet('s', roster()).version);
});

test('buildDimensionSet changes the version when the roster changes', () => {
  const before = buildDimensionSet('s', [codeLocations([file('a.ts', 'one')])]);
  const after = buildDimensionSet('s', [codeLocations([file('a.ts', 'two')])]);
  assert.notEqual(before.version, after.version);
});

// --- writeDimensionSet ------------------------------------------------------

test('writeDimensionSet writes a canonical file with a trailing newline', () => {
  const dir = workdir();
  const doc = buildDimensionSet('s', [codeLocations([file('a.ts')])]);
  const { path: target } = writeDimensionSet(dir, doc);
  const raw = readFileSync(target, 'utf8');
  assert.equal(raw.endsWith('}\n'), true);
});

test('writeDimensionSet reports unchanged when the same document is written twice', () => {
  const dir = workdir();
  const doc = buildDimensionSet('s', [codeLocations([file('a.ts')])]);
  writeDimensionSet(dir, doc);
  assert.equal(writeDimensionSet(dir, doc).unchanged, true);
});

// --- validation -------------------------------------------------------------

test('validateDimensionSet rejects an unknown dimension kind', () => {
  const doc = buildDimensionSet('s', [{ id: 'd', order: 0, kind: 'not_a_kind', members: [] }]);
  assert.ok(validateDimensionSet(doc).some((e) => e.includes('kind')));
});

test('validateDimensionSet rejects a numeric weight without a source system', () => {
  const doc = buildDimensionSet('s', [
    { id: 'd', order: 0, kind: 'failure_mode', members: [{ id: 'm', weight: 3 }] },
  ]);
  assert.ok(validateDimensionSet(doc).some((e) => e.includes('weight')));
});

test('validateDimensionSet accepts the code dimension', () => {
  const doc = buildDimensionSet('s', [codeLocations([file('a.ts')])]);
  assert.deepEqual(validateDimensionSet(doc), []);
});

test('validateDimensionSet accepts the tests dimension', () => {
  const doc = buildDimensionSet('s', [testsAdapter([file('a.test.ts')])]);
  assert.deepEqual(validateDimensionSet(doc), []);
});

test('validateDimensionSet accepts the jevitate jobs dimension', () => {
  const doc = buildDimensionSet('s', [jevitateJobs([{ id: 'j1', name: 'Sign up', priority: 'high' }])]);
  assert.deepEqual(validateDimensionSet(doc), []);
});

test('validateDimensionSet accepts weighted desired outcomes', () => {
  const doc = buildDimensionSet('s', [
    jevitateJobs([{ id: 'j1', priority: 'high', desiredOutcomes: [{ id: 'fast', gulf: 'execution' }] }]),
  ]);
  assert.deepEqual(validateDimensionSet(doc), []);
});

test('validateDimensionSet accepts the cpm dimension', () => {
  const doc = buildDimensionSet('s', [cpmDeliverables([{ id: 'd1', title: 'Ship' }], 'plan1')]);
  assert.deepEqual(validateDimensionSet(doc), []);
});

test('validateDimensionSet accepts the fmeca dimension', () => {
  const doc = buildDimensionSet('s', [
    fmecaFailureModes([{ id: 'm1', severity: 1, occurrence: 1, detection: 1 }], 's1'),
  ]);
  assert.deepEqual(validateDimensionSet(doc), []);
});

// --- CLI --------------------------------------------------------------------

test('junior matrix export writes one Dimensions file for the code source', () => {
  const repo = workdir();
  spawnSync('git', ['init'], { cwd: repo });
  writeFileSync(join(repo, 'app.ts'), 'export const x = 1;\n');
  spawnSync('git', ['add', '.'], { cwd: repo });
  const out = join(repo, '.crossmatrix');
  const result = spawnSync(NODE, [JUNIOR, 'matrix', 'export', '--source', 'code', '--dir', repo, '--out', out], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.written.length, 1);
});

test('junior matrix export writes the file under <out>/dimensions', () => {
  const repo = workdir();
  spawnSync('git', ['init'], { cwd: repo });
  writeFileSync(join(repo, 'app.ts'), 'export const x = 1;\n');
  spawnSync('git', ['add', '.'], { cwd: repo });
  const out = join(repo, '.crossmatrix');
  const result = spawnSync(NODE, [JUNIOR, 'matrix', 'export', '--source', 'code', '--dir', repo, '--out', out], {
    encoding: 'utf8',
  });
  const written = JSON.parse(result.stdout).written[0];
  assert.equal(dirname(written), join(out, 'dimensions'));
});

test('junior matrix export reports the same document as unchanged on a second run', () => {
  const repo = workdir();
  spawnSync('git', ['init'], { cwd: repo });
  writeFileSync(join(repo, 'app.ts'), 'export const x = 1;\n');
  spawnSync('git', ['add', '.'], { cwd: repo });
  const out = join(repo, '.crossmatrix');
  const args = [JUNIOR, 'matrix', 'export', '--source', 'code', '--dir', repo, '--out', out];
  spawnSync(NODE, args, { encoding: 'utf8' });
  const second = spawnSync(NODE, args, { encoding: 'utf8' });
  assert.equal(JSON.parse(second.stdout).unchanged.length, 1);
});

test('junior matrix export --source cpm writes one member per deliverable from the cpm@0.4.0 fixture', () => {
  const dir = workdir();
  const script = join(dir, 'fake-cpm.mjs');
  writeFileSync(script, FAKE_CPM_SOURCE);
  const hop = join(dir, 'hop.json');
  initHop(hop, {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: {
      cpm: {
        command: NODE,
        args: [script],
        env: { FAKE_CPM_PLAN_GET: join(ROOT, 'tools', 'test-fixtures', 'companions', 'cpm@0.4.0', 'plan.get.json') },
        sourceVersion: '0.4.0',
        sourceSha: '0'.repeat(64),
      },
    },
  });
  const result = spawnSync(
    NODE,
    [JUNIOR, 'matrix', 'export', '--source', 'cpm', '--hop', hop, '--plan', 'plan_FIXTURE', '--dir', dir, '--out', join(dir, 'crossmatrix')],
    { encoding: 'utf8' },
  );
  const written = JSON.parse(result.stdout).written[0];
  const doc = JSON.parse(readFileSync(written, 'utf8'));
  const ids = doc.dimensions.find((d: any) => d.id === 'cpm').members.map((m: any) => m.id);
  assert.deepEqual(ids, ['cpm:d-api', 'cpm:d-docs', 'cpm:ms']);
});

test('junior matrix export --source cpm exits non-zero when plan.get is unrecognized', () => {
  const dir = workdir();
  const hop = join(dir, 'hop.json');
  initHop(hop, {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: {
      cpm: {
        command: NODE,
        args: [FAKE],
        env: { FAKE_MCP_MODE: 'echo' },
        sourceVersion: '0.4.0',
        sourceSha: '0'.repeat(64),
      },
    },
  });
  const result = spawnSync(
    NODE,
    [JUNIOR, 'matrix', 'export', '--source', 'cpm', '--hop', hop, '--plan', 'plan1', '--dir', dir, '--out', join(dir, 'crossmatrix')],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
});

test('junior matrix export --source cpm reports the unrecognized plan.get shape', () => {
  const dir = workdir();
  const hop = join(dir, 'hop.json');
  initHop(hop, {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: {
      cpm: {
        command: NODE,
        args: [FAKE],
        env: { FAKE_MCP_MODE: 'echo' },
        sourceVersion: '0.4.0',
        sourceSha: '0'.repeat(64),
      },
    },
  });
  const result = spawnSync(
    NODE,
    [JUNIOR, 'matrix', 'export', '--source', 'cpm', '--hop', hop, '--plan', 'plan1', '--dir', dir, '--out', join(dir, 'crossmatrix')],
    { encoding: 'utf8' },
  );
  assert.equal(result.stderr.includes('Unrecognized cpm.plan.get response'), true);
});

test('junior matrix export from the jevitate source writes a file', () => {
  const repo = workdir();
  mkdirSync(join(repo, '.jevitate'), { recursive: true });
  writeFileSync(join(repo, '.jevitate', 'jobs.json'), JSON.stringify([{ id: 'j1', name: 'Sign up' }]));
  const out = join(repo, '.crossmatrix');
  const result = spawnSync(NODE, [JUNIOR, 'matrix', 'export', '--source', 'jevitate', '--dir', repo, '--out', out], {
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(result.stdout).written.length, 1);
});

test('test artifact member ids do not collide with code location ids', () => {
  const files = [{ path: 'test/login.test.ts', content: 'x' }];
  const codeIds = new Set(codeLocations(files).members.map((m) => m.id));
  assert.equal(testsAdapter(files).members.some((m) => codeIds.has(m.id)), false);
});

test('the tests dimension lists test files without directory members', () => {
  const files = [{ path: 'test/login.test.ts', content: 'x' }, { path: 'test/fixture.json', content: '{}' }];
  assert.equal(testsAdapter(files).members.some((m) => m.attributes?.type === 'dir'), false);
});

// --- CLI: matrix sync --source state ----------------------------------------

test('parseMatrixArgs accepts the state source with its companion session flags', () => {
  const parsed = parseMatrixArgs([
    '--source', 'state', '--hop', 'hop.json', '--model', 'm1',
    '--plan', 'p1', '--fmeca-session', 'f1', '--elicitation-session', 'e1',
    '--sp-session', 's1', '--jevitate-results', 'results/',
  ]);
  assert.deepEqual(
    [parsed.sources, parsed.plan, parsed.fmecaSession, parsed.elicitationSession, parsed.spSession, parsed.jevitateResults],
    [['state'], 'p1', 'f1', 'e1', 's1', 'results/'],
  );
});

// --- CLI: matrix plan-from-spec dispatch ------------------------------------

test('the matrix CLI dispatches plan-from-spec to the spec bridge', () => {
  const result = spawnSync(NODE, [JUNIOR, 'matrix', 'plan-from-spec'], { encoding: 'utf8' });
  assert.equal(result.stderr.includes('--spec <spec.json> or --session'), true);
});
