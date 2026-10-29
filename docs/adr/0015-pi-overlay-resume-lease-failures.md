---
id: ADR-0015
title: Run-local Pi credentials, durable resume, self-consistent plan leases, typed worker failures, workflow budgets, command placement and the worker.ts decomposition
status: accepted
date: 2026-10-29
supersedes: []
applies_to:
  - worker.ts
  - worker-*.ts
  - pi-overlay.ts
  - pi-failure.ts
  - plan-handoff.ts
  - runtime.ts
  - command-policy.ts
  - pi-guard.ts
  - handoff.ts
rules:
  - id: R1
    text: The run-local Pi agent overlay holds regular-file copies of auth.json, models.json and models-store.json (directory 0700, files 0600), never symlinks, so Pi's auth.json.lock is created inside the overlay. The copies are deleted when the run ends on every path. The Jev classifier reads credentials through the same overlay.
  - id: R2
    text: resumeFrom copies exactly the referenced Pi session file from the prior run's overlay into the new overlay at the same relative path before Pi starts. Nothing else is copied. When the file is missing or unreadable the run stops before Pi with outcome resume_session_unavailable, except report-only workflows (evaluate, qa, recon, investigate), which start a fresh session seeded with the prior analysis report and record resumeFallback.
  - id: R3
    text: Junior owns the HOP revisions its own planner calls produce. withPlanLease never sends expectedRevision to plan.acquire_cohort, sets task.hopRevision to the revision returned by its last own call (acquire, plan.ev, mark_status), and still fails on a revision it did not produce. A run that never started returns its deliverable to Ready.
  - id: R4
    text: Every Pi failure is classified by classifyPiFailure into one typed category with a redacted summary. A retryable transport failure that produced no assistant message is retried once; nothing else is retried. Exit 0 with no assistant messages is a failure with its cause, never success.
  - id: R5
    text: Report-only workflows (evaluate, qa, recon, investigate) run with an enforced default budget of 25 tool calls and 400000 total tokens (cache reads count) unless the contract budget overrides a field. A budget stop keeps the existing stopReason budget_exceeded and names the field.
  - id: R6
    text: A contract commandPolicy is enforced where processes start (the Pi bash guard and the contract check runner), not only in the prompt. A refused command never runs and is never counted as passed validation. Contracts without commandPolicy behave exactly as before.
  - id: R7
    text: worker.ts is split into modules by the seam map below without behavior change; worker.ts re-exports every moved export so existing imports and tests keep working, and ends under 1000 lines.
---

# ADR 0015: Pi overlay, resume, plan leases, typed failures, budgets, command placement and the worker.ts split

Issues: #153–#167. Decisions confirmed with the user on 2026-10-29.

## Context

