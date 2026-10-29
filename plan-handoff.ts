// ---------------------------------------------------------------------------
// cpm plan lease around a Junior handoff run.
//
// `withPlanLease` is the single point that claims a cpm deliverable before a
// handoff starts and records its progress after it finishes: it acquires a
// one-deliverable cohort (`plan.acquire_cohort`), runs the handoff, then marks
// the deliverable `in_progress` on success or `failed` on failure
// (`plan.mark_status`). A Failed deliverable is returned to Ready through the
// supported audited lockless mark before it is re-leased. Completed work has no
// lockless complete -> ready path: it must be revised/reopened in the CPM plan
// graph first, then leased and rereviewed. An active lease held by another
// caller is always refused. The lease is left for the manager to accept; a
// failing mark is recorded in `plan.error` without discarding the run result.
//
// The cpm calls are injected so the wrapper stays offline and testable. The
// lease is deliberately not released here: acceptance is a manager action.
// ---------------------------------------------------------------------------

import { cohortDeliverableIds, planLocks, planStatusRows, strictItems } from './companion-shapes.ts';

/** Outcomes that stop a run to wait for the manager or the human: the lease is
 * kept (a rerun by the same caller is re-entrant) and the deliverable is not
 * marked failed. */
export const HOLD_OUTCOMES: readonly string[] = ['needs_answers', 'needs_choice', 'needs_model_approval'];

export function isHoldOutcome(status: unknown): boolean {
  return typeof status === 'string' && HOLD_OUTCOMES.includes(status);
}

/** A run refused before any worker started: blocked, with no segment and no
 * observed model. Such a run keeps its lease instead of being marked failed,
 * so the same contract can be re-run once the manager clears the blocker. */
export function runNeverStarted(result: any): boolean {
  if (!result || typeof result !== 'object') return false;
  if (result.runtime?.stopReason !== 'blocked') return false;
  const segments = result.segments;
  const segmentCount = Array.isArray(segments) ? segments.length : segments;
  if (segmentCount !== 0 && segmentCount != null) return false;
  const observed = result.model?.observed;
  if (observed == null) return true;
  return Array.isArray(observed) && observed.length === 0;
}

export type PlanHopResult = { ok: boolean; result?: any; revision?: number; error?: { message: string } };

export type PlanHop = (
  tool: 'cpm',
  request: { tool: string; arguments: Record<string, unknown> },
) => Promise<PlanHopResult>;

export interface PlanLeaseTask {
  id: string;
  plan: { id: string; deliverable: string; callerId?: string };
  /** The Hop revision the contract was written against. The lease call itself
   * advances the Hop, so it is refreshed after every Junior-owned call before
   * the run starts. A revision jump Junior did not produce is rejected. */
  hopRevision?: number;
  /** The integrity-checked context a contract may carry instead of hopRevision. */
  hopContext?: { revision?: number | null };
}

export interface PlanLeaseSummary {
  success: boolean;
  artifactDir?: string;
  outcome?: string;
  model?: string;
  reason?: string;
  /** The run paused for more input; the lease is kept and nothing is marked. */
  hold?: boolean;
}

export interface PlanLeaseDeps<R> {
  callHop: PlanHop;
  deadlineMs: number;
  now?: () => number;
  summarize: (result: R) => PlanLeaseSummary;
}

