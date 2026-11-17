import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PiProtocolError,
  createFakePiTransport,
  createPiArtifactManifest,
  createPiProtocol,
  createPiSecretBroker,
  createPiWorkspaceManifest,
  executePiRemoteJob,
  inspectPiHostIdentity,
  verifyPiManifest,
  verifyPiHostIdentity,
  type PiHostIdentity,
} from './compute-pi.ts';
import { acquireComputeLease, createComputeLeaseState } from './compute.ts';
import { createManualClock, type ManualClock } from './clock.ts';

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

/** Let pending I/O-free promise chains settle, then move the manual clock. */
async function tick(clock: ManualClock, ms: number): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await clock.advanceAsync(ms);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Track whether a promise has settled without awaiting it. */
function track<T>(promise: Promise<T>): { settled: () => boolean; promise: Promise<T> } {
  let done = false;
  const tracked = promise.finally(() => { done = true; });
  return { settled: () => done, promise: tracked };
}

/** A protocol and fake transport sharing one manual clock; execution takes 5 s of virtual time. */
function manualPi() {
  const clock = createManualClock('2026-10-25T12:00:00.000Z');
  const transport = createFakePiTransport({ executionDelayMs: 5_000, clock });
  const protocol = createPiProtocol(transport, { clock });
  return { clock, transport, protocol };
}

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
  const { clock, transport, protocol } = manualPi();
  const controller = new AbortController();
  const operation = track(protocol.execute({
    expectedHost: verifiedHost,
    operation: 'run',
    requestId: 'req-cancel',
    workspace: workspace(),
    signal: controller.signal,
  }));
  await tick(clock, 10);
  assert.equal(transport.executeCalls, 1);
  assert.equal(transport.lastExecutionSignal?.aborted, false);
  assert.equal(operation.settled(), false);
  controller.abort();
  await operation.promise;
  assert.equal(transport.lastExecutionSignal?.aborted, true);
});

test('a caller cancellation is reported as cancelled', async () => {
  const { clock, protocol } = manualPi();
  const controller = new AbortController();
  const operation = protocol.execute({
    expectedHost: verifiedHost,
    operation: 'run',
    requestId: 'req-cancel',
    workspace: workspace(),
    signal: controller.signal,
  });
  await tick(clock, 10);
  controller.abort();
  const result = await operation;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.startedAt, '2026-10-25T12:00:00.000Z');
  assert.equal(result.completedAt, '2026-10-25T12:00:00.010Z');
});

test('a timeout aborts the transport signal', async () => {
  const { clock, transport, protocol } = manualPi();
  const operation = track(protocol.execute({
    expectedHost: verifiedHost,
    operation: 'run',
    requestId: 'req-timeout',
    workspace: workspace(),
    timeoutMs: 20,
  }));
  await tick(clock, 19);
  assert.equal(transport.lastExecutionSignal?.aborted, false);
  assert.equal(operation.settled(), false);
  await tick(clock, 1);
  assert.equal(transport.lastExecutionSignal?.aborted, true);
  await operation.promise;
});

test('a timeout is reported as timed_out', async () => {
  const { clock, protocol } = manualPi();
  const operation = track(protocol.execute({
    expectedHost: verifiedHost,
    operation: 'run',
    requestId: 'req-timeout',
    workspace: workspace(),
    timeoutMs: 20,
  }));
  await tick(clock, 19);
  assert.equal(operation.settled(), false);
  await tick(clock, 1);
  assert.equal(operation.settled(), true);
  const result = await operation.promise;
  assert.equal(result.status, 'timed_out');
  assert.equal(result.completedAt, '2026-10-25T12:00:00.020Z');
});

test('an operation that finishes before its deadline succeeds on virtual time', async () => {
  const { clock, protocol } = manualPi();
  const operation = track(protocol.execute({
    expectedHost: verifiedHost,
    operation: 'run',
    requestId: 'req-in-time',
    workspace: workspace(),
    timeoutMs: 10_000,
  }));
  await tick(clock, 4_999);
  assert.equal(operation.settled(), false);
  await tick(clock, 1);
  const result = await operation.promise;
  assert.equal(result.status, 'succeeded');
  assert.equal(result.completedAt, '2026-10-25T12:00:05.000Z');
  assert.equal(clock.pending(), 0);
});

