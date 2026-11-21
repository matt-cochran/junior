/**
 * Typed policy events (#281). A guard that refuses, or marks evidence stale,
 * records one event on the run; the result carries them as `policyEvents` and
 * the compact receipt as `policy`. Recording never changes the run's status by
 * itself: the guard that records an event decides what it refuses.
 */

export type PolicyEventKind =
  | 'no_build_after_failed_build'
  | 'no_build_without_build'
  | 'hook_bypass'
  | 'budget_raise_unapproved'
  | 'consent_change_unapproved';

export type PolicyEventAction = 'refused' | 'flagged_stale' | 'allowed_by_policy';

export interface PolicyEvent {
  kind: PolicyEventKind;
  action: PolicyEventAction;
  /** Where the event came from: a contract check, an isolationSetup command, the worker's bash tool, or the CLI. */
  source: 'check' | 'isolation_setup' | 'worker_bash' | 'cli';
  /** The command (or CLI action) the event is about, as the guard saw it. */
  command: string;
  reason: string;
  /** Index into the contract's checks when source is 'check'. */
  checkIndex?: number;
}

export interface PolicyEventSink {
  policyEvents?: PolicyEvent[];
}

/** Append one event to a run (or any sink) and return it. */
export function recordPolicyEvent(sink: PolicyEventSink, event: PolicyEvent): PolicyEvent {
  (sink.policyEvents ??= []).push(event);
  return event;
}

/** The compact receipt view: counts by kind and action, or null when there were none. */
export function compactPolicyEvents(events: readonly PolicyEvent[] | undefined): {total: number; refused: number; flaggedStale: number; kinds: PolicyEventKind[]} | null {
  if (!events || events.length === 0) return null;
  return {
    total: events.length,
    refused: events.filter((e) => e.action === 'refused').length,
    flaggedStale: events.filter((e) => e.action === 'flagged_stale').length,
    kinds: [...new Set(events.map((e) => e.kind))],
  };
}
