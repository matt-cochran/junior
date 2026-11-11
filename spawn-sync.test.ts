import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MAX_BUFFER, isSpuriousEperm, runSync } from './spawn-sync.ts';

const node = process.execPath;

function eperm(): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error('spawnSync git EPERM');
  e.code = 'EPERM';
  e.syscall = 'spawnSync git';
  return e;
}

test('captures stdout and stderr of a Node child through files', () => {
  const r = runSync(node, ['-e', 'process.stdout.write("x".repeat(70000)); process.stderr.write("warn")']);
  assert.equal(r.status, 0);
  assert.equal(r.capture, 'files');
  assert.equal(r.stdout.length, 70000);
  assert.equal(r.stderr, 'warn');
  assert.equal(r.error, undefined);
});

test('passes input on stdin and leaves stdin empty without it', () => {
  const echo = ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(`[${s}]`))'];
  assert.equal(runSync(node, echo, { input: 'patch body' }).stdout, '[patch body]');
  assert.equal(runSync(node, echo).stdout, '[]');
});

test('honours cwd, env and a non-zero exit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-sync-cwd-'));
  try {
    const r = runSync(node, ['-e', 'process.stdout.write(process.cwd()+"|"+process.env.PROBE); process.exit(3)'], {
      cwd: dir,
      env: { ...process.env, PROBE: 'yes' },
    });
    assert.equal(r.status, 3);
    assert.ok(r.stdout.endsWith('|yes'));
    assert.ok(r.stdout.includes('spawn-sync-cwd-'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drops a spurious EPERM that comes with an exit status', () => {
  const fake = ((..._a: unknown[]) => ({ pid: 7, status: 0, signal: null, output: [], stdout: null, stderr: null, error: eperm() })) as unknown as typeof spawnSync;
  const r = runSync('git', ['rev-parse', 'HEAD'], { spawn: fake });
  assert.equal(r.status, 0);
  assert.equal(r.error, undefined);
  assert.equal(r.spuriousEperm, true);
});

test('keeps a real spawn failure that has no exit status', () => {
  const fake = ((..._a: unknown[]) => ({ pid: 0, status: null, signal: null, output: [], stdout: null, stderr: null, error: eperm() })) as unknown as typeof spawnSync;
  const r = runSync('git', ['status'], { spawn: fake });
  assert.equal(r.status, null);
  assert.equal(r.error?.code, 'EPERM');
  assert.equal(r.spuriousEperm, undefined);
  assert.equal(runSync('definitely-not-a-command-junior', []).error?.code, 'ENOENT');
});

test('isSpuriousEperm only matches EPERM with a numeric status', () => {
  assert.equal(isSpuriousEperm({ error: eperm(), status: 0 }), true);
  assert.equal(isSpuriousEperm({ error: eperm(), status: null }), false);
  assert.equal(isSpuriousEperm({ error: new Error('x'), status: 0 }), false);
  assert.equal(isSpuriousEperm({ status: 1 }), false);
});

test('reports ENOBUFS and truncates when output exceeds maxBuffer', () => {
  const r = runSync(node, ['-e', 'process.stdout.write("y".repeat(5000))'], { maxBuffer: 1000 });
  assert.equal(r.error?.code, 'ENOBUFS');
  assert.equal(r.stdout.length, 1000);
  assert.ok(DEFAULT_MAX_BUFFER >= 1024 * 1024);
});

test('times out a hung child', () => {
  const r = runSync(node, ['-e', 'setTimeout(()=>{}, 60000)'], { timeout: 200 });
  assert.equal(r.status, null);
  assert.equal(r.signal, 'SIGTERM');
  assert.equal(r.error?.code, 'ETIMEDOUT');
});

test('removes its capture files and falls back to pipes without a temp dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'spawn-sync-root-'));
  try {
    runSync(node, ['-e', 'console.log(1)'], { tempRoot: root });
    assert.deepEqual(readdirSync(root), []);
    const r = runSync(node, ['-e', 'console.log("piped")'], { tempRoot: join(root, 'missing', 'dir') });
    assert.equal(r.capture, 'pipes');
    assert.equal(r.stdout.trim(), 'piped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('inherit and ignore modes run without capturing', () => {
  const r = runSync(node, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  assert.equal(r.status, 0);
  assert.equal(r.capture, 'none');
  assert.equal(r.stdout, '');
});

// #210: `tar -xOf` of a binary entry went through runSync, which decoded the
// capture as UTF-8; invalid sequences became U+FFFD and the binary was garbled.
const ALL_BYTES = 'process.stdout.write(Buffer.from(Array.from({length:256},(_,i)=>i)))';

test('keeps binary stdout byte-for-byte in stdoutBytes', () => {
  const r = runSync(node, ['-e', ALL_BYTES]);
  assert.equal(r.capture, 'files');
  assert.equal(r.stdoutBytes.length, 256);
  assert.deepEqual([...r.stdoutBytes], Array.from({ length: 256 }, (_, i) => i));
});

test('keeps binary stdout byte-for-byte on the pipe fallback', () => {
  const r = runSync(node, ['-e', ALL_BYTES], { tempRoot: join(tmpdir(), 'junior-missing-root', 'nope') });
  assert.equal(r.capture, 'pipes');
  assert.deepEqual([...r.stdoutBytes], Array.from({ length: 256 }, (_, i) => i));
});
