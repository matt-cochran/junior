import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePiCapabilities, type PiCapabilities } from './pi-isolation.ts';

// The run-local overlay lives in pi-overlay.ts. Re-export both operations so
// existing imports through worker-pi.ts (and worker.ts) keep working.
export { preparePiAgentOverlay, cleanupPiAgentOverlay } from './pi-overlay.ts';

/** Absolute path of the pi-guard extension beside the running module. Resolves
 * to `pi-guard.ts` when running from source and `pi-guard.js` from `dist/`, so
 * the same argv works in both layouts. */
export function piGuardModulePath(moduleUrl:string = import.meta.url):string {
 const here = fileURLToPath(moduleUrl);
 const guard = here.endsWith('.ts') ? 'pi-guard.ts' : 'pi-guard.js';
 return join(dirname(here), guard);
}

/** Pi's own bash timeout in whole seconds, chosen to fire before Junior's
 * per-tool watchdog: ten seconds of headroom for budgets of 20s or more, and
 * half the budget for shorter ones (never below one second). */
export function piBashTimeoutSeconds(toolTimeoutMs:number):number {
 const seconds = toolTimeoutMs >= 20000 ? Math.floor(toolTimeoutMs/1000) - 10 : Math.floor(toolTimeoutMs/2000);
 return Math.max(1, seconds);
}

/** One bounded unresolved entry for a tool that exceeded its per-tool limit. */
export function timedOutToolLine(tool:{name:string; command?:string|null}):string {
 const command = typeof tool.command === 'string' ? tool.command : '';
 return `tool timed out: ${tool.name}${command ? `: ${command.slice(0,200)}` : ''}`;
}

/** Build Pi argv for a run. Resume passes an explicit `--session <id>` and
 * never `--continue`, so continuation cannot silently pick the wrong session.
 * `-e <path>` loads the pi-guard extension that redirects bash stdin and bounds
 * its timeout. */
export function buildPiArgs(requested:{provider:string;model:string}, sessionId?:string|null, thinking?:string, guardPath:string|null=piGuardModulePath(), isolationArgs:string[]=[]):string[] {
 const args=['--provider',requested.provider,'--model',requested.model,'--mode','json'];
 if (thinking) args.push('--thinking',thinking);
 if (sessionId) args.push('--session',sessionId);
 if (guardPath) args.push('-e',guardPath);
 args.push(...isolationArgs);
 return args;
}

/** Probe the installed Pi CLI for the long options it supports. The probe is
 * offline and bounded; any failure (missing binary, non-zero status, timeout)
 * yields null so the caller can fall back to assuming every flag works. */
export function probePiCapabilities(run?: (command:string, args:string[], options:any) => { status:number|null; stdout?:string; error?:Error }): PiCapabilities | null {
 const invoke = run ?? ((command:string, args:string[], options:any) => spawnSync(command, args, options));
 try {
  const result = invoke('pi', ['--offline','--no-approve','--help'], {
   encoding:'utf8', timeout:10000, maxBuffer:1048576,
   env:{...process.env, PI_OFFLINE:'1', PI_SKIP_VERSION_CHECK:'1'},
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  return parsePiCapabilities(result.stdout);
 } catch {
  return null;
 }
}
