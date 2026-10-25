// ---------------------------------------------------------------------------
// Pi transport protocol for remote compute (#123).
//
// The protocol is intentionally transport-neutral. It validates a verified
// host identity before any connection attempt, binds each operation to a
// content-addressed workspace manifest, cancels work through AbortSignal and
// returns a content-addressed artifact manifest. Tests use the local fake
// transport only; this module never opens a real SSH or cloud connection.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

import {
  releaseComputeLease,
  type ComputeLeaseState,
} from './compute.ts';

export const COMPUTE_PI_SCHEMA_VERSION = 1;

export const PI_HOST_IDENTITY_STATUSES = [
  'verified',
  'missing',
  'ambiguous',
  'unverified',
  'mismatch',
] as const;
export type PiHostIdentityStatus = typeof PI_HOST_IDENTITY_STATUSES[number];

/** The recorded identity of the host Pi is allowed to connect to. */
export type PiHostIdentity = {
  status: PiHostIdentityStatus;
  resourceId: string;
  resourceGeneration: number;
  host: string;
  port: number;
  user: string;
  /** SSH host-key fingerprint, always pinned by the ownership record. */
  hostKeyFingerprint: string;
  verifiedAt?: string;
  evidence?: string;
};

export type PiProtocolIssue = {
  code: string;
  message: string;
};

export type PiHostInspection = {
  valid: boolean;
  verified: boolean;
  issues: PiProtocolIssue[];
  identity: PiHostIdentity | null;
};

export type PiHostVerification = {
  verified: boolean;
  code: 'host.verified' | 'host.unverified' | 'host.invalid' | 'host.mismatch';
  message: string;
  issues: PiProtocolIssue[];
};

export class PiProtocolError extends Error {
  readonly code: string;
  readonly issues: PiProtocolIssue[];

  constructor(code: string, message: string, issues: PiProtocolIssue[] = []) {
    super(message);
    this.name = 'PiProtocolError';
    this.code = code;
    this.issues = issues;
  }
}

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/=_-]+$/;

/**
 * Validate a host identity record before it is used. Only `verified` records
 * with a complete, pinned identity are eligible for connection.
 */
export function inspectPiHostIdentity(input: unknown): PiHostInspection {
  const issues: PiProtocolIssue[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      valid: false,
      verified: false,
      issues: [{ code: 'host.invalid', message: 'host identity must be an object' }],
      identity: null,
    };
  }
  const raw = input as Partial<PiHostIdentity>;
  if (!PI_HOST_IDENTITY_STATUSES.includes(raw.status as PiHostIdentityStatus)) {
    issues.push({ code: 'host.invalid', message: 'host identity status is invalid' });
  } else if (raw.status !== 'verified') {
    issues.push({
      code: 'host.unverified',
      message: `host identity is ${raw.status}; a verified record is required before connection`,
    });
  }
  if (typeof raw.resourceId !== 'string' || raw.resourceId.trim() === '') {
    issues.push({ code: 'host.invalid', message: 'host identity resourceId is required' });
  }
  if (!Number.isInteger(raw.resourceGeneration) || (raw.resourceGeneration ?? 0) < 1) {
    issues.push({ code: 'host.invalid', message: 'host identity resourceGeneration must be a positive integer' });
  }
  if (typeof raw.host !== 'string' || raw.host.trim() === '') {
    issues.push({ code: 'host.invalid', message: 'host identity host is required' });
  }
  if (!Number.isInteger(raw.port) || (raw.port ?? 0) < 1 || (raw.port ?? 0) > 65_535) {
    issues.push({ code: 'host.invalid', message: 'host identity port must be between 1 and 65535' });
  }
  if (typeof raw.user !== 'string' || raw.user.trim() === '') {
    issues.push({ code: 'host.invalid', message: 'host identity user is required' });
  }
  if (typeof raw.hostKeyFingerprint !== 'string' || !FINGERPRINT.test(raw.hostKeyFingerprint)) {
    issues.push({ code: 'host.invalid', message: 'host identity requires a pinned SHA256 host-key fingerprint' });
  }

  const valid = issues.length === 0;
  return {
    valid,
    verified: valid && raw.status === 'verified',
    issues,
    identity: valid ? {
      status: raw.status as PiHostIdentityStatus,
      resourceId: raw.resourceId as string,
      resourceGeneration: raw.resourceGeneration as number,
      host: raw.host as string,
      port: raw.port as number,
      user: raw.user as string,
      hostKeyFingerprint: raw.hostKeyFingerprint as string,
      ...(raw.verifiedAt === undefined ? {} : { verifiedAt: raw.verifiedAt }),
      ...(raw.evidence === undefined ? {} : { evidence: raw.evidence }),
    } : null,
  };
}

