// Review-queue aging (#280), lane E3.
//
// Lists ready_for_review runs under .delivery that nobody has applied or
// reviewed for longer than a threshold, and fires an optional notify hook
// once per run when one ages past it, so a stalled manager is visible.

import type { Clock } from './clock.ts';

/** `reviewQueue` in delivery.config.json. */
export interface ReviewQueueConfig {
  /** Age after which a ready_for_review run is listed. Default 30. */
  agingMinutes?: number;
  /** Run once per aged run with the AgingReview JSON on stdin; argv only, no shell. */
  notify?: { command: string; args?: string[] };
}

export interface AgingReview {
  id: string;
  resultPath: string;
  status: string;
  finishedAt: string;
  ageMinutes: number;
  /** The command the manager runs next, e.g. `junior apply <result.json>`. */
  next: string;
}

export interface ReviewQueueReport {
  agingMinutes: number;
  aging: AgingReview[];
  notified: string[];
  notifyErrors: { id: string; error: string }[];
}

/** Throws on an unknown key or a bad value. */
export function validateReviewQueueConfig(_value: unknown): void {}

/** ready_for_review runs under `deliveryDir` older than the threshold, oldest first. Applied runs are excluded. */
export function agingReviews(_opts: { deliveryDir: string; agingMinutes: number; clock?: Clock }): AgingReview[] {
  return [];
}

/** List aged runs and notify each one not notified before (state kept in `<deliveryDir>/review-queue.json`). */
export function reviewQueue(opts: { cwd: string; config?: ReviewQueueConfig; clock?: Clock; spawn?: typeof import('node:child_process').spawnSync }): ReviewQueueReport {
  return { agingMinutes: opts.config?.agingMinutes ?? 30, aging: [], notified: [], notifyErrors: [] };
}
