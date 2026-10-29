import { createHash } from 'node:crypto';

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
