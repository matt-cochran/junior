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

import { resolve, relative, isAbsolute, delimiter } from 'node:path';

/** Everything `guardBashInput` may read from the environment. */
export type GuardEnv = Record<string, string | undefined>;

/** True when `target` resolves to `root` itself or a descendant of it. */
function within(root:string, target:string):boolean {
 const rel=relative(resolve(root), resolve(target));
 return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The configured absolute write directories, in order. An absent or blank
 * value means no write restriction. */
function writeRoots(env:GuardEnv|undefined):string[] {
 const raw=env?.JUNIOR_PI_WRITE_ROOTS;
 if (typeof raw !== 'string' || !raw.trim()) return [];
 return raw.split(delimiter).map((p)=>p.trim()).filter(Boolean);
}

/** Enforce worktree isolation at the tool boundary. Returns a blocking
 * instruction for a write/edit outside the configured write roots, or for a
 * bash command that reaches into the source checkout outside `.delivery`.
 * Everything else (including any tool when its guard variable is unset) is
 * allowed via null. */
export function guardPathAccess(toolName:string, input:any, env:GuardEnv, cwd:string):{block:true; reason:string}|null {
 if (toolName === 'write' || toolName === 'edit') {
  const roots=writeRoots(env);
  if (!roots.length) return null;
  const path=input && typeof input === 'object' ? input.path : undefined;
  if (typeof path !== 'string' || !path.trim()) return null;
  const resolved=resolve(cwd, path);
  if (!roots.some((root)=>within(root, resolved))) {
   return { block:true, reason:`Junior isolation: writes are limited to the execution checkout (${roots[0]}); use a relative path.` };
  }
  return null;
 }
 if (toolName === 'bash') {
  const source=env?.JUNIOR_PI_SOURCE_ROOT;
  if (typeof source !== 'string' || !source.trim()) return null;
  const command=input && typeof input === 'object' ? input.command : undefined;
  if (typeof command !== 'string') return null;
  const root=resolve(source);
  const reason='Junior isolation: the source checkout is off limits; run commands inside the execution checkout.';
  for (let at=command.indexOf(root); at !== -1; at=command.indexOf(root, at+root.length)) {
   const next=command.charAt(at+root.length);
   // The bare root (`cd /src`, `"/src"`) is the source checkout itself.
   if (next !== '/') { if (next === '' || !/[\w.-]/.test(next)) return { block:true, reason }; continue; }
   const segment=command.slice(at+root.length+1).split(/[\/\s'"]/)[0];
   if (segment !== '.delivery') return { block:true, reason };
  }
  return null;
 }
 return null;
}

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

/** Pin OpenRouter's upstream provider for a whole Junior deliverable. Pi sends
 * `x-session-id` with `sessionAffinityFormat: openrouter`, which keeps one
 * provider per Pi session; continuation segments, repairs and re-dispatches are
 * new sessions, so the stable `JUNIOR_PI_AFFINITY_KEY` restores affinity. */
export function applyAffinityHeader(headers:Record<string,string|null>, env:GuardEnv|undefined):void {
 const key=env?.JUNIOR_PI_AFFINITY_KEY;
 if (typeof key==='string' && key) headers['x-session-id']=key;
}

/** Merge `JUNIOR_PI_OPENROUTER_ROUTING` (a JSON object) into an object
 * payload's `provider` settings, preserving any existing provider entries. An
 * absent, blank, non-object or malformed value leaves the payload unchanged. */
export function applyProviderRouting(payload:any, env:GuardEnv|undefined):any {
 const raw=env?.JUNIOR_PI_OPENROUTER_ROUTING;
 if (typeof raw!=='string' || !raw.trim()) return payload;
 if (!payload || typeof payload!=='object' || Array.isArray(payload)) return payload;
 let routing:unknown;
 try { routing=JSON.parse(raw); } catch { return payload; }
 if (!routing || typeof routing!=='object' || Array.isArray(routing)) return payload;
 const target=payload as Record<string,any>;
 const provider=target.provider && typeof target.provider==='object' && !Array.isArray(target.provider) ? target.provider : {};
 return {...target, provider:{...provider, ...(routing as Record<string,any>)}};
}

/** Pi extension entry point: pin provider affinity and routing before the
 * request, rewrite every bash `tool_call` before execution, then block a call
 * that would escape the execution checkout. Pi blocks the call when the
 * handler returns `{block:true, reason}`. */
export default function (pi: any): void {
 pi.on('before_provider_headers', (event: any) => { if (event) applyAffinityHeader(event.headers, process.env); });
 pi.on('before_provider_request', (event: any) => event ? applyProviderRouting(event.payload, process.env) : event);
 pi.on('tool_call', (event: any) => {
  if (!event) return;
  if (event.toolName === 'bash') event.input = guardBashInput(event.input, process.env);
  return guardPathAccess(event.toolName, event.input, process.env, process.cwd()) ?? undefined;
 });
}
