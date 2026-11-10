import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyPiFailure, redactSecrets } from './pi-failure.ts';

const CREDENTIAL_203 = "Credential store read failed for openrouter: EROFS: read-only file system, mkdir '/home/u/.pi/agent/auth.json.lock'";
const CREDENTIAL_REMEDIATION = 'Junior runs Pi with a run-local copy of your Pi credentials; if this path is your ambient Pi directory, set PI_CODING_AGENT_DIR to a writable directory or report it';

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

test('the #203 credential-store text in stderr maps to credential_lock', () => {
  const failure = classifyPiFailure({ exitCode: 1, stderr: CREDENTIAL_203 });
  assert.equal(failure?.category, 'credential_lock');
});

test('a credential-store failure summary names the lock path from stderr', () => {
  const failure = classifyPiFailure({ exitCode: 1, stderr: CREDENTIAL_203 });
  assert.ok(failure?.summary.includes('/home/u/.pi/agent/auth.json.lock'));
});

test('a credential-store failure summary states the ambient-directory remediation', () => {
  const failure = classifyPiFailure({ exitCode: 1, stderr: CREDENTIAL_203 });
  assert.ok(failure?.summary.includes(CREDENTIAL_REMEDIATION));
});

test('a credential-store failure is not retryable', () => {
  const failure = classifyPiFailure({ exitCode: 1, stderr: CREDENTIAL_203 });
  assert.equal(failure?.retryable, false);
});

test('a credential-store error in an event errorMessage maps to credential_lock', () => {
  const failure = classifyPiFailure({
    exitCode: 1,
    stderr: '',
    eventsText: JSON.stringify({ type: 'error', errorMessage: CREDENTIAL_203 }),
  });
  assert.equal(failure?.category, 'credential_lock');
});

test('an EACCES lock error maps to credential_lock', () => {
  const failure = classifyPiFailure({
    exitCode: 1,
    stderr: "EACCES: permission denied, open '/home/me/.pi/agent/auth.json.lock'",
  });
  assert.equal(failure?.category, 'credential_lock');
});

test('errorMessages entries are inspected for credential-store failures', () => {
  const failure = classifyPiFailure({ exitCode: 1, stderr: '', errorMessages: [CREDENTIAL_203] });
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
