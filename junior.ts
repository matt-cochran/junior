#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Junior handoff CLI.
//
// `handoff` is the compact manager entry point: it runs one bounded task and
// prints a small stable JSON object. `init`, `doctor`, `run`, `validate` and
// `status` are thin adapters over the existing worker/setup structures, so the
// legacy `node worker.ts ...` CLI keeps working unchanged.
//
// A handoff task defaults to `isolation: "worktree"` unless the task explicitly
// sets `isolation: "none"`. Worktree isolation refuses a dirty source checkout,
// so the default is safe (it never silently omits uncommitted work).
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { run, validate, status, type GateDeps } from './worker.ts';
import { doctor, init, parseInitOptions } from './setup.ts';
import { compactHandoff, isSuccessOutcome } from './handoff.ts';

function usage(): string {
 return [
  'Usage: node junior.ts <command> [args]',
  '  handoff <task.json> [--mock] [--full]   run a task and print the compact handoff (default isolation=worktree; qa defaults to none)',
  '  qa      <task.json> [--mock] [--full]   run the report-only QA review workflow in place (fresh reviewer session)',
  '  run     <task.json> [--mock]            run a task with the compact-default isolation',
  '  validate <task.json>                    validate a task contract',
  '  status  <result.json> [--full]          print a compact handoff, or the full status with --full',
  '  tools init|call|inspect ...            persistent FMECA / CPM / Crossmatrix handoff',
  '  doctor                                  read-only readiness check',
  '  init    [--install] [--target codex|claude|both|none] [--user]',
  '          [--upgrade] [--force] [--skill-root DIR]   idempotent project setup + skill install',
 ].join('\n');
}

/** Task isolation defaults to `worktree` for the ergonomic handoff entry point;
 * an explicit value (including `none`) is always preserved. The report-only
 * `qa` workflow defaults to `none` so the reviewer sees the subject checkout
 * including uncommitted changes instead of a snapshot of the wrong HEAD. */
export function withHandoffIsolation(raw: any): any {
 if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
 if (raw.isolation === undefined) return { ...raw, isolation: (raw.workflow === 'qa' || (raw.workflow === 'auto' && raw.reviewFrom)) ? 'none' : 'worktree' };
 return raw;
}

async function main(argv: string[]): Promise<void> {
 const command = argv[0];
 const rest = argv.slice(1);
 if (command === 'tools') { const tools = await import('./tools/tools.ts'); process.exitCode = await tools.main(rest); return; }
 const flags = rest.filter((a) => a.startsWith('--'));
 const files = rest.filter((a) => !a.startsWith('--'));

 if (command === 'doctor') {
  const result = doctor();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
  return;
 }
 if (command === 'init') {
  const result = init({}, parseInitOptions(rest));
  console.log(JSON.stringify(result, null, 2));
  if (result.install && !result.install.ok) process.exitCode = 1;
  return;
 }
 if (command === 'validate') {
  const path = files[0];
  if (!path) throw Error(usage());
  const t = validate(JSON.parse(readFileSync(path, 'utf8')));
  console.log(JSON.stringify({ valid: true, id: t.id }, null, 2));
  return;
 }
 if (command === 'status') {
  const path = files[0];
  if (!path) throw Error(usage());
  if (flags.includes('--full')) {
   console.log(JSON.stringify(status(path), null, 2));
  } else {
   status(path); // Validate the full saved result before projecting a compact receipt.
   const raw = JSON.parse(readFileSync(path, 'utf8'));
   console.log(JSON.stringify(compactHandoff(raw), null, 2));
  }
  return;
 }
 if (command === 'run' || command === 'handoff' || command === 'qa') {
  const path = files[0];
  if (!path) throw Error(usage());
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const raw = withHandoffIsolation(command === 'qa' ? { ...parsed, workflow: 'qa' } : parsed);
  const mock = flags.includes('--mock');
  const deps: GateDeps = {};
  const result = await run(raw, mock, deps);
  console.log(JSON.stringify(flags.includes('--full') ? result : compactHandoff(result), null, 2));
  if (!isSuccessOutcome(result.status)) process.exitCode = 1;
  return;
 }
 throw Error(usage());
}

if (process.argv[1]?.endsWith('/junior.ts')) {
 main(process.argv.slice(2)).catch((e) => { console.error(String(e)); process.exitCode = 1; });
}
