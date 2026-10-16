import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import guardBash, { guardBashInput } from './pi-guard.ts';

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
