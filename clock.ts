// ---------------------------------------------------------------------------
// The one place Junior reads wall-clock time or schedules timers (#265).
//
// Production modules take an optional `clock` (defaulting to `systemClock`)
// instead of calling `Date.now()`, `new Date()`, `setTimeout` or `setInterval`
// directly, so tests can substitute a `ManualClock` and move time forward
// explicitly rather than sleeping or racing real deadlines. A guard test keeps
// the global timing APIs out of every other production module.
// ---------------------------------------------------------------------------

/** An opaque handle for a scheduled callback. */
export interface ClockTimer {
  /** Do not keep the process alive for this timer (no-op on a manual clock). */
  unref(): ClockTimer;
}

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** The current time as a `Date`. */
  date(): Date;
  /** The current time as an ISO-8601 string. */
  iso(): string;
  setTimeout(callback: () => void, ms: number): ClockTimer;
  clearTimeout(timer: ClockTimer | null | undefined): void;
  setInterval(callback: () => void, ms: number): ClockTimer;
  clearInterval(timer: ClockTimer | null | undefined): void;
  /** Resolve after `ms`; rejects with the signal's reason if it aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

type NodeTimer = ReturnType<typeof globalThis.setTimeout>;

class SystemTimer implements ClockTimer {
  readonly handle: NodeTimer;
  constructor(handle: NodeTimer) {
    this.handle = handle;
  }
  unref(): ClockTimer {
    const handle = this.handle as { unref?: () => unknown };
    if (typeof handle.unref === 'function') handle.unref();
    return this;
  }
}

function sleepWith(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clock.clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = clock.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The real clock: system time and Node timers. */
export const systemClock: Clock = {
  now: () => Date.now(),
  date: () => new Date(),
  iso: () => new Date().toISOString(),
  setTimeout: (callback, ms) => new SystemTimer(globalThis.setTimeout(callback, ms)),
  clearTimeout: (timer) => {
    if (timer instanceof SystemTimer) globalThis.clearTimeout(timer.handle);
  },
  setInterval: (callback, ms) => new SystemTimer(globalThis.setInterval(callback, ms)),
  clearInterval: (timer) => {
    if (timer instanceof SystemTimer) globalThis.clearInterval(timer.handle);
  },
  sleep: (ms, signal) => sleepWith(systemClock, ms, signal),
};

type Scheduled = {
  id: number;
  due: number;
  callback: () => void;
  interval: number | null;
};

class ManualTimer implements ClockTimer {
  readonly id: number;
  constructor(id: number) {
    this.id = id;
  }
  unref(): ClockTimer {
    return this;
  }
}

/** A clock whose time only moves when a test advances it. */
export interface ManualClock extends Clock {
  /** Set the current time without running any timers. */
  set(time: number | string | Date): void;
  /**
   * Move time forward by `ms`, running every timer that falls due in order of
   * due time (ties in scheduling order). Callbacks run synchronously.
   */
  advance(ms: number): void;
  /**
   * Like `advance`, but lets pending promise reactions settle before and after
   * each timer fires, so async code chained on a timer observes it.
   */
  advanceAsync(ms: number): Promise<void>;
  /** Advance straight to the next due timer and run it; false when none is pending. */
  runNext(): boolean;
  /** Advance (async) until no timers remain, or `limit` timers have fired. */
  runAll(limit?: number): Promise<number>;
  /** Number of scheduled timers that have not fired or been cleared. */
  pending(): number;
}

function toMs(time: number | string | Date): number {
  if (typeof time === 'number') return time;
  const ms = (typeof time === 'string' ? new Date(time) : time).getTime();
  if (!Number.isFinite(ms)) throw new RangeError(`invalid clock time: ${String(time)}`);
  return ms;
}

/** Let queued promise reactions (and their follow-ups) run. */
async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

export function createManualClock(start: number | string | Date = 0): ManualClock {
  let current = toMs(start);
  let nextId = 1;
  const timers = new Map<number, Scheduled>();

  const schedule = (callback: () => void, ms: number, repeat: boolean): ClockTimer => {
    const delay = Math.max(0, Number.isFinite(ms) ? ms : 0);
    const id = nextId;
    nextId += 1;
    timers.set(id, { id, due: current + delay, callback, interval: repeat ? Math.max(1, delay) : null });
    return new ManualTimer(id);
  };
  const cancel = (timer: ClockTimer | null | undefined) => {
    if (timer instanceof ManualTimer) timers.delete(timer.id);
  };
  const nextDue = (until: number): Scheduled | null => {
    let best: Scheduled | null = null;
    for (const entry of timers.values()) {
      if (entry.due > until) continue;
      if (!best || entry.due < best.due || (entry.due === best.due && entry.id < best.id)) best = entry;
    }
    return best;
  };
  const fire = (entry: Scheduled) => {
    current = Math.max(current, entry.due);
    if (entry.interval === null) timers.delete(entry.id);
    else entry.due += entry.interval;
    entry.callback();
  };

  const clock: ManualClock = {
    now: () => current,
    date: () => new Date(current),
    iso: () => new Date(current).toISOString(),
    setTimeout: (callback, ms) => schedule(callback, ms, false),
    clearTimeout: cancel,
    setInterval: (callback, ms) => schedule(callback, ms, true),
    clearInterval: cancel,
    sleep: (ms, signal) => sleepWith(clock, ms, signal),
    set: (time) => {
      current = toMs(time);
    },
    advance: (ms) => {
      const until = current + Math.max(0, ms);
      for (let entry = nextDue(until); entry; entry = nextDue(until)) fire(entry);
      current = until;
    },
    advanceAsync: async (ms) => {
      const until = current + Math.max(0, ms);
      await flushMicrotasks();
      for (let entry = nextDue(until); entry; entry = nextDue(until)) {
        fire(entry);
        await flushMicrotasks();
      }
      current = until;
      await flushMicrotasks();
    },
    runNext: () => {
      const entry = nextDue(Number.POSITIVE_INFINITY);
      if (!entry) return false;
      fire(entry);
      return true;
    },
    runAll: async (limit = 10_000) => {
      let fired = 0;
      await flushMicrotasks();
      while (fired < limit && clock.runNext()) {
        fired += 1;
        await flushMicrotasks();
      }
      return fired;
    },
    pending: () => timers.size,
  };
  return clock;
}
