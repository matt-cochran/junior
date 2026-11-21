// Review-queue aging (#280), lane E3.
//
// Lists ready_for_review runs under .delivery that nobody has applied or
// reviewed for longer than a threshold, and fires an optional notify hook
// once per run when one ages past it, so a stalled manager is visible.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { systemClock, type Clock } from './clock.ts';

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

const DEFAULT_AGING_MINUTES = 30;
const NOTIFY_TIMEOUT_MS = 10_000;
const STATE_FILE = 'review-queue.json';

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Throws on an unknown key or a bad value. */
export function validateReviewQueueConfig(value: unknown): void {
  if (!isRecord(value)) throw Error('Invalid reviewQueue (expected an object)');
  for (const key of Object.keys(value)) {
    if (key !== 'agingMinutes' && key !== 'notify') throw Error(`Unknown reviewQueue field: ${key}`);
  }
  if (value.agingMinutes !== undefined) {
    const minutes = value.agingMinutes;
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
      throw Error('Invalid reviewQueue.agingMinutes (expected a finite positive number)');
    }
  }
  if (value.notify !== undefined) {
    const notify = value.notify;
    if (!isRecord(notify)) throw Error('Invalid reviewQueue.notify (expected an object)');
    for (const key of Object.keys(notify)) {
      if (key !== 'command' && key !== 'args') throw Error(`Unknown reviewQueue.notify field: ${key}`);
    }
    if (typeof notify.command !== 'string' || notify.command.trim() === '') {
      throw Error('Invalid reviewQueue.notify.command (expected a non-empty string)');
    }
    if (notify.args !== undefined) {
      if (!Array.isArray(notify.args) || !notify.args.every((arg) => typeof arg === 'string')) {
        throw Error('Invalid reviewQueue.notify.args (expected an array of strings)');
      }
    }
  }
}

/** Read and validate the `reviewQueue` block, or `undefined` when it is absent. */
function readReviewQueueConfig(cwd: string): ReviewQueueConfig | undefined {
  const path = join(cwd, 'delivery.config.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw Error(`delivery.config.json is not valid JSON: ${message(error)}`);
  }
  if (!isRecord(document)) throw Error('delivery.config.json must contain a JSON object');
  const value = document.reviewQueue;
  if (value === undefined || value === null) return undefined;
  validateReviewQueueConfig(value);
  return value as ReviewQueueConfig;
}

type ReviewState = JsonObject & { notified: string[] };

/** Notification state is auxiliary: a missing or malformed file starts empty. */
function readState(deliveryDir: string): ReviewState {
  let raw: string;
  try {
    raw = readFileSync(join(deliveryDir, STATE_FILE), 'utf8');
  } catch {
    return { notified: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { notified: [] };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.notified)) return { notified: [] };
  return {
    ...parsed,
    notified: parsed.notified.filter((id): id is string => typeof id === 'string'),
  };
}

function writeState(deliveryDir: string, state: ReviewState): void {
  mkdirSync(deliveryDir, { recursive: true });
  writeFileSync(join(deliveryDir, STATE_FILE), JSON.stringify(state, null, 2) + '\n');
}

/** The run end time: `runtime.finishedAt` when it parses, else the result file mtime. */
function runEnd(result: JsonObject, resultPath: string): { ms: number; finishedAt: string } {
  const runtime = result.runtime;
  const finished = isRecord(runtime) ? runtime.finishedAt : undefined;
  if (typeof finished === 'string' && finished.trim() !== '') {
    const ms = Date.parse(finished);
    if (Number.isFinite(ms)) return { ms, finishedAt: finished };
  }
  try {
    const ms = statSync(resultPath).mtimeMs;
    return { ms, finishedAt: new Date(ms).toISOString() };
  } catch {
    return { ms: 0, finishedAt: new Date(0).toISOString() };
  }
}