- **Credential lock (#155, #165, #167).** `preparePiAgentOverlay` symlinks `auth.json` into `.delivery/<id>/<stamp>/pi-agent/`. Pi follows the symlink and creates `auth.json.lock` beside the original. In a sandbox with read-only `$HOME` that fails with `EROFS`, Pi exits 0 with no assistant messages, and Junior reports an opaque `receipt_failed`.
- **Resume (#156, #160, #166).** Each run gets a fresh overlay. The prior session lives at `<prior artifactDir>/pi-agent/sessions/<cwd-dir>/<iso-time>_<sessionId>.jsonl`, where `<cwd-dir>` is `--` + the cwd with `/` replaced by `-` + `--`. The new overlay has no copy of it, so `pi --session <id>` fails with `No session found matching '<id>'`. Junior then reports a generic `worker_failed`.
- **Plan lease (#154, #157).** `withPlanLease` forwards `expectedRevision` to `plan.acquire_cohort`, which rejects the unknown field. It also stores the acquire revision in `task.hopRevision`, then calls `plan.ev`, which advances the HOP again. The worker's guard (`t.hopRevision !== hopContext.revision`) then refuses the run Junior itself started. The lease stays held.
- **Opaque failures (#153, #158, #162).** Transport errors, consent blocks and check timeouts reach the compact receipt without a typed cause.
- **Budgets (#161).** Budget enforcement exists (`runtime.ts`: fields, cache-read accounting, `stopReason: budget_exceeded`). It applies only when the contract sets `budget`. Report workflows have no default.
- **Command placement (#164).** Repository rules that require a remote wrapper for tests live only in the prompt.
- **worker.ts** is 3,560 lines. `run()` alone is about 900 lines, and most fixes land in it, which serializes every change.

## Decisions

### R1 — overlay credentials (`pi-overlay.ts`)

```ts
export const OVERLAY_FILES = ['auth.json', 'models.json', 'models-store.json'] as const;
export function piAgentDir(env?: NodeJS.ProcessEnv): string; // PI_CODING_AGENT_DIR, else ~/.pi/agent
export function preparePiAgentOverlay(artifactDir: string, env?: NodeJS.ProcessEnv):
  { dir?: string; copied?: string[]; error?: string };
export function cleanupPiAgentOverlay(dir: string): void; // removes the copied OVERLAY_FILES and any *.lock; never throws
```

- The overlay is `join(artifactDir, 'pi-agent')`, mode 0700. Each source file that exists is copied (`copyFileSync`, then `chmodSync 0o600`). Source files are only ever read.
- A file already present in the overlay is not overwritten.
- `cleanupPiAgentOverlay` runs in the run's `finally`. Session files stay, because resume needs them (R2).
- Error strings name the path, never file contents.

### R2 — resume import

```ts
export function importResumeSession(priorArtifactDir: string, sessionId: string, overlayDir: string):
  { path?: string; error?: { code: 'resume_session_unavailable'; missing: string; message: string } };
```

- Search `<priorArtifactDir>/pi-agent/sessions/*/` for a file named `*_<sessionId>.jsonl`. Copy it to the same `sessions/<cwd-dir>/` relative path under `overlayDir`, and copy nothing else.
- If there is no match, or the file is empty or unreadable, return the typed error with `missing` set to the expected directory.
- In the worker, the error becomes `outcome: resume_session_unavailable` before Pi spawns, with zero usage. Report-only workflows instead fall back:
  - Run a fresh session with the prior `analysis-report.md` (bounded by the existing review-context limits) added to the prompt.
  - Record `resumeFallback: { reason, priorResult, sessionId: <first 8 chars>… }`.
- Implementation workflows never fall back.

### R3 — plan lease (`plan-handoff.ts`)

- `plan.acquire_cohort` arguments are only `caller_id`, `plan_id`, `ids`, `max_count`, `ttl_seconds`.
- Keep `ownRevision`, the last revision returned by a Junior-owned call. After each call, if `task.hopRevision` was set and the call's revision is not exactly `ownRevision + 1`, report `HOP revision changed outside this handoff`. Otherwise set `task.hopRevision` to the new revision. `plan.ev` is included.
- A result where `runNeverStarted(result)` is true is marked `{status: 'ready'}` with evidence `run <id> never started: <status>`.

### R4 — failure taxonomy (`pi-failure.ts`)

```ts
export type PiFailureCategory = 'transport_dns' | 'transport_tls' | 'transport_http' | 'transport_fetch'
  | 'credential_lock' | 'auth_missing' | 'resume_session_unavailable' | 'zero_messages' | 'unknown';
export interface PiFailure { category: PiFailureCategory; summary: string; retryable: boolean; detail: string; httpStatus?: number }
export function redactSecrets(text: string): string; // sk-or-*, sk-*, Bearer tokens, Authorization/x-api-key headers, JSON "key"/"token" values
export function classifyPiFailure(input: { exitCode: number | null; stderr: string; assistantMessages?: number }): PiFailure | null;
```

- Matching order:
  1. `EROFS|EACCES|EPERM` together with `.lock` → `credential_lock`
  2. `No session found matching` → `resume_session_unavailable`
  3. `No API key found` → `auth_missing`
  4. `ENOTFOUND|EAI_AGAIN` → `transport_dns`
  5. `CERT_|SSL|TLS` → `transport_tls`
  6. HTTP status 4xx/5xx in the text → `transport_http`, retryable for 408/429/5xx
  7. `fetch failed|ECONNRESET|ETIMEDOUT|socket hang up` → `transport_fetch`, retryable
  8. exit 0 with `assistantMessages === 0` → `zero_messages`
  9. anything else non-zero → `unknown`
- Exit 0 with assistant messages returns `null`.
- `detail` is the redacted last 500 characters of stderr. `summary` is one sentence naming the cause and the next action.
- The worker records the result as `result.workerFailure` and uses `summary` as `workerError`. It retries once, 2 s later, only when `retryable` is true and `assistantMessages === 0`, and records `workerFailure.retried: true`.

### R5 — workflow budgets (`runtime.ts`)

```ts
export const REPORT_WORKFLOW_BUDGET: BudgetLimits = { maxToolCalls: 25, maxTotalTokens: 400000, mode: 'enforce' };
export function defaultWorkflowBudget(workflow: string): BudgetLimits | null; // evaluate|qa|recon|investigate -> copy of REPORT_WORKFLOW_BUDGET, else null
export function effectiveBudget(workflow: string, contractBudget?: BudgetLimits): BudgetLimits | null; // field-wise: contract wins, defaults fill gaps
```

- The worker passes `effectiveBudget(selectedWorkflow, t.budget)` as the stream `budget`. Stop reason and accounting stay as they are (`budget_exceeded`, `exceededField`).
- Report-workflow prompts tell the worker to write `analysis-report.md` after each acceptance criterion, so a budget stop or interrupt keeps a partial report.
- When a budget stops a report workflow, the compact receipt says `budget_exceeded (<field>)` and `report: partial|missing`.

### R6 — command placement (`command-policy.ts`, `pi-guard.ts`, the check runner)

Contract field:

```json
"commandPolicy": {
  "enforce": true,
  "manifest": "scripts/devbox/command-placement.json",
  "rules": [
    { "match": ["node --test", "node --import", "npm test", "npm run test", "npx vitest", "cargo test"], "placement": "remote", "wrapper": "~/.cache/x/npm-safe.sh" },
    { "match": ["git", "rg", "cat", "ls"], "placement": "local" }
  ]
}
```

```ts
export interface CommandRule { match: string[]; placement: 'local' | 'remote'; wrapper?: string }
export interface CommandPolicy { enforce: boolean; rules: CommandRule[] }
export function parseCommandPolicy(value: unknown, cwd: string): CommandPolicy; // validates; merges manifest rules after contract rules
export function decideCommand(policy: CommandPolicy | null, argv: string[] | string):
  { decision: 'allow' | 'refuse'; placement: 'local' | 'remote' | 'unknown'; rule?: CommandRule; wrapper?: string; reason?: string };
export const COMMAND_PLACEMENT_ERROR = 'E_COMMAND_PLACEMENT';
```

- A rule matches when the normalized command starts with a `match` prefix (tokens compared after stripping leading `env VAR=x`).
- A remote rule allows the command only when argv[0] is the wrapper path; otherwise it refuses.
- Indirections are resolved before matching:
  - `sh|bash|zsh -c "<cmd>"`, recursively
  - `npm test|npm run <script>|pnpm <script>|yarn <script>`, via the nearest `package.json` script text
  - `npx <bin>`, treated as `<bin>`
  - `&&`, `;` and `|` chains, where every segment must be allowed
- When `enforce` is true and no rule matches, the command is refused. Without a policy, the decision is `allow` with placement `unknown`.
- The manifest adapter reads `scripts/devbox/command-placement.json`. The CMD-RECON report pins its schema.
- `pi-guard.ts` reads `JUNIOR_COMMAND_POLICY` (JSON). A refused bash command is replaced by `printf '%s\n' '<E_COMMAND_PLACEMENT json>' >&2; exit 126`.
- The check runner refuses before spawning, records `checks[i].placement` and `checks[i].refused: E_COMMAND_PLACEMENT`, and counts the check as failed.

### Receipt wording (`handoff.ts`)

`stopReasonSummary` adds these lines, read from result fields:

- `consent_required`: `run "junior auth consent grant <provider> --project <cwd>" or set externalContextConsent` (from `external-context-preflight.json` / `authorization.approve.project`)
- `check_timeout`: `check <n> killed after <checkTimeoutMs> ms (raise execution.checkTimeoutMs)`, set when any `checks[i].timedOut`
- `budget_exceeded`: `<field>`, plus the report state for report workflows
- `resume_session_unavailable`, with the redacted session id
- `workerFailure.summary` for each Pi failure category. Transport failures are reported separately from a missing report.

Approval fields: when `--approve-model` names the requested model, the receipt's `model.approval.source` is `run` and `approved` is `true` (#153).

### R7 — worker.ts seam map

Line ranges refer to `worker.ts` at `origin/dev` 515da06. Workers move whole top-level declarations nearest the range. Every moved export is re-exported from `worker.ts` (`export { … } from './worker-x.ts'`). Each new module imports what it needs directly, never through `worker.ts`, so there are no import cycles. Shared helpers that several modules need stay in `worker.ts` only if they are used by `run()` alone; otherwise they move with their first user and are imported from there.

| Step | Lines | Module(s) |
|---|---|---|
| X1 | 56–721: task/check/plan fields, workspace guards, external-context consent, read scope, budget validation, `validate`, `contractWarnings` | `worker-contract.ts` |
| X2 | 722–976: usage, `parseReceipt`, `mockReceipt`, pricing, `estimateCost` | `worker-receipt.ts` |
| X2 | 977–1254: workflow ids, prompt blocks, `taskWorkflow`, contract-part helpers | `worker-workflows.ts` |
| X3 | 1255–1435: resume loading, lineage, review context, `loadReview` | `worker-resume.ts` |
| X3 | 1436–1572: report blocks, `hopToolBlock`, `toolDirectionsBlock`, `promptParts`, `buildPrompt` | `worker-prompt.ts` |
| X3 | 1573–1655: guard path, `piBashTimeoutSeconds`, `buildPiArgs`, `preparePiAgentOverlay`, `probePiCapabilities` | `worker-pi.ts` |
| X4 | 1656–1903: `DEFAULT_JEV`, `jevMode`, model approval, sticky routing, `decideModelRoute` | `worker-approval.ts` |
| X4 | 1904–2586: gate types, preflight/postflight, classifiers, `resolveOpenRouterKey`, `raceSignal`/`raceAbort`, git capture | `worker-gates.ts` |
| X5 | `run()` | phase modules below |

X1–X4 run in parallel. Each touches only its own range plus one re-export line near the top of `worker.ts`. The manager joins them (INT-X).

**X5 — the `run()` phases.** `run()` becomes an orchestrator over one explicit state object:

```ts
export interface RunState {
  t: any; mock: boolean; deps: GateDeps; settings: ExecutionSettings;
  sourceCwd: string; executionCwd: string; isolation: IsolationMode; dir: string;
  requested: { provider: string; model: string }; modelConfig: ModelConfig;
  deadlineAt: number; heartbeat: RuntimeHeartbeat; emit: (line: string) => void;
  resume: any; review: any; lineage: any; decision: any; jev: any;
  signal?: AbortSignal; locks: { release(): void }[];
  // phase outputs are added as optional fields: prompt, receipt, streamResult, checks, workerError, status
}
```

| Module | Source lines | Function |
|---|---|---|
| `worker-preflight.ts` | 2588–3145: setup, model policy/routing, consent, HOP, review/resume resolution, isolation, locks, classifier, workflow decision, clarify/prepare, prompt | `preflight(state): Promise<RunState \| Result>`. A returned `Result` is a blocked/hold outcome. |
| `worker-launch.ts` | 3146–3268: overlay, guard env, Pi spawn/stream, continuations, receipt | `launch(state): Promise<RunState>` |
| `worker-checks.ts` | 3269–~3305: independent checks | `runChecks(state): Promise<RunState>` |
| `worker-outcome.ts` | ~3306–3498: workerError, postflight, billing, status, result write | `finish(state): Promise<Result>` |

`run()` keeps the signal/lock `try/finally` and calls the four phases in order.

## Consequences

- W1 (launch), W2 (resume/preflight), W3 (outcome/approval/prompt) and W4 (checks/contract) each edit different files and can run in parallel after X5.
- Copying the credential puts a 0600 secret file inside the git-ignored `.delivery/` for the length of a run. A crash before cleanup leaves it there; `junior prune` removes old run directories.
- A report-only resume can lose its reasoning history. It never loses lineage, because the fallback is recorded.
