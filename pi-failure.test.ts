import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyPiFailure, redactSecrets } from './pi-failure.ts';

test('a fetch failure maps to a transport category', () => {
  const failure = classifyPiFailure({ exitCode: 1, stderr: 'fetch failed' });
  assert.equal(failure?.category, 'transport_fetch');
});

test('a fetch failure is retryable', () => {
  const failure = classifyPiFailure({ exitCode: 1, stderr: 'fetch failed' });
  assert.equal(failure?.retryable, true);
});

test('an EROFS lock error maps to credential_lock', () => {
  const failure = classifyPiFailure({
    exitCode: 1,
    stderr: 'EROFS: read-only file system, open /home/me/.pi/agent/auth.json.lock',
  });
  assert.equal(failure?.category, 'credential_lock');
});

test('a missing Pi session maps to resume_session_unavailable', () => {
  const failure = classifyPiFailure({
    exitCode: 1,
    stderr: "No session found matching 'abc123'",
  });
  assert.equal(failure?.category, 'resume_session_unavailable');
});

test('a clean exit with zero assistant messages maps to zero_messages', () => {
  const failure = classifyPiFailure({
    exitCode: 0,
    stderr: '',
    receipt: { assistantMessages: 0 },
  });
  assert.equal(failure?.category, 'zero_messages');
});

test('a clean exit with assistant messages is not a failure', () => {
  const failure = classifyPiFailure({
    exitCode: 0,
    stderr: 'fetch failed',
    receipt: { assistantMessages: 1 },
  });
  assert.equal(failure, null);
});

test('detail omits an OpenRouter key present in stderr', () => {
  const failure = classifyPiFailure({
    exitCode: 1,
    stderr: 'request failed with key sk-or-v1-abcdef123456',
  });
  assert.ok(!failure?.detail.includes('sk-or-v1-abcdef123456'));
});

test('detail omits an Authorization header value present in stderr', () => {
  const failure = classifyPiFailure({
    exitCode: 1,
    stderr: 'Authorization: Bearer top-secret-token',
  });
  assert.ok(!failure?.detail.includes('top-secret-token'));
});

test('redactSecrets omits a bare bearer token', () => {
  assert.ok(!redactSecrets('Bearer abc.def').includes('abc.def'));
});

test('redactSecrets omits a JSON token value', () => {
  assert.ok(!redactSecrets('{"token":"json-secret"}').includes('json-secret'));
});

test('redactSecrets omits a JSON apiKey value', () => {
  assert.ok(!redactSecrets('{"apiKey":"json-key"}').includes('json-key'));
});