test('an explicit now hook wins over the clock for result timestamps', async () => {
  const clock = createManualClock('2026-10-25T12:00:00.000Z');
  const transport = createFakePiTransport({ execute: async () => ({ exitCode: 0 }) });
  const protocol = createPiProtocol(transport, { clock, now: () => '2000-01-01T00:00:00.000Z' });
  const result = await protocol.execute({
    expectedHost: verifiedHost,
    operation: 'run',
    requestId: 'req-now',
    workspace: workspace(),
  });
  assert.equal(result.startedAt, '2000-01-01T00:00:00.000Z');
  assert.equal(result.completedAt, '2000-01-01T00:00:00.000Z');
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


const NOW = '2026-10-25T12:00:00.000Z';

function acquiredLease() {
  const state = createComputeLeaseState({ resourceId: 'srv-123', resourceGeneration: 7, now: NOW });
  const acquired = acquireComputeLease(state, {
    leaseId: 'lease-job-1',
    holder: 'worker-1',
    now: NOW,
    expiresAt: '2026-10-25T13:00:00.000Z',
  });
  if (!acquired.ok) throw new Error(acquired.message);
  return { state: acquired.state, lease: acquired.lease };
}

function remoteJob(lease: ReturnType<typeof acquiredLease>) {
  return {
    jobId: 'job-1',
    requestId: 'req-job-1',
    expectedHost: verifiedHost,
    operation: 'run',
    workspace: workspace(),
    lease: {
      leaseId: lease.lease.id,
      holder: lease.lease.holder,
      fencingToken: lease.lease.fencingToken,
      resourceId: lease.lease.resourceId,
      resourceGeneration: lease.lease.resourceGeneration,
    },
    leaseState: lease.state,
  };
}

test('transport rejects a host key recreated after verification', async () => {
  const transport = createFakePiTransport({
    observedHost: { hostKeyFingerprint: 'SHA256:recreated-host-key' },
  });
  await assert.rejects(
    () => createPiProtocol(transport).connect({ expectedHost: verifiedHost }),
    (error: PiProtocolError) => error.code === 'host.mismatch',
  );
});

test('a cancelled remote job releases its lease', async () => {
  const lease = acquiredLease();
  const { clock, protocol } = manualPi();
  const controller = new AbortController();
  const operation = track(executePiRemoteJob(protocol, {
    ...remoteJob(lease),
    signal: controller.signal,
    clock,
  }));
  await tick(clock, 10);
  assert.equal(operation.settled(), false);
  controller.abort();
  const result = await operation.promise;
  assert.equal(result.leaseState.leases[0]?.releasedAt, '2026-10-25T12:00:00.010Z');
});

test('a cancelled remote job records the cancelled outcome on its lease', async () => {
  const lease = acquiredLease();
  const { clock, protocol } = manualPi();
  const controller = new AbortController();
  const operation = executePiRemoteJob(protocol, {
    ...remoteJob(lease),
    signal: controller.signal,
    clock,
  });
  await tick(clock, 10);
  controller.abort();
  assert.equal((await operation).lease.outcome, 'cancelled');
});

test('a timed out remote job releases its lease', async () => {
  const lease = acquiredLease();
  const { clock, protocol } = manualPi();
  const operation = track(executePiRemoteJob(protocol, {
    ...remoteJob(lease),
    timeoutMs: 20,
    clock,
  }));
  await tick(clock, 19);
  assert.equal(operation.settled(), false);
  await tick(clock, 1);
  const result = await operation.promise;
  assert.equal(result.lease.outcome, 'timed_out');
  assert.equal(result.leaseState.leases[0]?.releasedAt, '2026-10-25T12:00:00.020Z');
});

test('a remote job returns artifacts with the source commit identity', async () => {
  const lease = acquiredLease();
  const transport = createFakePiTransport({
    execute: async () => ({ exitCode: 0, files: [{ path: 'out.txt', content: 'done\n' }] }),
  });
  const result = await executePiRemoteJob(createPiProtocol(transport), {
    ...remoteJob(lease),
    sourceCommit: 'abc123',
  });
  assert.equal(result.artifacts.sourceCommit, 'abc123');
});

test('a remote job redacts brokered secrets from returned logs', async () => {
  const lease = acquiredLease();
  const transport = createFakePiTransport({
    execute: async () => ({ exitCode: 0, stdout: 'using token s3cr3t\n' }),
  });
  const result = await executePiRemoteJob(createPiProtocol(transport), {
    ...remoteJob(lease),
    secretNames: ['API_TOKEN'],
    secretBroker: createPiSecretBroker({ API_TOKEN: 's3cr3t' }),
  });
  assert.equal(result.logs, 'using token [redacted:API_TOKEN]\n');
});

test('a remote job supplies brokered secrets to the transport at use time', async () => {
  const lease = acquiredLease();
  const transport = createFakePiTransport();
  await executePiRemoteJob(createPiProtocol(transport), {
    ...remoteJob(lease),
    secretNames: ['API_TOKEN'],
    secretBroker: createPiSecretBroker({ API_TOKEN: 's3cr3t' }),
  });
  assert.equal(transport.lastExecutionEnvironment?.API_TOKEN, 's3cr3t');
});