export interface PlanLeaseOutcome<R> {
  result?: R;
  plan: {
    id: string;
    deliverable: string;
    leased: boolean;
    marked: 'in_progress' | 'failed' | 'ready' | null;
    reentered?: boolean;
    /** A failed deliverable was returned to ready through the supported cpm
     * lifecycle before this lease. */
    retried?: boolean;
    /** The failure reason carried into the retry evidence. */
    retryReason?: string;
    /** The Hop revision the run should be checked against after the lease. */
    revision?: number;
    error?: string;
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  const text = String(error ?? '');
  return text || 'unknown error';
}

/** Deliverable ids from a cpm cohort response; throws `ShapeError` when unrecognized. */
function cohortIds(result: unknown): string[] {
  return strictItems(cohortDeliverableIds(result), 'cpm', 'plan.acquire_cohort', result);
}

function effortHours(startedAt: number, endedAt: number, prior = 0): number {
  const total = Math.max(0, prior) + Math.max(0, endedAt - startedAt) / 3_600_000;
  return Math.max(0.01, Math.round(total * 100) / 100);
}

function actualHours(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The reported CPM actual effort for one deliverable, if the read exposes it. */
function deliverableActualHours(result: unknown, deliverableId: string): number | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const raw = result as any;
  const rows = Array.isArray(raw.rows) ? raw.rows : Array.isArray(raw.deliverables) ? raw.deliverables : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = Array.isArray(row) ? String(row[0] ?? '') : String(row.id ?? row.deliverable_id ?? row.deliverableId ?? '');
    if (id !== deliverableId) continue;
    const item = Array.isArray(row) ? row[1] : row;
    if (!item || typeof item !== 'object') continue;
    const hours = actualHours(item.actual_effort_hours)
      ?? actualHours(item.actualEffortHours)
      ?? actualHours(item.ac)
      ?? actualHours(item.actual_cost);
    if (hours !== undefined) return hours;
  }
  const actuals = raw.actuals;
  if (actuals && typeof actuals === 'object' && !Array.isArray(actuals)) {
    const item = actuals[deliverableId];
    if (item && typeof item === 'object') {
      return actualHours(item.actual_effort_hours) ?? actualHours(item.actualEffortHours) ?? actualHours(item.ac);
    }
  }
  return undefined;
}

/** Deliverable locks from a cpm `plan.status` response; throws `ShapeError` when unrecognized. */
function lockHolders(result: unknown): Array<{ deliverableId: string; callerId: string }> {
  return strictItems(planLocks(result), 'cpm', 'plan.status', result).map((lock) => ({
    deliverableId: lock.deliverableId,
    callerId: lock.callerId,
  }));
}

type DeliverableState = { status: string; reason?: string; actualHours?: number };

/** The status, failure reason and reported actuals of one cpm delivery row. */
function deliverableState(result: unknown, deliverableId: string): DeliverableState | undefined {
  const rows = strictItems(planStatusRows(result), 'cpm', 'plan.status', result);
  const row = rows.find((candidate) => candidate.id === deliverableId);
  if (!row) return undefined;
  const raw = row.raw;
  const item = raw && typeof raw === 'object' ? raw as any : undefined;
  const mark = item?.status ?? item?.mark_status ?? item?.markStatus ?? raw;
  const status = row.status || (typeof mark === 'string' ? mark : mark?.status) || '';
  const reason = mark && typeof mark === 'object'
    ? typeof mark.reason === 'string' ? mark.reason.trim() : ''
    : typeof item?.reason === 'string' ? item.reason.trim() : '';
  const hours = actualHours(item?.actual_effort_hours)
    ?? actualHours(item?.actualEffortHours)
    ?? (mark && typeof mark === 'object'
      ? actualHours(mark.actual_effort_hours) ?? actualHours(mark.actualEffortHours)
      : undefined);
  return {
    status: String(status).toLowerCase(),
    ...(reason ? { reason } : {}),
    ...(hours !== undefined ? { actualHours: hours } : {}),
  };
}

/** cpm evidence for a lockless Ready handback that keeps the failed reason. */
function retryEvidence(reason: string): string {
  return `retry after failure: ${reason}`.slice(0, 2048);
}

/** One line describing where the run landed, its outcome and its model. */
function evidenceLine(summary?: PlanLeaseSummary): string {
  return [
    `artifactDir=${summary?.artifactDir ?? 'none'}`,
    `outcome=${summary?.outcome ?? 'unknown'}`,
    `model=${summary?.model ?? 'unknown'}`,
  ].join(' ');
}

