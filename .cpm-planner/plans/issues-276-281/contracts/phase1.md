# Phase 1 contract: evidence you can trust (0.18.8)

Issues: #276 (ADR gate), #281 (command guards, human approval), #279 (contract
lint, continuation proposal). Integration branch: `integration/0.18.8`. Every
lane branches from it after C1 lands, and owns only the files listed. Lanes do
not touch `package.json` or `CHANGELOG.md`: CAND1 registers new test files and
writes the changelog from the lane receipts.

C1 already landed these seams (all tests green):

| Seam | File | State |
|---|---|---|
| `mustJudge(adr, subject): 'cited'\|'scope'\|'topic'\|null` | `adr-retrieval.ts` | stub returns null; `runAdrGate` keeps every subject it returns a reason for and lists them in `AdrGateResult.retrieved` |
| `PolicyEvent`, `recordPolicyEvent(sink, ev)`, `compactPolicyEvents` | `policy-events.ts` | complete; `RunState.policyEvents`, `result.policyEvents`, compact receipt `policyEvents` |
| `ContinuationProposal` | `worker-receipt.ts` | type only |
| `contractLint(t, opts): ContractLintFinding[]` | `contract-lint.ts` | stub returns []; `validate()` throws on `severity:'error'`, `contractWarnings()` lists warnings |
| `settleBudgetApproval(state, c)` | `worker-preflight-phases.ts` | stub returns undefined; called right after `settleModelApproval` in preflight |

Rules for every lane: production-grade code, no TODOs or placeholders, every
new branch covered by a test with one behavioural assertion against a public
outcome, injected clock (`clock.ts`) for any time logic, no new dependency.

## 1. ADR retrieval (A1): `adr-retrieval.ts`, `adr.ts`

`mustJudge(adr, subject)` returns, in this order:

1. `'cited'`: `subject.text` names the ADR's id as a token (for example `0007`,
   `ADR-0007`, `ADR 7`, or the configured `adr.filePattern` id form), or its
   file name. Match on word boundaries; `0071` does not cite `0007`.
2. `'scope'`: any of `subject.files` matches one of the ADR's `applies_to`
   entries. Fix `matchesAppliesTo`/`globToRegExp` in `adr.ts` so `**` matches
   zero or more segments (`tools/_shared/**` matches `tools/_shared/a.ts` and
   `tools/_shared/x/y.ts`), a directory entry (`tools/_shared/`) matches
   everything below it, and `./` prefixes and backslashes are normalized.
3. `'topic'`: the subject has no files, and the ADR title shares at least two
   significant words (lower-cased, stop words and words under 4 letters
   dropped, simple plural `s` stripped) with `subject.text`, or one significant
   multi-word phrase of the title (for example "claim check") appears in it.

Tests reproduce both #276 cases with fixtures: a design citing two ADR ids gets
both judged although the relevance filter says no, and a design about "bulk
import messaging" retrieves an ADR titled "Claim-check messaging for bulk jobs".

## 2. NO_DISCRIMINATION (A2): `adr-gate.ts`, `worker-adr-gate.ts`

Today `cellVerdict` yields only `contradicts` or `uncertain`; a conforming cell
yields no finding. Add to `AdrGateResult`:

```ts
discrimination?: { checked: number; uncertain: number; ratio: number; noDiscrimination: boolean };
```

`noDiscrimination` is true when `checked >= adr.minDiscriminationCells`
(default 10) and `uncertain / checked >= adr.maxUncertainRatio` (default 0.9).
Then the result is `inconclusive: true` with `inconclusiveReason` starting
`NO_DISCRIMINATION:` and naming the counts. The CLI then exits 2, not 0
(`adr-cli.ts` already maps inconclusive to 2). The per-lane `adr-gate.md` shows
a `NO_DISCRIMINATION` banner, and `worker-adr-gate.ts` reports the run's ADR
gate as inconclusive. The two config keys are read in `adr-gate.ts` from
`opts.config` with the defaults applied there; `adr-config.ts` accepts them as
optional numbers (A2 owns that one-line validation as well, in `adr-config.ts`).
Decisive results (any `contradicts`, or ratio below threshold) behave exactly
as before.

