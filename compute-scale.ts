import { isTimestamp, resolveEpoch } from './compute-schema.ts';

// ---------------------------------------------------------------------------
// Leased job routing and scale-in guardrails.
//
// Scale-in is only safe after idle expiry and only when every activity signal
// is known to be quiescent. A busy signal, an active or unreclaimed lease,
// queued work, an unexpired minimum lifetime, or missing/over-limit disk
// evidence retains capacity rather than guessing.
// ---------------------------------------------------------------------------

export type ComputeScaleInEvidence = {
  capacity: {
    min: number;
    max: number;
    current: number | 'unknown';
  };
  /** Idle expiry start; must be a known timestamp. */
  idleSince: string | 'unknown';
  idleTimeoutMs: number;
  /** Any nonzero or unknown busy evidence retains capacity. */
  busy: boolean | number | 'unknown';
  leaseActive?: boolean | 'unknown';
  queuedWork?: number | 'unknown';
  diskUsedPercent?: number | 'unknown';
  diskLimitPercent?: number;
  /** Resource creation/lifetime start; unknown retains capacity. */
  startedAt?: string | 'unknown';
  minimumLifetimeMs?: number;
  now?: string | number;
};

export type ComputeScaleInDecision = {
  allowed: boolean;
  action: 'retain' | 'scale-in' | 'scale-to-zero';
  targetCapacity: number;
  code: string;
  message: string;
  reasons: string[];
};

/**
 * Decide whether an idle managed resource may scale in. Every guardrail fails
 * closed: unknown activity, lifetime or disk evidence retains capacity. A
 * nonzero minimum capacity is an explicit opt-in and scales in only to that
 * floor.
 */
export function evaluateComputeScaleIn(input: ComputeScaleInEvidence): ComputeScaleInDecision {
  const now = resolveEpoch(input.now);
  const current = input.capacity.current;
  const retain = (code: string, message: string, reasons: string[]): ComputeScaleInDecision => ({
    allowed: false,
    action: 'retain',
    targetCapacity: typeof current === 'number' ? current : 0,
    code,
    message,
    reasons,
  });

  if (typeof current !== 'number' || !Number.isInteger(current) || current < 0) {
    return retain('scale.capacity-unknown', 'current capacity is unknown; retain capacity', ['capacity']);
  }
  if (current === 0) {
    return {
      allowed: true,
      action: 'scale-to-zero',
      targetCapacity: 0,
      code: 'scale.zero',
      message: 'capacity is already zero',
      reasons: [],
    };
  }
  if (input.busy !== false && input.busy !== 0) {
    return retain('scale.busy', 'busy evidence prevents scale-in', ['busy']);
  }
  if (input.leaseActive !== false) {
    return retain('scale.lease-active', 'lease state is active or unknown; retain capacity', ['lease']);
  }
  if (input.queuedWork !== 0) {
    return retain('scale.queued-work', 'queued work is present or unknown; retain capacity', ['queuedWork']);
  }
  if (!isTimestamp(input.idleSince)
    || !(typeof input.idleTimeoutMs === 'number' && Number.isFinite(input.idleTimeoutMs) && input.idleTimeoutMs >= 0)) {
    return retain('scale.idle-unknown', 'idle expiry evidence is invalid or unknown; retain capacity', ['idle']);
  }
  if (now - Date.parse(input.idleSince) < input.idleTimeoutMs) {
    return retain('scale.idle-not-expired', 'idle expiry has not elapsed', ['idle']);
  }
  if (!isTimestamp(input.startedAt)
    || !(typeof input.minimumLifetimeMs === 'number'
      && Number.isFinite(input.minimumLifetimeMs)
      && input.minimumLifetimeMs >= 0)) {
    return retain('scale.lifetime-unknown', 'lifetime evidence is invalid or unknown; retain capacity', ['lifetime']);
  }
  if (now - Date.parse(input.startedAt) < input.minimumLifetimeMs) {
    return retain('scale.lifetime', 'minimum lifetime has not elapsed', ['lifetime']);
  }
  if (!(typeof input.diskUsedPercent === 'number' && Number.isFinite(input.diskUsedPercent))
    || !(typeof input.diskLimitPercent === 'number' && Number.isFinite(input.diskLimitPercent) && input.diskLimitPercent >= 0)) {
    return retain('scale.disk-unknown', 'disk evidence is invalid or unknown; retain capacity', ['disk']);
  }
  if (input.diskUsedPercent > input.diskLimitPercent) {
    return retain('scale.disk', 'disk usage exceeds the scale-in guardrail', ['disk']);
  }

  const targetCapacity = input.capacity.min > 0 ? input.capacity.min : 0;
  if (targetCapacity > 0) {
    return {
      allowed: true,
      action: 'scale-in',
      targetCapacity,
      code: 'scale.minimum',
      message: 'idle resource scales in to its explicit minimum capacity',
      reasons: [],
    };
  }
  return {
    allowed: true,
    action: 'scale-to-zero',
    targetCapacity: 0,
    code: 'scale.zero',
    message: 'idle resource scales to zero',
    reasons: [],
  };
}

/** Alias naming the downward direction rather than the operation. */
export const evaluateComputeScaleDown = evaluateComputeScaleIn;
