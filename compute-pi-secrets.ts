import {
  COMPUTE_PI_SCHEMA_VERSION,
  PiProtocolError,
  type PiArtifactManifest,
  type PiHostIdentity,
  type PiManifestFile,
  type PiWorkspaceManifest,
} from './compute-pi-host.ts';

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