function identityFields(identity: PiHostIdentity): Array<[keyof PiHostIdentity, unknown]> {
  return [
    ['resourceId', identity.resourceId],
    ['resourceGeneration', identity.resourceGeneration],
    ['host', identity.host],
    ['port', identity.port],
    ['user', identity.user],
    ['hostKeyFingerprint', identity.hostKeyFingerprint],
  ];
}

/** Compare the pinned ownership identity with the identity observed at connect. */
export function verifyPiHostIdentity(expectedInput: unknown, observedInput: unknown): PiHostVerification {
  const expected = inspectPiHostIdentity(expectedInput);
  if (!expected.valid) {
    return {
      verified: false,
      code: expected.issues.some((issue) => issue.code === 'host.unverified') ? 'host.unverified' : 'host.invalid',
      message: 'the recorded host identity is not verified',
      issues: expected.issues,
    };
  }
  const observed = inspectPiHostIdentity(observedInput);
  if (!observed.valid) {
    return {
      verified: false,
      code: 'host.invalid',
      message: 'the observed host identity is invalid',
      issues: observed.issues,
    };
  }
  const expectedIdentity = expected.identity as PiHostIdentity;
  const observedIdentity = observed.identity as PiHostIdentity;
  const mismatches = identityFields(expectedIdentity)
    .filter(([field, value]) => observedIdentity[field] !== value)
    .map(([field]) => ({
      code: 'host.mismatch',
      message: `observed host ${field} does not match the verified record`,
    }));
  if (mismatches.length > 0) {
    return {
      verified: false,
      code: 'host.mismatch',
      message: 'the observed host does not match the verified identity; connection is refused',
      issues: mismatches,
    };
  }
  return {
    verified: true,
    code: 'host.verified',
    message: 'the observed host matches the verified identity',
    issues: [],
  };
}

export function assertVerifiedPiHost(input: unknown): PiHostIdentity {
  const inspection = inspectPiHostIdentity(input);
  if (!inspection.valid || !inspection.verified || inspection.identity === null) {
    const code = inspection.issues.some((issue) => issue.code === 'host.unverified')
      ? 'host.unverified'
      : 'host.invalid';
    throw new PiProtocolError(code, 'a verified host identity is required before connection', inspection.issues);
  }
  return inspection.identity;
}

// ---------------------------------------------------------------------------
// Content-addressed manifests
// ---------------------------------------------------------------------------

export type PiManifestFile = {
  path: string;
  content: string | Uint8Array;
  mode?: string;
};

export type PiManifestEntry = {
  path: string;
  sha256: string;
  bytes: number;
  mode: string;
};

export type PiWorkspaceManifest = {
  schemaVersion: typeof COMPUTE_PI_SCHEMA_VERSION;
  kind: 'workspace';
  root: string;
  entries: PiManifestEntry[];
  files: number;
  bytes: number;
};

export type PiArtifactManifest = {
  schemaVersion: typeof COMPUTE_PI_SCHEMA_VERSION;
  kind: 'artifact';
  root: string;
  entries: PiManifestEntry[];
  files: number;
  bytes: number;
  sourceCommit: string;
  workspaceRoot: string | null;
};

export type PiManifest = PiWorkspaceManifest | PiArtifactManifest;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeRelativePath(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new PiProtocolError('manifest.path', 'manifest path is required');
  }
  const path = input.replaceAll('\\', '/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) {
    throw new PiProtocolError('manifest.path', `manifest path must be relative and contained: ${input}`);
  }
  const normalized = path.split('/').filter((part) => part !== '' && part !== '.').join('/');
  if (normalized === '') {
    throw new PiProtocolError('manifest.path', `manifest path is empty after normalization: ${input}`);
  }
  return normalized;
}