## 3. Whole-change judging (A3): `adr-change.ts`, `adr-cli.ts`

`junior adr check --stage implementation --whole-change` builds one subject for
the whole change instead of one per file:

- `buildWholeChangeSubject({root, base, head?}): GateSubject` with
  `target: 'change'`, `kind: 'diff'`, `files` = every changed path, and `text` =
  the unified diff (bounded to 60,000 characters, keeping whole hunks) followed
  by a `Relationships` section from `changeGraph()`.
- `changeGraph({root, files})` lists, for changed TS/JS files, relative imports
  that cross a top-level tool boundary (`tools/<a>/...` importing
  `tools/<b>/...` or `tools/_shared/...`), and for changed OpenAPI/JSON Schema
  files, `$ref`s pointing at another tool's spec. It also lists a module under
  `_shared` (or any module) imported from two or more tools. It is static text
  analysis, no type checker.
- `adr-cli.ts` adds the flag, passes the one subject to `runAdrGate`, and keeps
  per-file mode as the default.

Tests: a fixture repo where a hook in `tools/_shared/` is imported by three
micro-apps and one spec `$ref`s another tool's spec. The relationships section
names all four edges.

## 4. Command guards (G1): `command-guards.ts`, `command-policy.ts`, `worker-checks.ts`, `pi-guard.ts`

`guardCommand(argv: string[], ctx: GuardContext): GuardDecision | null`:

```ts
interface GuardContext { source: PolicyEvent['source']; lastBuild: 'ok' | 'failed' | 'none'; guards: ResolvedGuards; }
interface ResolvedGuards { noBuild: 'refuse' | 'stale' | 'off'; hookBypass: 'refuse' | 'off'; }
interface GuardDecision { action: 'refuse' | 'flag_stale'; event: PolicyEvent; }
```

- Default guards apply with no `commandPolicy` at all: `noBuild: 'refuse'`,
  `hookBypass: 'refuse'`. `commandPolicy.guards` (`{noBuild?, hookBypass?}`)
  overrides; `parseCommandPolicy` validates it, and an unknown key or value is
  an error.
- no-build: a test command carrying `--no-build` (dotnet), `--no-restore
  --no-build`, or `-Dmaven.main.skip` while `lastBuild` is `failed` or `none`.
- hook bypass: `git ... --no-verify`, `git -c core.hooksPath=...`,
  `git config core.hooksPath`, env prefixes `HUSKY=0`, `HUSKY_SKIP_HOOKS=1`,
  `SKIP_HOOKS=1`, `LEFTHOOK=0`, `PRE_COMMIT_ALLOW_NO_CONFIG` misuse is out of
  scope. Use the existing tokenizer and `stripPrefixes` in `command-policy.ts`
  so `env`, `timeout`, `nice` and `exec` prefixes cannot hide the command.
- `worker-checks.ts`: track `lastBuild` across the contract's checks (a check
  whose command is a build, such as `dotnet build`, `npm run build`, `tsc`,
  `cargo build` or `mvn compile`, sets `ok` or `failed` by its exit code). A
  refused check fails with `refused: 'E_POLICY_GUARD'`. A `flag_stale` check
  runs but carries `staleEvidence: true` and `error: 'E_STALE_EVIDENCE'`, so
  the existing `terminalStatus` reports `checks_failed` (no change to
  `worker-outcome.ts`). Each decision is recorded with `recordPolicyEvent(state, ev)`.
- `pi-guard.ts`: `guardBashInput` applies `hookBypass` (stateless) to the
  worker's bash calls even with no policy, replacing the command with a refusal
  echo the same way placement refusals do. no-build is not applied to the
  worker's own bash, because it is not evidence.

## 5. Human approval for budgets and consent (G2): `human-approval.ts`, `worker-approval.ts`, `worker-preflight-phases.ts`, `auth.ts`

