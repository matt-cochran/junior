import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PiProtocolError,
  createFakePiTransport,
  createPiArtifactManifest,
  createPiProtocol,
  createPiWorkspaceManifest,
  inspectPiHostIdentity,
  verifyPiManifest,
  verifyPiHostIdentity,
  type PiHostIdentity,
} from './compute-pi.ts';

const verifiedHost: PiHostIdentity = {
  status: 'verified',
  resourceId: 'srv-123',
  resourceGeneration: 7,
  host: '203.0.113.10',
  port: 22,
  user: 'junior',
  hostKeyFingerprint: 'SHA256:verified-host-key',
  evidence: 'recorded ownership + host key',
};

function workspace() {
  return createPiWorkspaceManifest([
    { path: 'src/index.ts', content: 'export const value = 1;\n' },
    { path: 'README.md', content: '# demo\n' },
  ]);
}

test('an unverified host record is rejected by identity inspection', () => {
  const inspection = inspectPiHostIdentity({ ...verifiedHost, status: 'unverified' });
  assert.equal(inspection.valid, false);
});

test('protocol does not call the transport for an unverified host', async () => {
  const transport = createFakePiTransport();
  const protocol = createPiProtocol(transport);
  await protocol
    .connect({ expectedHost: { ...verifiedHost, status: 'unverified' } })
    .catch(() => undefined);
  assert.equal(transport.connectCalls, 0);
});

test('protocol rejects a host whose observed key differs from the record', async () => {
  const transport = createFakePiTransport({
    observedHost: { hostKeyFingerprint: 'SHA256:recreated-host-key' },
  });
  const protocol = createPiProtocol(transport);
  await assert.rejects(
    () => protocol.connect({ expectedHost: verifiedHost }),
    (error: PiProtocolError) => error.code === 'host.mismatch',
  );
});

test('a verified record and matching observed host are accepted', () => {
  const result = verifyPiHostIdentity(verifiedHost, verifiedHost);
  assert.equal(result.verified, true);
});

test('identical workspace contents produce the same content address', () => {
  assert.equal(workspace().root, workspace().root);
});

test('changed workspace content produces a different content address', () => {
  const changed = createPiWorkspaceManifest([
    { path: 'src/index.ts', content: 'export const value = 2;\n' },
    { path: 'README.md', content: '# demo\n' },
  ]);
  assert.notEqual(workspace().root, changed.root);
});

test('a workspace manifest verifies against its recorded content address', () => {
  assert.equal(verifyPiManifest(workspace()), true);
});

test('a tampered workspace manifest fails content-address verification', () => {
  const manifest = workspace();
  manifest.entries[0]!.sha256 = '0'.repeat(64);
  assert.equal(verifyPiManifest(manifest), false);
});

test('an artifact manifest carries a content address and source commit', () => {
  const manifest = createPiArtifactManifest({
    files: [{ path: 'result.txt', content: 'ok\n' }],
    sourceCommit: 'abc123',
    workspaceRoot: workspace().root,
  });
  assert.equal(manifest.sourceCommit, 'abc123');
});

test('a cancelled operation aborts the transport signal', async () => {
  const transport = createFakePiTransport({ executionDelayMs: 5_000 });
  const protocol = createPiProtocol(transport);
  const controller = new AbortController();
  const operation = protocol.execute({
    expectedHost: verifiedHost,
    operation: 'run',
    requestId: 'req-cancel',
    workspace: workspace(),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  await operation;
  assert.equal(transport.lastExecutionSignal?.aborted, true);
});

test('a caller cancellation is reported as cancelled', async () => {
  const transport = createFakePiTransport({ executionDelayMs: 5_000 });
  const protocol = createPiProtocol(transport);
  const controller = new AbortController();
  const operation = protocol.execute({
    expectedHost: verifiedHost,
    operation: 'run',
    requestId: 'req-cancel',
    workspace: workspace(),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  assert.equal((await operation).status, 'cancelled');
});

test('a timeout aborts the transport signal', async () => {
  const transport = createFakePiTransport({ executionDelayMs: 5_000 });
  const protocol = createPiProtocol(transport);
  await protocol.execute({
    expectedHost: verifiedHost,
    operation: 'run',
    requestId: 'req-timeout',
    workspace: workspace(),
    timeoutMs: 20,
  });
  assert.equal(transport.lastExecutionSignal?.aborted, true);
});

test('a timeout is reported as timed_out', async () => {
  const transport = createFakePiTransport({ executionDelayMs: 5_000 });
  const protocol = createPiProtocol(transport);
  const result = await protocol.execute({
    expectedHost: verifiedHost,
    operation: 'run',
    requestId: 'req-timeout',
    workspace: workspace(),
    timeoutMs: 20,
  });
  assert.equal(result.status, 'timed_out');
});

test('a completed operation returns a content-addressed artifact manifest', async () => {
  const transport = createFakePiTransport({
    execute: async () => ({ exitCode: 0, files: [{ path: 'out.txt', content: 'done\n' }] }),
  });
  const protocol = createPiProtocol(transport);
  const result = await protocol.execute({
    expectedHost: verifiedHost,
    operation: 'run',
    requestId: 'req-ok',
    workspace: workspace(),
    sourceCommit: 'abc123',
  });
  assert.equal(verifyPiManifest(result.artifacts), true);
});