/**
 * Claim `task.plan.deliverable` from `task.plan.id`, run the handoff, and record
 * its outcome. When the lease is denied the run is skipped and `plan.leased` is
 * false with an explanation in `plan.error`.
 */
export async function withPlanLease<R>(
  task: PlanLeaseTask,
  run: () => Promise<R>,
  deps: PlanLeaseDeps<R>,
): Promise<PlanLeaseOutcome<R>> {
  const now = deps.now ?? Date.now;
  const callerId = task.plan.callerId ?? 'junior-worker';
  const plan: PlanLeaseOutcome<R>['plan'] = {
    id: task.plan.id,
    deliverable: task.plan.deliverable,
    leased: false,
    marked: null,
  };

  const contextRevision = task.hopContext?.revision;
  const baselineRevision = typeof task.hopRevision === 'number' && Number.isInteger(task.hopRevision) && task.hopRevision >= 0
    ? task.hopRevision
    : typeof contextRevision === 'number' && Number.isInteger(contextRevision) && contextRevision >= 0
      ? contextRevision
      : undefined;
  // Junior owns the revisions its own calls produce. The acquire is not sent an
  // expectedRevision (cpm 0.4.3 rejects the unknown field), so any call that
  // advances the HOP by more than the single step we asked for is an external
  // mutation and fails the handoff closed.
  let ownRevision = baselineRevision;
  const noteRevision = (response: PlanHopResult, tool: string): string | undefined => {
    if (typeof response.revision !== 'number') return undefined;
    if (ownRevision !== undefined && response.revision !== ownRevision + 1) {
      return `HOP revision changed outside this handoff: ${tool} returned revision ${response.revision}; expected ${ownRevision + 1}`;
    }
    ownRevision = response.revision;
    task.hopRevision = response.revision;
    if (task.hopContext) task.hopContext.revision = response.revision;
    return undefined;
  };
  const ttlSeconds = Math.ceil(deps.deadlineMs / 1000) + 3600;
  let priorActualHours = 0;
  let acquired: PlanHopResult;
  try {
    acquired = await deps.callHop('cpm', {
      tool: 'plan.acquire_cohort',
      arguments: {
        plan_id: plan.id,
        caller_id: callerId,
        ids: [plan.deliverable],
        max_count: 1,
        ttl_seconds: ttlSeconds,
      },
    });
  } catch (error) {
    plan.error = `plan.acquire_cohort failed: ${messageOf(error)}`;
    return { plan };
  }
  if (!acquired.ok) {
    plan.error = `plan.acquire_cohort failed: ${acquired.error?.message ?? 'unknown error'}`;
    return { plan };
  }
  const acquiredRevisionError = noteRevision(acquired, 'plan.acquire_cohort');
  if (acquiredRevisionError) {
    plan.error = acquiredRevisionError;
    return { plan };
  }
  let leasedIds: string[];
  try {
    leasedIds = cohortIds(acquired.result);
  } catch (error) {
    plan.error = `plan.acquire_cohort failed: ${messageOf(error)}`;
    return { plan };
  }
  if (!leasedIds.includes(plan.deliverable)) {
    let status: PlanHopResult;
    try {
      status = await deps.callHop('cpm', {
        tool: 'plan.status',
        arguments: { plan_id: plan.id },
      });
    } catch {
      status = { ok: false };
    }
    const statusRevisionError = noteRevision(status, 'plan.status');
    if (statusRevisionError) {
      plan.error = statusRevisionError;
      return { plan };
    }
    let held: { deliverableId: string; callerId: string } | undefined;
    try {
      held = status.ok
        ? lockHolders(status.result).find((lock) => lock.deliverableId === plan.deliverable)
        : undefined;
    } catch (error) {
      plan.error = `plan.status failed: ${messageOf(error)}`;
      return { plan };
    }
    if (held && held.callerId !== callerId) {
      plan.error = `plan.acquire_cohort did not lease ${plan.deliverable}; held by ${held.callerId}`;
      return { plan };
    }
    if (held) {
      if (typeof status.revision === 'number') acquired = { ...acquired, revision: status.revision };
      plan.reentered = true;
    } else {
      let state: DeliverableState | undefined;
      try {
        state = status.ok ? deliverableState(status.result, plan.deliverable) : undefined;
      } catch (error) {
        plan.error = `plan.status failed: ${messageOf(error)}`;
        return { plan };
      }
      if (state?.status === 'complete') {
        // cpm deliberately has no lockless complete -> ready transition. The
        // manager first revises/reopens the graph, then the reopened work is
        // leased and rereviewed; never rewrite a completed status here.
        plan.error = `plan.acquire_cohort did not lease ${plan.deliverable}; completed work must be revised/reopened before a new lease`;
        return { plan };
      }
      const reason = state?.status === 'failed'
        ? state.reason ?? 'failure reason not recorded'
        : undefined;
      if (reason === undefined) {
        plan.error = `plan.acquire_cohort did not lease ${plan.deliverable}`;
        return { plan };
      }
      priorActualHours = state?.actualHours ?? 0;
      // cpm 0.4.3 supports Failed -> Ready only as an audited lockless mark;
      // return the deliverable through that lifecycle, never by inventing a
      // lease or a direct status write. Completed work is not handled here.
      let ready: PlanHopResult;
      try {
        ready = await deps.callHop('cpm', {
          tool: 'plan.mark_status',
          arguments: {
            caller_id: callerId,
            plan_id: plan.id,
            deliverable_id: plan.deliverable,
            status: { status: 'ready' },
            evidence: retryEvidence(reason),
          },
        });
      } catch (error) {
        plan.error = `plan.mark_status failed: ${messageOf(error)}`;
        return { plan };
      }
      if (!ready.ok) {
        plan.error = `plan.mark_status failed: ${ready.error?.message ?? 'unknown error'}`;
        return { plan };
      }
      const readyRevisionError = noteRevision(ready, 'plan.mark_status');
      if (readyRevisionError) {
        plan.error = readyRevisionError;
        return { plan };
      }
      let retried: PlanHopResult;
      try {
        retried = await deps.callHop('cpm', {
          tool: 'plan.acquire_cohort',
          arguments: {
            plan_id: plan.id,
            caller_id: callerId,
            ids: [plan.deliverable],
            max_count: 1,
            ttl_seconds: ttlSeconds,
          },
        });
      } catch (error) {
        plan.error = `plan.acquire_cohort failed: ${messageOf(error)}`;
        return { plan };
      }
      if (!retried.ok) {
        plan.error = `plan.acquire_cohort failed: ${retried.error?.message ?? 'unknown error'}`;
        return { plan };
      }
      const retriedRevisionError = noteRevision(retried, 'plan.acquire_cohort');
      if (retriedRevisionError) {
        plan.error = retriedRevisionError;
        return { plan };
      }
      let retriedIds: string[];
      try {
        retriedIds = cohortIds(retried.result);
      } catch (error) {
        plan.error = `plan.acquire_cohort failed: ${messageOf(error)}`;
        return { plan };
      }
      if (!retriedIds.includes(plan.deliverable)) {
        plan.error = `plan.acquire_cohort did not lease ${plan.deliverable} after returning it to ready`;
        return { plan };
      }
      acquired = retried;
      plan.retried = true;
      plan.retryReason = reason;
    }
  }
  // The run is checked against the revision the lease left behind, not the
  // pre-lease revision that the lease itself invalidated.
  if (typeof acquired.revision === 'number') plan.revision = acquired.revision;
  plan.leased = true;
  // A refusal after the lease and before the run hands the deliverable back to
  // Ready, so a pre-worker stop never leaves a stray lease behind.
  const releaseLease = async (reason: string): Promise<void> => {
    try {
      await deps.callHop('cpm', {
        tool: 'plan.mark_status',
        arguments: {
          caller_id: callerId,
          plan_id: plan.id,
          deliverable_id: plan.deliverable,
          status: { status: 'ready' },
          evidence: `handoff ${task.id} stopped before its run: ${reason}`.slice(0, 2048),
        },
      });
      plan.marked = 'ready';
    } catch {
      // The original refusal is already recorded in plan.error.
    }
  };

  // A correction mark reports total effort, not just this run: CPM keeps the
  // original actuals through a retry or an explicit revise/reopen. Read them
  // after the lease (a read must not race the acquire baseline) and add this
  // run's wall hours without replacing the earlier work. An unavailable EV
  // read is not fatal; the status row may still carry the prior actuals.
  try {
    const ev = await deps.callHop('cpm', { tool: 'plan.ev', arguments: { plan_id: plan.id } });
    // A failed plan.ev can still advance the Hop, so its revision is noted on
    // every response. A foreign jump here returns the lease before refusing.
    const evRevisionError = noteRevision(ev, 'plan.ev');
    if (evRevisionError) {
      plan.error = evRevisionError;
      await releaseLease(evRevisionError);
      return { plan };
    }
    if (ev.ok) {
      const previous = deliverableActualHours(ev.result, plan.deliverable);
      if (previous !== undefined) priorActualHours = Math.max(priorActualHours, previous);
    }
  } catch {
    // plan.ev is optional for a plan that has not been baselined yet.
  }

  const startedAt = now();
  const mark = async (
    marked: 'in_progress' | 'failed',
    summary: PlanLeaseSummary | undefined,
    reason?: string,
  ): Promise<void> => {
    plan.marked = marked;
    const status = marked === 'failed'
      ? { status: 'failed', ...(reason ? { reason } : {}) }
      : { status: 'in_progress' };
    try {
      const response = await deps.callHop('cpm', {
        tool: 'plan.mark_status',
        arguments: {
          caller_id: callerId,
          plan_id: plan.id,
          deliverable_id: plan.deliverable,
          status,
          actual_effort_hours: effortHours(startedAt, now(), priorActualHours),
          evidence: evidenceLine(summary),
        },
      });
      if (!response.ok) {
        plan.error = `plan.mark_status failed: ${response.error?.message ?? 'unknown error'}`;
      } else {
        const revisionError = noteRevision(response, 'plan.mark_status');
        if (revisionError) plan.error = revisionError;
      }
    } catch (error) {
      plan.error = `plan.mark_status failed: ${messageOf(error)}`;
    }
  };
  const markReady = async (result: R): Promise<void> => {
    plan.marked = 'ready';
    const text = `run ${task.id} never started: ${String((result as any)?.status ?? 'unknown')}`.slice(0, 2048);
    try {
      const response = await deps.callHop('cpm', {
        tool: 'plan.mark_status',
        arguments: {
          caller_id: callerId,
          plan_id: plan.id,
          deliverable_id: plan.deliverable,
          status: { status: 'ready' },
          evidence: text,
        },
      });
      if (!response.ok) {
        plan.error = `plan.mark_status failed: ${response.error?.message ?? 'unknown error'}`;
      } else {
        const revisionError = noteRevision(response, 'plan.mark_status');
        if (revisionError) plan.error = revisionError;
      }
    } catch (error) {
      plan.error = `plan.mark_status failed: ${messageOf(error)}`;
    }
  };

  let result: R;
  try {
    result = await run();
  } catch (error) {
    await mark('failed', { success: false, outcome: 'error' }, messageOf(error));
    throw error;
  }

  if (runNeverStarted(result)) {
    await markReady(result);
    return { result, plan };
  }
  const summary = deps.summarize(result);
  if (summary.hold) return { result, plan };
  if (summary.success) {
    await mark('in_progress', summary);
    return { result, plan };
  }
  await mark('failed', summary, summary.reason ?? 'run reported failure');
  return { result, plan };
}