- `human-approval.ts`: `agentEnvironment(env): string | null` detects an agent
  shell (`CLAUDECODE`, `PI_CODING_AGENT`, `JUNIOR_WORKER`, `CODEX_SANDBOX`,
  `CURSOR_AGENT`). `requireHuman(action, {env, isTTY, prompt})` refuses with
  `E_HUMAN_APPROVAL_REQUIRED` when an agent environment is detected and stdin
  is not a TTY. On a TTY it shows a 6-character code and requires it typed
  back. There is no `--yes` bypass.
- `junior auth budget approve <contract-id> --tokens <n> [--project <dir>]`
  (dispatched in `auth.ts` beside `consent`) records `{id, maxTotalTokens, approvedAt,
  token}` in `.junior/budget-approvals.json` after `requireHuman`.
- `settleBudgetApproval`: when the contract's `budget.maxTotalTokens` exceeds
  the workflow default (`effectiveBudget` with no contract budget), or exceeds
  the parent's on a `resumeFrom`, and no approval record covers that id and
  amount, the run stops before the worker with status `needs_budget_approval`,
  writes `budget-approval.json` (requested, default, parent, the command to
  run), and records a `budget_raise_unapproved` PolicyEvent. Add
  `needs_budget_approval` to `HOLD_OUTCOMES` only through this lane's files; if
  `plan-handoff.ts` is needed, note it for CAND1 instead.
- `junior auth consent grant` goes through `requireHuman`; a refusal records
  nothing and prints the exact command for the human to run in their own
  terminal.

## 6. Contract lint (L1): `contract-lint.ts`, `plan-junior.ts`

- `CHECK_UNFILTERED`: a check runs a whole test project or suite with no
  filter (`dotnet test <proj>` without `--filter`, `npx jest`/`vitest run` with
  no path or `-t`, `pytest` with no path or `-k`, `node --test` with no file,
  `npm test` when the package's test script is unfiltered), while the
  contract's owned or allowed files name at most 3 test files. The suggestion is
  the filtered command built from those test files or classes.
- `CONTRACT_OVER_BUDGET`: estimate changed lines as the sum of owned files'
  current line counts × 0.5 (edited) plus 150 per new file, or the contract's
  `estimate.changedLines` when given. Multiply by tokens per changed line: the
  median of past receipts under `opts.deliveryDir` (usage total ÷ evidence
  changed lines, from runs with ≥ 50 changed lines), else 7,000. Flag when the
  estimate exceeds `effectiveBudget().maxTotalTokens`. The suggestion is a
  code/test split.
- Severity is `error` under `jev.mode: enforce`, else `warning`.
- `plan-junior.ts`: `checkPlanForJunior` runs `contractLint` on each
  deliverable's `metadata.junior` contract and reports the same codes.

## 7. Continuation proposal (L2): `worker-outcome.ts`

On terminal status `output_truncated` or `budget_exceeded`, set
`result.continuation: ContinuationProposal`:

- `changedFiles`: the run's changed files.
- `remainingFiles`: owned or allowed files from the contract not changed.
- `split`: code files then test files when both remain, else one part.
- `next`: a contract skeleton copying `id` (suffixed `-cont-1`), `cwd`,
  `workflow`, `acceptance`, `checks` and `isolation`, with `resumeFrom` set to
  this `result.json`.

## 8. Docs (DOC1): `docs/adr-support.md`, `docs/contracts.md`

Document §1–§7 for users: retrieval rules and `retrieved`, NO_DISCRIMINATION
and its two keys, `--whole-change`, the default guards and
`commandPolicy.guards`, `junior auth budget approve` and the human-approval rule,
the two lint codes, and `result.continuation`.

## Gate (GATE1)

On `integration/0.18.8` after CAND1: `npm run build`, full `npm test`. Then
one live `junior adr check --stage design` on a fixture design citing two ADRs
(DeepSeek/Jev, cents). It must list both in `retrieved` and end decisive or
`NO_DISCRIMINATION`, never a bare PASS.