/** ready_for_review runs under `deliveryDir` older than the threshold, oldest first. Applied runs are excluded. */
export function agingReviews(opts: { deliveryDir: string; agingMinutes: number; clock?: Clock }): AgingReview[] {
  const now = (opts.clock ?? systemClock).now();
  const thresholdMs = opts.agingMinutes * 60_000;
  let idEntries: Dirent[];
  try {
    idEntries = readdirSync(opts.deliveryDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: { endMs: number; review: AgingReview }[] = [];
  for (const idEntry of idEntries) {
    if (!idEntry.isDirectory()) continue;
    const id = idEntry.name;
    if (!id || id === '.' || id === '..') continue;
    const idDir = join(opts.deliveryDir, id);
    let stampEntries: Dirent[];
    try {
      stampEntries = readdirSync(idDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const stamps = stampEntries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(a) - Number(b));
    const applied = new Set(stamps.filter((stamp) => existsSync(join(idDir, stamp, 'applied.json'))));

    for (const stamp of stamps) {
      const dir = join(idDir, stamp);
      const resultPath = join(dir, 'result.json');
      let result: unknown;
      try {
        result = JSON.parse(readFileSync(resultPath, 'utf8'));
      } catch {
        continue;
      }
      if (!isRecord(result) || result.status !== 'ready_for_review') continue;
      if (applied.has(stamp)) continue;
      if (stamps.some((other) => Number(other) > Number(stamp) && applied.has(other))) continue;

      const end = runEnd(result, resultPath);
      const ageMs = now - end.ms;
      if (!(ageMs > thresholdMs)) continue;
      found.push({
        endMs: end.ms,
        review: {
          id,
          resultPath,
          status: 'ready_for_review',
          finishedAt: end.finishedAt,
          ageMinutes: Math.floor(ageMs / 60_000),
          next: `junior apply ${resultPath}`,
        },
      });
    }
  }

  found.sort((a, b) =>
    a.endMs - b.endMs
    || a.review.id.localeCompare(b.review.id)
    || a.review.resultPath.localeCompare(b.review.resultPath));
  return found.map((entry) => entry.review);
}

/** Run the notify argv with the review JSON on stdin. Returns an error message, or null on success. */
function notify(review: AgingReview, hook: { command: string; args?: string[] }, spawn: typeof spawnSync): string | null {
  let child: ReturnType<typeof spawnSync>;
  try {
    child = spawn(hook.command, hook.args ?? [], {
      input: JSON.stringify(review),
      encoding: 'utf8',
      timeout: NOTIFY_TIMEOUT_MS,
      shell: false,
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    return message(error);
  }
  if (child.error) return message(child.error);
  if (child.status !== 0) {
    const stderr = child.stderr ? String(child.stderr).trim() : '';
    return stderr || `notify exited ${child.status ?? 'unknown'}`;
  }
  return null;
}

/** List aged runs and notify each one not notified before (state kept in `<deliveryDir>/review-queue.json`). */
export function reviewQueue(opts: { cwd: string; config?: ReviewQueueConfig; clock?: Clock; spawn?: typeof import('node:child_process').spawnSync }): ReviewQueueReport {
  const config = opts.config !== undefined ? opts.config : readReviewQueueConfig(opts.cwd);
  if (config !== undefined) validateReviewQueueConfig(config);
  const agingMinutes = config?.agingMinutes ?? DEFAULT_AGING_MINUTES;
  const deliveryDir = join(opts.cwd, '.delivery');
  const aging = agingReviews({ deliveryDir, agingMinutes, clock: opts.clock });
  const state = readState(deliveryDir);
  const agingPaths = new Set(aging.map((review) => review.resultPath));
  const retained = state.notified.filter((path) => agingPaths.has(path));
  const notifiedPaths = new Set(retained);
  let stateChanged = retained.length !== state.notified.length;
  const notified: string[] = [];
  const notifyErrors: { id: string; error: string }[] = [];
  const newlyNotified: AgingReview[] = [];

  if (config?.notify) {
    const spawn = opts.spawn ?? spawnSync;
    const attempted = new Set<string>();
    for (const review of aging) {
      if (notifiedPaths.has(review.resultPath) || attempted.has(review.resultPath)) continue;
      attempted.add(review.resultPath);
      const error = notify(review, config.notify, spawn);
      if (error) {
        notifyErrors.push({ id: review.id, error });
        continue;
      }
      notifiedPaths.add(review.resultPath);
      notified.push(review.resultPath);
      newlyNotified.push(review);
      stateChanged = true;
    }
  }

  if (stateChanged) {
    try {
      writeState(deliveryDir, { ...state, notified: [...notifiedPaths] });
    } catch (writeError) {
      for (const review of newlyNotified) {
        notifyErrors.push({ id: review.id, error: `could not record notification: ${message(writeError)}` });
      }
    }
  }

  return { agingMinutes, aging, notified, notifyErrors };
}
