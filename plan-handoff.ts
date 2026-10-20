// ---------------------------------------------------------------------------
// cpm plan lease around a Junior handoff run.
//
// `withPlanLease` is the single point that claims a cpm deliverable before a
// handoff starts and records its progress after it finishes: it acquires a
// one-deliverable cohort (`plan.acquire_cohort`), runs the handoff, then marks
// the deliverable `in_progress` on success or `failed` on failure
// (`plan.mark_status`). The lease is left for the manager to accept; a failing
// mark is recorded in `plan.error` without discarding the run result.
//
// The cpm calls are injected so the wrapper stays offline and testable. The
// lease is deliberately not released here: acceptance is a manager action.
// ---------------------------------------------------------------------------

import { cohortDeliverableIds, planLocks, strictItems } from './companion-shapes.ts';

export type PlanHopResult = { ok: boolean; result?: any; error?: { message: string } };

export type PlanHop = (
  tool: 'cpm',
  request: { tool: string; arguments: Record<string, unknown> },
) => Promise<PlanHopResult>;

export interface PlanLeaseTask {
  id: string;
  plan: { id: string; deliverable: string; callerId?: string };
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
    marked: 'in_progress' | 'failed' | null;
    reentered?: boolean;
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

function effortHours(startedAt: number, endedAt: number): number {
  return Math.max(0.01, Math.round(((endedAt - startedAt) / 3_600_000) * 100) / 100);
}

/** Deliverable locks from a cpm `plan.status` response; throws `ShapeError` when unrecognized. */
function lockHolders(result: unknown): Array<{ deliverableId: string; callerId: string }> {
  return strictItems(planLocks(result), 'cpm', 'plan.status', result).map((lock) => ({
    deliverableId: lock.deliverableId,
    callerId: lock.callerId,
  }));
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

  const ttlSeconds = Math.ceil(deps.deadlineMs / 1000) + 3600;
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
    let held: { deliverableId: string; callerId: string } | undefined;
    try {
      held = status.ok
        ? lockHolders(status.result).find((lock) => lock.deliverableId === plan.deliverable)
        : undefined;
    } catch (error) {
      plan.error = `plan.status failed: ${messageOf(error)}`;
      return { plan };
    }
    if (!held || held.callerId !== callerId) {
      plan.error = held
        ? `plan.acquire_cohort did not lease ${plan.deliverable}; held by ${held.callerId}`
        : `plan.acquire_cohort did not lease ${plan.deliverable}`;
      return { plan };
    }
    plan.reentered = true;
  }
  plan.leased = true;

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
          actual_effort_hours: effortHours(startedAt, now()),
          evidence: evidenceLine(summary),
        },
      });
      if (!response.ok) plan.error = `plan.mark_status failed: ${response.error?.message ?? 'unknown error'}`;
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

  const summary = deps.summarize(result);
  if (summary.hold) return { result, plan };
  if (summary.success) {
    await mark('in_progress', summary);
    return { result, plan };
  }
  await mark('failed', summary, summary.reason ?? 'run reported failure');
  return { result, plan };
}
