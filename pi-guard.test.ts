import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import guardBash, { guardBashInput, guardPathAccess, CROSSMATRIX_STORE_REASON, applyAffinityHeader, applyProviderRouting } from './pi-guard.ts';

const env = (value?: string) => (value === undefined ? {} : { JUNIOR_PI_BASH_TIMEOUT_S: value });

test('guardBashInput prefixes a bash command so stdin is /dev/null', () => {
  const input: any = { command: 'cat file' };
  guardBashInput(input, {});
  assert.equal(input.command, 'exec </dev/null\ncat file');
});

test('guardBashInput replaces a command refused by JUNIOR_COMMAND_POLICY with an E_COMMAND_PLACEMENT refusal', () => {
  const wrapper = '/opt/wrappers/npm-safe.sh';
  const policy = { enforce: true, rules: [{ match: ['node --test'], placement: 'remote', wrapper }] };
  const input: any = { command: 'node --test x.test.ts' };
  guardBashInput(input, { JUNIOR_COMMAND_POLICY: JSON.stringify(policy) });
  assert.match(input.command, /^printf '%s\\n' '.*"error":"E_COMMAND_PLACEMENT".*"argv":"node --test x\.test\.ts".*"wrapper":"\/opt\/wrappers\/npm-safe\.sh".*' >&2; exit 126$/);
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

test('applyAffinityHeader sets x-session-id from JUNIOR_PI_AFFINITY_KEY', () => {
 const headers: Record<string, string | null> = {};
 applyAffinityHeader(headers, { JUNIOR_PI_AFFINITY_KEY: 'junior:deliverable-1' });
 assert.equal(headers['x-session-id'], 'junior:deliverable-1');
});

test('applyAffinityHeader leaves headers unchanged without the variable', () => {
 const headers: Record<string, string | null> = {};
 applyAffinityHeader(headers, {});
 assert.deepEqual(headers, {});
});

test('applyProviderRouting merges the configured provider routing into the payload', () => {
 const routed = applyProviderRouting({ model: 'm' }, { JUNIOR_PI_OPENROUTER_ROUTING: JSON.stringify({ order: ['deepinfra'], allow_fallbacks: false }) });
 assert.deepEqual(routed.provider, { order: ['deepinfra'], allow_fallbacks: false });
});

test('applyProviderRouting ignores invalid JSON', () => {
 const payload = { model: 'm' };
 assert.deepEqual(applyProviderRouting(payload, { JUNIOR_PI_OPENROUTER_ROUTING: '{not json' }), payload);
});

test('a set but malformed JUNIOR_COMMAND_POLICY refuses the bash command', () => {
 const input = { command: 'git status' };
 guardBashInput(input, { JUNIOR_COMMAND_POLICY: '{not json' });
 assert.match(input.command, /E_COMMAND_PLACEMENT/);
});

const CROSSMATRIX_REASON = 'Junior: the .crossmatrix/ store is read only through `junior matrix context|files|features|stale` (or the crossmatrix MCP); do not read its files.';

test('guardPathAccess blocks reading a .crossmatrix file through the read tool', () => {
 assert.deepEqual(guardPathAccess('read', { path: '.crossmatrix/state/x.json' }, {}, '/exec'), { block:true, reason:CROSSMATRIX_REASON });
});

test('guardPathAccess blocks a bash command that cats a .crossmatrix file', () => {
 assert.deepEqual(guardPathAccess('bash', { command: 'cat .crossmatrix/state/x.json' }, {}, '/exec'), { block:true, reason:CROSSMATRIX_REASON });
});

test('guardPathAccess blocks a recursive grep whose path ends at .crossmatrix', () => {
 assert.deepEqual(guardPathAccess('bash', { command: 'grep -r foo .crossmatrix' }, {}, '/exec'), { block:true, reason:CROSSMATRIX_REASON });
});

test('guardPathAccess allows the junior matrix CLI to read the store', () => {
 assert.equal(guardPathAccess('bash', { command: 'junior matrix stale' }, {}, '/exec'), null);
});

test('guardPathAccess allows reading a source file outside .crossmatrix', () => {
 assert.equal(guardPathAccess('read', { path: 'src/a.ts' }, {}, '/exec'), null);
});

test('a sanctioned matrix command chained with a store read is blocked', () => {
  const blocked = guardPathAccess('bash', { command: 'junior matrix stale; cat .crossmatrix/state/x.json' }, {}, '/work');
  assert.equal(blocked?.reason, CROSSMATRIX_STORE_REASON);
});

// --- default hook-bypass guard (#281) ---------------------------------------

test('guardBashInput refuses git commit --no-verify with no policy', () => {
  const input: any = { command: 'git commit --no-verify' };
  guardBashInput(input, {});
  assert.match(input.command, /E_POLICY_GUARD/);
});

test('guardBashInput refuses an env-prefixed HUSKY=0 with no policy', () => {
  const input: any = { command: 'env HUSKY=0 git commit' };
  guardBashInput(input, {});
  assert.match(input.command, /E_POLICY_GUARD/);
});

test('guardBashInput refuses git -c core.hooksPath with no policy', () => {
  const input: any = { command: 'git -c core.hooksPath=.husky commit' };
  guardBashInput(input, {});
  assert.match(input.command, /E_POLICY_GUARD/);
});

test('guardBashInput names the hook_bypass kind in the refusal', () => {
  const input: any = { command: 'git commit --no-verify' };
  guardBashInput(input, {});
  assert.match(input.command, /"kind":"hook_bypass"/);
});

test('guardBashInput permits --no-verify when hookBypass is off', () => {
  const input: any = { command: 'git commit --no-verify' };
  guardBashInput(input, { JUNIOR_COMMAND_POLICY: JSON.stringify({ guards: { hookBypass: 'off' } }) });
  assert.equal(input.command, 'exec </dev/null\ngit commit --no-verify');
});

test('guardBashInput leaves a normal git commit runnable', () => {
  const input: any = { command: 'git commit -m message' };
  guardBashInput(input, {});
  assert.equal(input.command, 'exec </dev/null\ngit commit -m message');
});

test('guardBashInput does not apply the no-build guard to worker bash', () => {
  const input: any = { command: 'dotnet test --no-build' };
  guardBashInput(input, {});
  assert.equal(input.command, 'exec </dev/null\ndotnet test --no-build');
});

// --- short flags, opaque and nested shells ----------------------------------

test('guardBashInput refuses git commit -n with no policy', () => {
  const input: any = { command: 'git commit -n' };
  guardBashInput(input, {});
  assert.match(input.command, /E_POLICY_GUARD/);
});

test('guardBashInput refuses a combined git commit short flag containing n', () => {
  const input: any = { command: "git commit -anm 'message'" };
  guardBashInput(input, {});
  assert.match(input.command, /E_POLICY_GUARD/);
});

test('guardBashInput leaves git push -n runnable', () => {
  const input: any = { command: 'git push -n' };
  guardBashInput(input, {});
  assert.equal(input.command, 'exec </dev/null\ngit push -n');
});

test('guardBashInput raw-scans an opaque unterminated quote', () => {
  const input: any = { command: 'echo "git commit --no-verify' };
  guardBashInput(input, {});
  assert.match(input.command, /E_POLICY_GUARD/);
});

test('guardBashInput raw-scans a command substitution', () => {
  const input: any = { command: 'echo "$(git commit --no-verify)"' };
  guardBashInput(input, {});
  assert.match(input.command, /E_POLICY_GUARD/);
});

test('guardBashInput raw-scans backticks', () => {
  const input: any = { command: 'echo `git commit --no-verify`' };
  guardBashInput(input, {});
  assert.match(input.command, /E_POLICY_GUARD/);
});

test('guardBashInput raw-scans a nested bash -c', () => {
  const input: any = { command: 'bash -c \'echo "git commit --no-verify"\'' };
  guardBashInput(input, {});
  assert.match(input.command, /E_POLICY_GUARD/);
});

test('guardBashInput raw-scans xargs git', () => {
  const input: any = { command: 'xargs git commit --no-verify' };
  guardBashInput(input, {});
  assert.match(input.command, /E_POLICY_GUARD/);
});

test('guardBashInput leaves a plain quoted mention runnable', () => {
  const input: any = { command: 'echo "git commit --no-verify"' };
  guardBashInput(input, {});
  assert.equal(input.command, 'exec </dev/null\necho "git commit --no-verify"');
});
