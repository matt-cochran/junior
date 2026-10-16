// ---------------------------------------------------------------------------
// Pi bash guard (junior issue #42).
//
// A bash command that reads stdin can block a live Pi run until Junior's
// per-tool watchdog kills the whole process group. This extension rewrites the
// model's bash input before execution so the command reads stdin from
// /dev/null and carries a timeout that fires before Junior's backstop.
//
// The input rewrite is exported as a pure function so it can be unit tested
// without loading Pi. Pi loads the default export via `pi -e <path>`.
// ---------------------------------------------------------------------------

/** Everything `guardBashInput` may read from the environment. */
export type GuardEnv = Record<string, string | undefined>;

/** Parse `JUNIOR_PI_BASH_TIMEOUT_S` as a positive whole number of seconds.
 * Anything else (absent, blank, zero, negative, fractional, non-numeric)
 * yields null so a bad value never overrides the model's own timeout. */
export function parseBashTimeoutSeconds(env: GuardEnv | undefined): number | null {
 const raw = env?.JUNIOR_PI_BASH_TIMEOUT_S;
 if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
 const seconds = Number(raw);
 return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

/** Rewrite a bash tool input in place: stdin comes from /dev/null, and when
 * `JUNIOR_PI_BASH_TIMEOUT_S` is a positive integer the timeout becomes the
 * smaller of the model's timeout and that bound. Non-bash input (no string
 * `command`) is returned untouched. */
export function guardBashInput<T>(input: T, env: GuardEnv | undefined = process.env): T {
 if (!input || typeof input !== 'object') return input;
 const target = input as Record<string, any>;
 if (typeof target.command !== 'string') return input;
 target.command = `exec </dev/null\n${target.command}`;
 const bound = parseBashTimeoutSeconds(env);
 if (bound !== null) {
  const model = typeof target.timeout === 'number' && Number.isFinite(target.timeout) && target.timeout > 0 ? target.timeout : null;
  target.timeout = model !== null ? Math.min(model, bound) : bound;
 }
 return input;
}

/** Pi extension entry point: rewrite every bash `tool_call` before execution. */
export default function (pi: any): void {
 pi.on('tool_call', (event: any) => {
  if (event && event.toolName === 'bash') event.input = guardBashInput(event.input, process.env);
 });
}
