// Behavioral tests for `junior matrix init`: it shells out to the
// crossmatrix-mcp companion to create a project's committed `.crossmatrix/`
// store, and refuses a binary older than 0.3.0.
//
// Every scenario is offline: exec, exists, readFile and the managed state path
// are injected, so no real binary runs and no file outside a temp dir is read.
// Each test asserts exactly one observable outcome through a public interface.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matrixInit, type MatrixInitDeps } from './matrix-init.ts';
import { init } from './setup.ts';

type Call = { command: string; args: string[] };

const BIN_DIR = '/tools/bin';
const BINARY = join(BIN_DIR, 'crossmatrix-mcp');
const MANAGED = '/home/user/.junior/tools/crossmatrix-mcp';

/** A fake world: the binary on PATH (or only managed), its version, and the store. */
function world(opts: {
  version?: string;
  onPath?: boolean;
  managed?: string | null;
  store?: boolean;
  status?: number;
  calls?: Call[];
} = {}): MatrixInitDeps {
  const calls = opts.calls ?? [];
  const version = opts.version ?? '0.3.0';
  const onPath = opts.onPath ?? true;
  const managed = opts.managed ?? null;
  let store = opts.store ?? false;
  return {
    env: { PATH: BIN_DIR },
    exists: (p: string) =>
      (onPath && p === BINARY) ||
      (managed !== null && (p === MANAGED || p.endsWith('installed.json'))) ||
      (p.endsWith('.crossmatrix') && store),
    readFile: () => JSON.stringify({ schemaVersion: 1, tools: { crossmatrix: { path: MANAGED } } }),
    exec: (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args[0] === '--version') return { status: 0, stdout: `crossmatrix-mcp ${version}\n` };
      if (args[0] === 'init') {
        store = true;
        return { status: opts.status ?? 0, stdout: 'created\n' };
      }
      return { status: 0, stdout: '' };
    },
  };
}

test('matrix init runs crossmatrix-mcp init with the project directory', () => {
  const calls: Call[] = [];
  matrixInit(world({ calls }), { dir: '/project' });
  assert.deepEqual(calls.find((c) => c.args[0] === 'init')?.args, ['init', '--dir', '/project']);
});

test('matrix init refuses a crossmatrix-mcp older than 0.3.0', () => {
  assert.throws(() => matrixInit(world({ version: '0.2.1' }), { dir: '/project' }), /0\.3\.0/);
});

test('matrix init refuses a crossmatrix-mcp 0.3.0 prerelease', () => {
  assert.throws(() => matrixInit(world({ version: '0.3.0-rc.1' }), { dir: '/project' }), /0\.3\.0/);
});

test('matrix init falls back to the managed crossmatrix-mcp binary when it is not on PATH', () => {
  const calls: Call[] = [];
  matrixInit(world({ onPath: false, managed: MANAGED, calls }), { dir: '/project' });
  assert.deepEqual(calls.find((c) => c.args[0] === 'init')?.command, MANAGED);
});

test('matrix init reports the .crossmatrix store it newly created', () => {
  const result = matrixInit(world({ store: false }), { dir: '/project' });
  assert.deepEqual(result.created, ['.crossmatrix']);
});

test('init suggests `junior matrix init` when the project has no .crossmatrix store', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'junior-matrix-init-cwd-'));
  const result = init({ cwd, env: { PATH: '' }, readMounts: () => '' }, { target: 'none', install: false });
  assert.ok(result.instructions.some((line) => line.includes('junior matrix init')));
});
