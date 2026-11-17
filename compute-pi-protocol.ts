import {
  releaseComputeLease,
  type ComputeLeaseState,
} from './compute.ts';
import {
  COMPUTE_PI_SCHEMA_VERSION,
  PiProtocolError,
  assertVerifiedPiHost,
  createPiArtifactManifest,
  inspectPiHostIdentity,
  verifyPiHostIdentity,
  verifyPiManifest,
  type PiHostIdentity,
} from './compute-pi-host.ts';
import {
  createPiSecretBroker,
  type PiExecuteRequest,
  type PiOperationResult,
  type PiProtocol,
  type PiSecretBroker,
  type PiSession,
  type PiTransport,
  type PiTransportConnection,
  type PiTransportExecutionResult,
} from './compute-pi-secrets.ts';
import { systemClock, type Clock, type ClockTimer } from './clock.ts';

type AbortScope = {
  signal: AbortSignal;
  getReason(): 'caller' | 'timeout' | null;
  dispose(): void;
};

function createAbortScope(
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
  clock: Clock,
): AbortScope {
  const controller = new AbortController();
  let reason: 'caller' | 'timeout' | null = null;
  const abortFromParent = () => {
    if (reason === null) reason = 'caller';
    controller.abort(parent?.reason);
  };
  if (parent !== undefined) {
    if (parent.aborted) abortFromParent();
    else parent.addEventListener('abort', abortFromParent, { once: true });
  }
  let timer: ClockTimer | undefined;
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs >= 0) {
    timer = clock.setTimeout(() => {
      if (reason === null) reason = 'timeout';
      controller.abort(new Error(`Pi operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
  }
  return {
    signal: controller.signal,
    getReason: () => reason,
    dispose: () => {
      if (timer !== undefined) clock.clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

export function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<{ aborted: true } | { aborted: false; value: T }> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return { aborted: true };
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finish = (outcome: { aborted: true } | { aborted: false; value: T }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const onAbort = () => finish({ aborted: true });
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish({ aborted: false, value }),
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/** The ISO timestamp source: an explicit `now` hook wins, the clock is the fallback. */
function isoSource(now: (() => string) | undefined, clock: Clock): () => string {
  return now ?? (() => clock.iso());
}

function redactorFor(request: Omit<PiExecuteRequest, 'expectedHost'>): (value: string) => string {
  return request.redact ?? ((value) => value);
}

function cancellationResult(input: {
  request: Omit<PiExecuteRequest, 'expectedHost'>;
  expectedHost: PiHostIdentity;
  reason: 'caller' | 'timeout';
  startedAt: string;
  timers: Clock;
}): PiOperationResult {
  const redact = redactorFor(input.request);
  return {
    schemaVersion: COMPUTE_PI_SCHEMA_VERSION,
    requestId: input.request.requestId,
    operation: input.request.operation,
    jobId: input.request.jobId ?? null,
    sourceCommit: input.request.sourceCommit ?? 'unknown',
    status: input.reason === 'timeout' ? 'timed_out' : 'cancelled',
    host: {
      resourceId: input.expectedHost.resourceId,
      resourceGeneration: input.expectedHost.resourceGeneration,
      hostKeyFingerprint: input.expectedHost.hostKeyFingerprint,
    },
    workspaceRoot: input.request.workspace.root,
    artifacts: createPiArtifactManifest({
      sourceCommit: input.request.sourceCommit,
      workspaceRoot: input.request.workspace.root,
    }),
    startedAt: input.startedAt,
    completedAt: input.timers.iso(),
    exitCode: null,
    stdout: '',
    stderr: '',
    logs: redact(''),
    cancellation: { reason: input.reason, propagated: true },
    error: null,
  };
}

function failedResult(input: {
  request: Omit<PiExecuteRequest, 'expectedHost'>;
  expectedHost: PiHostIdentity;
  startedAt: string;
  error: unknown;
  timers: Clock;
}): PiOperationResult {
  const error = input.error instanceof Error ? input.error : new Error(String(input.error));
  const redact = redactorFor(input.request);
  return {
    schemaVersion: COMPUTE_PI_SCHEMA_VERSION,
    requestId: input.request.requestId,
    operation: input.request.operation,
    jobId: input.request.jobId ?? null,
    sourceCommit: input.request.sourceCommit ?? 'unknown',
    status: 'failed',
    host: {
      resourceId: input.expectedHost.resourceId,
      resourceGeneration: input.expectedHost.resourceGeneration,
      hostKeyFingerprint: input.expectedHost.hostKeyFingerprint,
    },
    workspaceRoot: input.request.workspace.root,
    artifacts: createPiArtifactManifest({
      sourceCommit: input.request.sourceCommit,
      workspaceRoot: input.request.workspace.root,
    }),
    startedAt: input.startedAt,
    completedAt: input.timers.iso(),
    exitCode: null,
    stdout: '',
    stderr: '',
    logs: redact(''),
    cancellation: null,
    error: { code: 'operation.failed', message: redact(error.message) },
  };
}

type PiExecutionOutcome = Awaited<ReturnType<typeof raceWithAbort<PiTransportExecutionResult>>>;

type PiSessionContext = {
  connection: PiTransportConnection;
  expectedHost: PiHostIdentity;
  observedHost: PiHostIdentity;
  clock: () => string;
  /** Timers for operation deadlines (and the completion stamp of aborted or failed runs). */
  timers: Clock;
};

async function openPiTransportConnection(
  transport: PiTransport,
  expectedHost: PiHostIdentity,
  request: PiConnectRequest,
  timers: Clock,
): Promise<PiTransportConnection> {
  const scope = createAbortScope(request.signal, request.timeoutMs, timers);
  let connection: PiTransportConnection;
  try {
    let outcome: Awaited<ReturnType<typeof raceWithAbort<PiTransportConnection>>>;
    try {
      outcome = await raceWithAbort(
        Promise.resolve(transport.connect({
          expectedHost,
          signal: scope.signal,
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        })),
        scope.signal,
      );
    } catch (error) {
      throw new PiProtocolError('connect.failed', 'Pi transport connection failed', [{
        code: 'connect.failed',
        message: error instanceof Error ? error.message : String(error),
      }]);
    }
    if (outcome.aborted) {
      const reason = scope.getReason();
      throw new PiProtocolError(
        reason === 'timeout' ? 'connect.timeout' : 'connect.cancelled',
        reason === 'timeout' ? 'Pi transport connection timed out' : 'Pi transport connection was cancelled',
      );
    }
    connection = outcome.value;
  } finally {
    scope.dispose();
  }
  return connection;
}

async function runPiTransportExecution(
  ctx: PiSessionContext,
  request: Omit<PiExecuteRequest, 'expectedHost'>,
  executionScope: AbortScope,
  startedAt: string,
): Promise<{ result: PiOperationResult } | { execution: PiTransportExecutionResult }> {
  const { connection, expectedHost, timers } = ctx;
  let outcome: PiExecutionOutcome;
  try {
    outcome = await raceWithAbort(
      Promise.resolve(connection.execute({
        operation: request.operation,
        requestId: request.requestId,
        ...(request.jobId === undefined ? {} : { jobId: request.jobId }),
        workspace: request.workspace,
        ...(request.sourceCommit === undefined ? {} : { sourceCommit: request.sourceCommit }),
        ...(request.environment === undefined ? {} : { environment: request.environment }),
        signal: executionScope.signal,
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      })),
      executionScope.signal,
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError' && executionScope.signal.aborted) {
      return {
        result: cancellationResult({
          request,
          expectedHost,
          reason: executionScope.getReason() ?? 'caller',
          startedAt,
          timers,
        }),
      };
    }
    return { result: failedResult({ request, expectedHost, startedAt, error, timers }) };
  }
  if (outcome.aborted) {
    return {
      result: cancellationResult({
        request,
        expectedHost,
        reason: executionScope.getReason() ?? 'caller',
        startedAt,
        timers,
      }),
    };
  }
  return { execution: outcome.value };
}

function attachPiArtifacts(
  request: Omit<PiExecuteRequest, 'expectedHost'>,
  execution: PiTransportExecutionResult,
  requestedCommit: string,
) {
  const artifacts = execution.artifacts ?? createPiArtifactManifest({
    files: execution.files ?? [],
    sourceCommit: request.sourceCommit,
    workspaceRoot: request.workspace.root,
  });
  if (!verifyPiManifest(artifacts) || artifacts.kind !== 'artifact') {
    throw new PiProtocolError('artifact.invalid', 'artifact manifest is not content-addressed');
  }
  if (request.sourceCommit !== undefined
    && artifacts.sourceCommit !== 'unknown'
    && artifacts.sourceCommit !== request.sourceCommit) {
    throw new PiProtocolError(
      'artifact.source-commit',
      'artifact manifest does not match the requested source commit',
    );
  }
  return artifacts.sourceCommit === requestedCommit
    ? artifacts
    : {
      ...artifacts,
      sourceCommit: requestedCommit,
      root: manifestRoot('artifact', artifacts.entries, {
        sourceCommit: requestedCommit,
        workspaceRoot: artifacts.workspaceRoot,
      }),
    };
}

function completedPiResult(
  ctx: PiSessionContext,
  request: Omit<PiExecuteRequest, 'expectedHost'>,
  execution: PiTransportExecutionResult,
  startedAt: string,
): PiOperationResult {
  const { observedHost, clock } = ctx;
  const requestedCommit = request.sourceCommit ?? 'unknown';
  const attachedArtifacts = attachPiArtifacts(request, execution, requestedCommit);
  const redact = redactorFor(request);
  const stdout = redact(execution.stdout ?? '');
  const stderr = redact(execution.stderr ?? '');
  return {
    schemaVersion: COMPUTE_PI_SCHEMA_VERSION,
    requestId: request.requestId,
    operation: request.operation,
    jobId: request.jobId ?? null,
    sourceCommit: requestedCommit,
    status: (execution.exitCode ?? 0) === 0 ? 'succeeded' : 'failed',
    host: {
      resourceId: observedHost.resourceId,
      resourceGeneration: observedHost.resourceGeneration,
      hostKeyFingerprint: observedHost.hostKeyFingerprint,
    },
    workspaceRoot: request.workspace.root,
    artifacts: attachedArtifacts,
    startedAt,
    completedAt: clock(),
    exitCode: execution.exitCode ?? 0,
    stdout,
    stderr,
    logs: redact([stdout, stderr].filter((value) => value !== '').join('\n')),
    cancellation: null,
    error: (execution.exitCode ?? 0) === 0
      ? null
      : { code: 'operation.exit', message: redact(`remote command exited with ${execution.exitCode}`) },
  };
}

async function executeOnPiSession(
  ctx: PiSessionContext,
  request: Omit<PiExecuteRequest, 'expectedHost'>,
): Promise<PiOperationResult> {
  if (!verifyPiManifest(request.workspace) || request.workspace.kind !== 'workspace') {
    throw new PiProtocolError('manifest.invalid', 'workspace manifest is not content-addressed');
  }
  const startedAt = ctx.clock();
  const executionScope = createAbortScope(request.signal, request.timeoutMs, ctx.timers);
  try {
    const ran = await runPiTransportExecution(ctx, request, executionScope, startedAt);
    if ('result' in ran) return ran.result;
    return completedPiResult(ctx, request, ran.execution, startedAt);
  } finally {
    executionScope.dispose();
  }
}

async function connectPiSession(
  transport: PiTransport,
  clocks: { clock: () => string; timers: Clock },
  request: PiConnectRequest,
): Promise<PiSession> {
  const { clock, timers } = clocks;
  const expectedHost = assertVerifiedPiHost(request.expectedHost);
  const connection = await openPiTransportConnection(transport, expectedHost, request, timers);

  const verification = verifyPiHostIdentity(expectedHost, connection.identity);
  if (!verification.verified) {
    await connection.close?.();
    throw new PiProtocolError(verification.code, verification.message, verification.issues);
  }

  const observedHost = inspectPiHostIdentity(connection.identity).identity as PiHostIdentity;
  const ctx: PiSessionContext = { connection, expectedHost, observedHost, clock, timers };

  async function execute(request: Omit<PiExecuteRequest, 'expectedHost'>): Promise<PiOperationResult> {
    return executeOnPiSession(ctx, request);
  }

  return {
    expectedHost,
    observedHost,
    execute,
    close: async () => {
      await connection.close?.();
    },
  };
}

/**
 * Build a protocol over an injected transport. The transport is never real SSH in tests.
 * `now` stamps startedAt/completedAt and wins over `clock`; `clock` (default the system
 * clock) also drives operation deadlines.
 */
export function createPiProtocol(
  transport: PiTransport,
  options: { now?: () => string; clock?: Clock } = {},
): PiProtocol {
  const timers = options.clock ?? systemClock;
  const clock = isoSource(options.now, timers);
  if (transport === null || typeof transport !== 'object' || typeof transport.connect !== 'function') {
    throw new PiProtocolError('transport.invalid', 'transport must implement connect()');
  }

  async function connect(request: PiConnectRequest): Promise<PiSession> {
    return connectPiSession(transport, { clock, timers }, request);
  }

  return {
    connect,
    async execute(request: PiExecuteRequest): Promise<PiOperationResult> {
      const session = await connect({
        expectedHost: request.expectedHost,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      });
      try {
        return await session.execute({
          operation: request.operation,
          requestId: request.requestId,
          ...(request.jobId === undefined ? {} : { jobId: request.jobId }),
          workspace: request.workspace,
          ...(request.sourceCommit === undefined ? {} : { sourceCommit: request.sourceCommit }),
          ...(request.environment === undefined ? {} : { environment: request.environment }),
          ...(request.redact === undefined ? {} : { redact: request.redact }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        });
      } finally {
        await session.close();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Leased remote jobs
// ---------------------------------------------------------------------------

/** The fencing lease a remote job was routed under before Pi executes it. */
export type PiRemoteJobLease = {
  leaseId: string;
  holder: string;
  fencingToken: number;
  resourceId: string;
  resourceGeneration: number;
};

export type PiRemoteJobRequest = Omit<PiExecuteRequest, 'jobId' | 'environment' | 'redact'> & {
  jobId: string;
  lease: PiRemoteJobLease;
  leaseState: ComputeLeaseState;
  /** Secret names resolved through the broker immediately before execution. */
  secretNames?: readonly string[];
  secretBroker?: PiSecretBroker;
  /** Clock used to timestamp the lease release (wins over `clock`). */
  now?: () => string;
  /** Fallback clock for the lease release stamp; default the system clock. */
  clock?: Clock;
};

export type PiRemoteJobLeaseOutcome = {
  leaseId: string;
  holder: string;
  fencingToken: number;
  releasedAt: string | null;
  released: boolean;
  /** Operation outcome recorded against the lease, even when cancelled. */
  outcome: PiOperationStatus;
  code: string;
};

export type PiRemoteJobResult = PiOperationResult & {
  leaseState: ComputeLeaseState;
  lease: PiRemoteJobLeaseOutcome;
};

/**
 * Execute a routed remote job over Pi and always release its fencing lease.
 * Secrets are resolved at use time and redacted from every returned log,
 * result and error. Cancellation and timeout still record an outcome and
 * release the lease before the caller observes the result.
 */
export async function executePiRemoteJob(
  protocol: PiProtocol,
  request: PiRemoteJobRequest,
): Promise<PiRemoteJobResult> {
  const clock = isoSource(request.now, request.clock ?? systemClock);
  const broker = request.secretBroker ?? createPiSecretBroker();
  const secretNames = request.secretNames ?? [];
  let environment: Record<string, string> | undefined;
  let result: PiOperationResult | undefined;
  let released = request.leaseState;
  let releaseCode = 'lease.not-released';
  try {
    if (secretNames.length > 0) environment = await broker.resolve(secretNames);
    result = await protocol.execute({
      expectedHost: request.expectedHost,
      operation: request.operation,
      requestId: request.requestId,
      jobId: request.jobId,
      workspace: request.workspace,
      ...(request.sourceCommit === undefined ? {} : { sourceCommit: request.sourceCommit }),
      ...(environment === undefined ? {} : { environment }),
      redact: (value) => broker.redact(value),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
  } finally {
    const release = releaseComputeLease(request.leaseState, {
      leaseId: request.lease.leaseId,
      holder: request.lease.holder,
      fencingToken: request.lease.fencingToken,
      now: clock(),
    });
    if (release.ok) {
      released = release.state;
      releaseCode = 'lease.released';
    } else {
      releaseCode = release.code;
    }
  }
  if (result === undefined) {
    throw new PiProtocolError('job.no-result', 'remote job did not produce an operation result');
  }
  const lease = released.leases.find((entry) => entry.id === request.lease.leaseId);
  return {
    ...result,
    leaseState: released,
    lease: {
      leaseId: request.lease.leaseId,
      holder: request.lease.holder,
      fencingToken: request.lease.fencingToken,
      releasedAt: lease?.releasedAt ?? null,
      released: lease?.releasedAt !== undefined,
      outcome: result.status,
      code: releaseCode,
    },
  };
}

export const runPiRemoteJob = executePiRemoteJob;
export const attachPiRemoteJob = executePiRemoteJob;