function manifestEntries(files: readonly PiManifestFile[]): PiManifestEntry[] {
  const seen = new Set<string>();
  const entries = files.map((file) => {
    const path = normalizeRelativePath(file.path);
    if (seen.has(path)) {
      throw new PiProtocolError('manifest.path', `duplicate manifest path: ${path}`);
    }
    seen.add(path);
    const content = typeof file.content === 'string'
      ? Buffer.from(file.content, 'utf8')
      : Buffer.from(file.content);
    return {
      path,
      sha256: sha256(content),
      bytes: content.byteLength,
      mode: file.mode ?? '100644',
    };
  });
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function manifestRoot(
  kind: PiManifest['kind'],
  entries: readonly PiManifestEntry[],
  metadata: { sourceCommit?: string; workspaceRoot?: string | null } = {},
): string {
  const canonical = JSON.stringify({
    schemaVersion: COMPUTE_PI_SCHEMA_VERSION,
    kind,
    entries: entries
      .map((entry) => ({
        path: entry.path,
        sha256: entry.sha256,
        bytes: entry.bytes,
        mode: entry.mode,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    ...(kind === 'artifact'
      ? {
        sourceCommit: metadata.sourceCommit ?? 'unknown',
        workspaceRoot: metadata.workspaceRoot ?? null,
      }
      : {}),
  });
  return sha256(canonical);
}

function manifestTotals(entries: readonly PiManifestEntry[]): { files: number; bytes: number } {
  return {
    files: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
  };
}

export function createPiWorkspaceManifest(files: readonly PiManifestFile[]): PiWorkspaceManifest {
  if (!Array.isArray(files)) {
    throw new PiProtocolError('manifest.files', 'workspace files must be an array');
  }
  const entries = manifestEntries(files);
  return {
    schemaVersion: COMPUTE_PI_SCHEMA_VERSION,
    kind: 'workspace',
    root: manifestRoot('workspace', entries),
    entries,
    ...manifestTotals(entries),
  };
}

export function createPiArtifactManifest(input: {
  files?: readonly PiManifestFile[];
  sourceCommit?: string;
  workspaceRoot?: string | null;
} = {}): PiArtifactManifest {
  const files = input.files ?? [];
  if (!Array.isArray(files)) {
    throw new PiProtocolError('manifest.files', 'artifact files must be an array');
  }
  const sourceCommit = input.sourceCommit === undefined || input.sourceCommit.trim() === ''
    ? 'unknown'
    : input.sourceCommit;
  const workspaceRoot = input.workspaceRoot ?? null;
  const entries = manifestEntries(files);
  return {
    schemaVersion: COMPUTE_PI_SCHEMA_VERSION,
    kind: 'artifact',
    root: manifestRoot('artifact', entries, { sourceCommit, workspaceRoot }),
    entries,
    ...manifestTotals(entries),
    sourceCommit,
    workspaceRoot,
  };
}

/** Recompute a manifest's content address and compare it with the recorded one. */
export function verifyPiManifest(input: unknown): boolean {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  const manifest = input as Partial<PiManifest>;
  if (manifest.schemaVersion !== COMPUTE_PI_SCHEMA_VERSION) return false;
  if (manifest.kind !== 'workspace' && manifest.kind !== 'artifact') return false;
  if (typeof manifest.root !== 'string' || !Array.isArray(manifest.entries)) return false;
  const entries = manifest.entries;
  if (entries.some((entry) =>
    entry === null
    || typeof entry !== 'object'
    || typeof entry.path !== 'string'
    || typeof entry.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(entry.sha256)
    || !Number.isInteger(entry.bytes)
    || (entry.bytes as number) < 0
    || typeof entry.mode !== 'string')) return false;
  const expected = manifest.kind === 'artifact'
    ? manifestRoot('artifact', entries, {
      sourceCommit: typeof manifest.sourceCommit === 'string' ? manifest.sourceCommit : 'unknown',
      workspaceRoot: manifest.workspaceRoot ?? null,
    })
    : manifestRoot('workspace', entries);
  return manifest.root === expected;
}

export const createWorkspaceManifest = createPiWorkspaceManifest;
export const createArtifactManifest = createPiArtifactManifest;
export const verifyWorkspaceManifest = verifyPiManifest;
export const verifyArtifactManifest = verifyPiManifest;

// ---------------------------------------------------------------------------
// Transport boundary
// ---------------------------------------------------------------------------

export type PiTransportConnectRequest = {
  expectedHost: PiHostIdentity;
  signal: AbortSignal;
  timeoutMs?: number;
};

export type PiTransportExecuteRequest = {
  operation: string;
  requestId: string;
  jobId?: string;
  workspace: PiWorkspaceManifest;
  sourceCommit?: string;
  /** Resolved at use time by the secret broker; never persisted in a receipt. */
  environment?: Readonly<Record<string, string>>;
  signal: AbortSignal;
  timeoutMs?: number;
};

export type PiTransportExecutionResult = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  files?: readonly PiManifestFile[];
  artifacts?: PiArtifactManifest;
};

export type PiTransportConnection = {
  identity: unknown;
  execute(request: PiTransportExecuteRequest): Promise<PiTransportExecutionResult>;
  close?(): Promise<void> | void;
};

export type PiTransport = {
  connect(request: PiTransportConnectRequest): Promise<PiTransportConnection>;
};

export type PiConnectRequest = {
  expectedHost: PiHostIdentity;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type PiExecuteRequest = {
  expectedHost: PiHostIdentity;
  operation: string;
  requestId: string;
  /** Remote job this operation belongs to, when it is leased work. */
  jobId?: string;
  workspace: PiWorkspaceManifest;
  sourceCommit?: string;
  /** Resolved at use time by the secret broker; never persisted in a receipt. */
  environment?: Readonly<Record<string, string>>;
  /** Redacts secret material before it reaches logs, results or errors. */
  redact?: (value: string) => string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type PiOperationStatus = 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

export type PiOperationResult = {
  schemaVersion: typeof COMPUTE_PI_SCHEMA_VERSION;
  requestId: string;
  operation: string;
  jobId: string | null;
  sourceCommit: string;
  status: PiOperationStatus;
  host: {
    resourceId: string;
    resourceGeneration: number;
    hostKeyFingerprint: string;
  };
  workspaceRoot: string;
  artifacts: PiArtifactManifest;
  startedAt: string;
  completedAt: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Redacted stdout/stderr combined for log collection. */
  logs: string;
  cancellation: null | {
    reason: 'caller' | 'timeout';
    propagated: boolean;
  };
  error: null | { code: string; message: string };
};

export type PiSession = {
  expectedHost: PiHostIdentity;
  observedHost: PiHostIdentity;
  execute(request: Omit<PiExecuteRequest, 'expectedHost'>): Promise<PiOperationResult>;
  close(): Promise<void>;
};

export type PiProtocol = {
  connect(request: PiConnectRequest): Promise<PiSession>;
  execute(request: PiExecuteRequest): Promise<PiOperationResult>;
};

// ---------------------------------------------------------------------------
// Secret brokering
// ---------------------------------------------------------------------------

export type PiSecretBroker = {
  /** Resolve names at use time; a missing secret fails the operation. */
  resolve(names: readonly string[]): Promise<Record<string, string>>;
  /** Replace every resolved secret value with a stable marker. */
  redact(value: string): string;
};

/** Replace secret values in text without revealing their names or contents. */
export function redactPiSecrets(
  value: string,
  secrets: Readonly<Record<string, string | undefined>>,
): string {
  let redacted = value;
  for (const [name, secret] of Object.entries(secrets)) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    redacted = redacted.split(secret).join(`[redacted:${name}]`);
  }
  return redacted;
}

export type PiSecretSource =
  | Readonly<Record<string, string | undefined>>
  | { get(name: string): string | undefined | Promise<string | undefined> };

/**
 * Build a use-time secret broker over a local source or secret manager. It
 * stores only resolved values in memory so every emitted record can be redacted.
 */
export function createPiSecretBroker(source: PiSecretSource = {}): PiSecretBroker {
  const resolved = new Map<string, string>();
  const lookup = async (name: string): Promise<string | undefined> => {
    if ('get' in source && typeof source.get === 'function') return await source.get(name);
    return (source as Readonly<Record<string, string | undefined>>)[name];
  };
  return {
    async resolve(names: readonly string[]): Promise<Record<string, string>> {
      const environment: Record<string, string> = {};
      for (const name of names) {
        let value = resolved.get(name);
        if (value === undefined) {
          value = await lookup(name);
          if (value === undefined || value === '') {
            throw new PiProtocolError('secret.missing', `required secret ${name} is unavailable`);
          }
          resolved.set(name, value);
        }
        environment[name] = value;
      }
      return environment;
    },
    redact(value: string): string {
      return redactPiSecrets(value, Object.fromEntries(resolved));
    },
  };
}

export const brokerPiSecrets = createPiSecretBroker;
export const redactPiLogs = redactPiSecrets;

type AbortScope = {
  signal: AbortSignal;
  getReason(): 'caller' | 'timeout' | null;
  dispose(): void;
};

function createAbortScope(parent: AbortSignal | undefined, timeoutMs: number | undefined): AbortScope {
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs >= 0) {
    timer = setTimeout(() => {
      if (reason === null) reason = 'timeout';
      controller.abort(new Error(`Pi operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  }
  return {
    signal: controller.signal,
    getReason: () => reason,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

function abortError(message: string): Error {
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

function nowIso(): string {
  return new Date().toISOString();
}

function redactorFor(request: Omit<PiExecuteRequest, 'expectedHost'>): (value: string) => string {
  return request.redact ?? ((value) => value);
}

function cancellationResult(input: {
  request: Omit<PiExecuteRequest, 'expectedHost'>;
  expectedHost: PiHostIdentity;
  reason: 'caller' | 'timeout';
  startedAt: string;
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
    completedAt: nowIso(),
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
    completedAt: nowIso(),
    exitCode: null,
    stdout: '',
    stderr: '',
    logs: redact(''),
    cancellation: null,
    error: { code: 'operation.failed', message: redact(error.message) },
  };
}

/** Build a protocol over an injected transport. The transport is never real SSH in tests. */
export function createPiProtocol(transport: PiTransport, options: { now?: () => string } = {}): PiProtocol {
  const clock = options.now ?? nowIso;
  if (transport === null || typeof transport !== 'object' || typeof transport.connect !== 'function') {
    throw new PiProtocolError('transport.invalid', 'transport must implement connect()');
  }

  async function connect(request: PiConnectRequest): Promise<PiSession> {
    const expectedHost = assertVerifiedPiHost(request.expectedHost);
    const scope = createAbortScope(request.signal, request.timeoutMs);
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

    const verification = verifyPiHostIdentity(expectedHost, connection.identity);
    if (!verification.verified) {
      await connection.close?.();
      throw new PiProtocolError(verification.code, verification.message, verification.issues);
    }

    const observedHost = inspectPiHostIdentity(connection.identity).identity as PiHostIdentity;

    async function execute(request: Omit<PiExecuteRequest, 'expectedHost'>): Promise<PiOperationResult> {
      if (!verifyPiManifest(request.workspace) || request.workspace.kind !== 'workspace') {
        throw new PiProtocolError('manifest.invalid', 'workspace manifest is not content-addressed');
      }
      const startedAt = clock();
      const executionScope = createAbortScope(request.signal, request.timeoutMs);
      try {
        let outcome: Awaited<ReturnType<typeof raceWithAbort<PiTransportExecutionResult>>>;
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
            return cancellationResult({
              request,
              expectedHost,
              reason: executionScope.getReason() ?? 'caller',
              startedAt,
            });
          }
          return failedResult({ request, expectedHost, startedAt, error });
        }
        if (outcome.aborted) {
          return cancellationResult({
            request,
            expectedHost,
            reason: executionScope.getReason() ?? 'caller',
            startedAt,
          });
        }
        const execution = outcome.value;
        const artifacts = execution.artifacts ?? createPiArtifactManifest({
          files: execution.files ?? [],
          sourceCommit: request.sourceCommit,
          workspaceRoot: request.workspace.root,
        });
        if (!verifyPiManifest(artifacts) || artifacts.kind !== 'artifact') {
          throw new PiProtocolError('artifact.invalid', 'artifact manifest is not content-addressed');
        }
        const requestedCommit = request.sourceCommit ?? 'unknown';
        if (request.sourceCommit !== undefined
          && artifacts.sourceCommit !== 'unknown'
          && artifacts.sourceCommit !== request.sourceCommit) {
          throw new PiProtocolError(
            'artifact.source-commit',
            'artifact manifest does not match the requested source commit',
          );
        }
        const attachedArtifacts = artifacts.sourceCommit === requestedCommit
          ? artifacts
          : {
            ...artifacts,
            sourceCommit: requestedCommit,
            root: manifestRoot('artifact', artifacts.entries, {
              sourceCommit: requestedCommit,
              workspaceRoot: artifacts.workspaceRoot,
            }),
          };
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
      } finally {
        executionScope.dispose();
      }
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
  /** Clock used to timestamp the lease release. */
  now?: () => string;
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
  const clock = request.now ?? nowIso;
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
