// ---------------------------------------------------------------------------
// Pi transport protocol for remote compute (#123).
//
// The protocol is intentionally transport-neutral. It validates a verified
// host identity before any connection attempt, binds each operation to a
// content-addressed workspace manifest, cancels work through AbortSignal and
// returns a content-addressed artifact manifest. Tests use the local fake
// transport only; this module never opens a real SSH or cloud connection.
// ---------------------------------------------------------------------------
// This file is a re-export facade; the implementation lives in
// compute-pi-host.ts, compute-pi-secrets.ts and compute-pi-protocol.ts (ADR 0016).

import { abortError } from './compute-pi-protocol.ts';
import type {
  PiHostIdentity,
  PiTransport,
  PiTransportConnectRequest,
  PiTransportConnection,
  PiTransportExecuteRequest,
  PiTransportExecutionResult,
} from './compute-pi-secrets.ts';

export {
  COMPUTE_PI_SCHEMA_VERSION,
  PI_HOST_IDENTITY_STATUSES,
  PiProtocolError,
  assertVerifiedPiHost,
  inspectPiHostIdentity,
  verifyPiHostIdentity,
  createPiWorkspaceManifest,
  createPiArtifactManifest,
  verifyPiManifest,
  createWorkspaceManifest,
  createArtifactManifest,
  verifyWorkspaceManifest,
  verifyArtifactManifest,
} from './compute-pi-host.ts';
export type {
  PiHostIdentityStatus,
  PiHostIdentity,
  PiProtocolIssue,
  PiHostInspection,
  PiHostVerification,
  PiManifestFile,
  PiManifestEntry,
  PiWorkspaceManifest,
  PiArtifactManifest,
  PiManifest,
} from './compute-pi-host.ts';
export {
  redactPiSecrets,
  createPiSecretBroker,
  brokerPiSecrets,
  redactPiLogs,
} from './compute-pi-secrets.ts';
export type {
  PiTransportConnectRequest,
  PiTransportExecuteRequest,
  PiTransportExecutionResult,
  PiTransportConnection,
  PiTransport,
  PiConnectRequest,
  PiExecuteRequest,
  PiOperationStatus,
  PiOperationResult,
  PiSession,
  PiProtocol,
  PiSecretBroker,
  PiSecretSource,
} from './compute-pi-secrets.ts';
export {
  createPiProtocol,
  executePiRemoteJob,
  runPiRemoteJob,
  attachPiRemoteJob,
} from './compute-pi-protocol.ts';
export type {
  PiRemoteJobLease,
  PiRemoteJobRequest,
  PiRemoteJobLeaseOutcome,
  PiRemoteJobResult,
} from './compute-pi-protocol.ts';

// ---------------------------------------------------------------------------
// Local fake transport
// ---------------------------------------------------------------------------

export type FakePiTransportOptions = {
  observedHost?: Partial<PiHostIdentity>;
  executionDelayMs?: number;
  execute?: (
    request: PiTransportExecuteRequest,
  ) => Promise<PiTransportExecutionResult> | PiTransportExecutionResult;
};

export type FakePiTransport = PiTransport & {
  connectCalls: number;
  executeCalls: number;
  lastExecutionSignal: AbortSignal | undefined;
  lastExecutionRequest: PiTransportExecuteRequest | undefined;
  lastExecutionEnvironment: Readonly<Record<string, string>> | undefined;
};

/** A deterministic local transport. It never opens sockets or spawns SSH. */
export function createFakePiTransport(options: FakePiTransportOptions = {}): FakePiTransport {
  const fake: FakePiTransport = {
    connectCalls: 0,
    executeCalls: 0,
    lastExecutionSignal: undefined,
    lastExecutionRequest: undefined,
    lastExecutionEnvironment: undefined,
    async connect(request: PiTransportConnectRequest): Promise<PiTransportConnection> {
      fake.connectCalls += 1;
      if (request.signal.aborted) throw abortError('fake Pi connection cancelled');
      const identity: PiHostIdentity = {
        ...request.expectedHost,
        ...(options.observedHost ?? {}),
      };
      return {
        identity,
        async execute(execution: PiTransportExecuteRequest): Promise<PiTransportExecutionResult> {
          fake.executeCalls += 1;
          fake.lastExecutionSignal = execution.signal;
          fake.lastExecutionRequest = execution;
          fake.lastExecutionEnvironment = execution.environment;
          if (options.execute !== undefined) {
            if (execution.signal.aborted) throw abortError('fake Pi execution cancelled');
            return await options.execute(execution);
          }
          await abortableDelay(options.executionDelayMs ?? 0, execution.signal);
          return { exitCode: 0 };
        },
        async close() {
          return undefined;
        },
      };
    },
  };
  return fake;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError('fake Pi execution cancelled'));
  if (ms <= 0) {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError('fake Pi execution cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
