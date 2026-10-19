import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import guardBash, { guardBashInput, guardPathAccess } from './pi-guard.ts';

const env = (value?: string) => (value === undefined ? {} : { JUNIOR_PI_BASH_TIMEOUT_S: value });

test('guardBashInput prefixes a bash command so stdin is /dev/null', () => {
  const input: any = { command: 'cat file' };
  guardBashInput(input, {});
  assert.equal(input.command, 'exec </dev/null\ncat file');
});

test('guardBashInput caps a larger model timeout at the environment value', () => {
  const input: any = { command: 'sleep 1', timeout: 120 };
  guardBashInput(input, env('30'));
  assert.equal(input.timeout, 30);
});

test('guardBashInput keeps a smaller model timeout', () => {
  const input: any = { command: 'sleep 1', timeout: 5 };
  guardBashInput(input, env('30'));
  assert.equal(input.timeout, 5);
});

test('guardBashInput applies the environment timeout when the model omits one', () => {
  const input: any = { command: 'sleep 1' };
  guardBashInput(input, env('30'));
  assert.equal(input.timeout, 30);
});

test('guardBashInput leaves the timeout untouched when the environment value is absent', () => {
  const input: any = { command: 'sleep 1', timeout: 7 };
  guardBashInput(input, {});
  assert.equal(input.timeout, 7);
});

test('guardBashInput leaves the timeout untouched when the environment value is invalid', () => {
  const input: any = { command: 'sleep 1', timeout: 7 };
  guardBashInput(input, env('not-a-number'));
  assert.equal(input.timeout, 7);
});

test('guardBashInput leaves non-bash tool input unchanged', () => {
  const input = { path: '/tmp/file' };
  assert.deepEqual(guardBashInput(input, env('30')), { path: '/tmp/file' });
});

test('The extension rewrites a bash tool_call input in place', () => {
  const handlers: Record<string, (event: any) => void> = {};
  guardBash({ on: (name: string, fn: (event: any) => void) => { handlers[name] = fn; } });
  const event: any = { toolName: 'bash', input: { command: 'cat file' } };
  handlers.tool_call(event);
  assert.equal(event.input.command, 'exec </dev/null\ncat file');
});

test('The extension ignores a non-bash tool_call', () => {
  const handlers: Record<string, (event: any) => void> = {};
  guardBash({ on: (name: string, fn: (event: any) => void) => { handlers[name] = fn; } });
  const event: any = { toolName: 'read', input: { path: '/tmp/file' } };
  handlers.tool_call(event);
  assert.deepEqual(event.input, { path: '/tmp/file' });
});

test('guardPathAccess blocks a write to an absolute path outside the write roots', () => {
 const result = guardPathAccess('write', { path: '/tmp/escape.txt' }, { JUNIOR_PI_WRITE_ROOTS: '/exec:/art' }, '/exec');
 assert.deepEqual(result, { block: true, reason: 'Junior isolation: writes are limited to the execution checkout (/exec); use a relative path.' });
});

test('guardPathAccess allows a relative write inside the execution checkout', () => {
 assert.equal(guardPathAccess('write', { path: 'src/a.ts' }, { JUNIOR_PI_WRITE_ROOTS: '/exec:/art' }, '/exec'), null);
});

test('guardPathAccess allows an edit whose absolute path is inside a write root', () => {
 assert.equal(guardPathAccess('edit', { path: '/art/notes.md' }, { JUNIOR_PI_WRITE_ROOTS: '/exec:/art' }, '/exec'), null);
});

test('guardPathAccess blocks a bash command that reads the source checkout outside .delivery', () => {
 const result = guardPathAccess('bash', { command: 'cat /src/a.txt' }, { JUNIOR_PI_SOURCE_ROOT: '/src' }, '/exec');
 assert.equal(result?.block, true);
});

test('guardPathAccess allows a bash command under the source checkout .delivery tree', () => {
 assert.equal(guardPathAccess('bash', { command: 'cat /src/.delivery/wt/a.txt' }, { JUNIOR_PI_SOURCE_ROOT: '/src' }, '/exec'), null);
});

test('guardPathAccess returns null for a write when no write roots are configured', () => {
 assert.equal(guardPathAccess('write', { path: '/tmp/x' }, {}, '/exec'), null);
});

test('guardPathAccess returns null for bash when no source root is configured', () => {
 assert.equal(guardPathAccess('bash', { command: 'cat /src/a.txt' }, {}, '/exec'), null);
});

test('The extension blocks a write outside the execution checkout through the registered handler', () => {
 const handlers: Record<string, (event: any) => any> = {};
 guardBash({ on: (name: string, fn: (event: any) => any) => { handlers[name] = fn; } });
 const previous = process.env.JUNIOR_PI_WRITE_ROOTS;
 process.env.JUNIOR_PI_WRITE_ROOTS = process.cwd();
 try {
  assert.equal(handlers.tool_call({ toolName: 'write', input: { path: '/tmp/escape.txt' } })?.block, true);
 } finally {
  if (previous === undefined) delete process.env.JUNIOR_PI_WRITE_ROOTS; else process.env.JUNIOR_PI_WRITE_ROOTS = previous;
 }
});

test('guardPathAccess blocks a bash command that names the bare source root', () => {
 const r = guardPathAccess('bash', { command: 'cd /src/repo && ls' }, { JUNIOR_PI_SOURCE_ROOT: '/src/repo' }, '/src/repo/.delivery/x/1/worktree');
 assert.equal(r?.block, true);
});

test('guardPathAccess allows a bash command naming a sibling directory that shares the source prefix', () => {
 const r = guardPathAccess('bash', { command: 'ls /src/repo-site' }, { JUNIOR_PI_SOURCE_ROOT: '/src/repo' }, '/src/repo/.delivery/x/1/worktree');
 assert.equal(r, null);
});
