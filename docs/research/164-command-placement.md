# 164 — Command placement reconnaissance

**Status:** recon only. No production code changed. This report is a set of leads for the manager to verify, not an implementation claim.

**Repository state:** `6bc6231 refactor(worker): split worker.ts into contract, receipt, workflow, resume, prompt, Pi, approval and gate modules`. `git status --short` was clean before this report.

**Question:** where can a worker or check start a process, and what indirections must a remote-only command rule block?

---

## 1. Readiness summary

| Finding | Classification | Evidence |
|---|---|---|
| The accepted ADR requires a `commandPolicy` and enforcement in the Pi bash guard and check runner. | proven-here (requirement text only) | `docs/adr/0015-pi-overlay-resume-lease-failures.md:29` and `:121-155` |
| `command-policy.ts`, `parseCommandPolicy`, `decideCommand`, and `COMMAND_PLACEMENT_ERROR` do not exist in the checkout. | proven-here | `grep -rn "commandPolicy\|COMMAND_PLACEMENT\|decideCommand" --include='*.ts' --exclude='*.test.ts' .` returned no matches (exit 1). |
| `commandPolicy` is not an allowed contract field, so a contract carrying it is rejected as an unknown field today. | proven-here | `worker-contract.ts:19-30`, quoted below |
| `pi-guard.ts` currently only rewrites stdin and timeout, then checks source-root substrings; it never decides command placement. | proven-here | `pi-guard.ts:82-92`, `:123-130` |
| Contract checks execute `check.command`/`check.args` directly after shape validation only. | proven-here | `worker-contract.ts:536-539`, `worker.ts:803-804`, `runtime.ts:1087` |
| `isolationSetup.commands` execute directly with `spawnSync` after shape validation only. | proven-here | `isolation.ts:293-302` |
| The listed bypasses evade prompt-only placement rules because the process still receives the original argv. | inferred | This follows from the direct spawn sites above; no policy implementation exists to execute. Individual shell/package-manager expansions are labelled below. |
| Whether `commandPolicy` must also cover `isolationSetup.commands` is not stated by ADR R6, which names only the Pi bash guard and the contract check runner. | unknown | Compare ADR `:29` and `:153-155` with `isolation.ts:293-302`. Manager decision needed. |
| The real production wrapper (`~/.cache/x/npm-safe.sh`), its availability, and the real `scripts/devbox/command-placement.json` are absent here. | unknown | `find . -maxdepth 4 -name '*command*placement*'` found nothing; `scripts/` contains only release/smoke scripts. |

### Contract-field blocker

`worker-contract.ts:19-30` is the allowlist:

```ts
export const TASK_FIELDS = [
 'id','deliverable','cwd','acceptance','assumptions','checks','constraints','context',
 'provider','model','thinking','pricing','jev',
 'workflow','isolation','billing',
 'resumeFrom','repairFrom','reviewFrom','maxRepairs','lineageDeadlineMs','preparedFrom','checkBack',
 'approveModel','approvedProfiles','modelProfile',
 'plan',
 'hopFrom','hopRevision','hopContext','piContext','clarifiedFrom','scope',
 'externalContextConsent','externalProviderConsent','approveExternalContext','externalContextAuthorization','externalContextApproved','externalConsent','consentExternalContext',
 'readScope','budget','scopeExpansion',
 'execution','deadlineMs','quietMs','toolTimeoutMs','heartbeatMs','checkTimeoutMs','checkReserveMs','maxOutputBytes','continuations','isolationSetup',
] as const;
```

`commandPolicy` is absent. CMD1 cannot merely add `command-policy.ts` and the Pi guard wiring: it must also add the field to `TASK_FIELDS` and validate it before any paid call, otherwise the feature is unreachable. This is a pre-implementation gap, not a reason to change the requirement.

---

## 2. Spawn-site inventory (CR-1)

### S1 — Pi bash tool boundary (`pi-guard.ts`)

`pi-guard.ts:123-130`:

```ts
export default function (pi: any): void {
 pi.on('before_provider_headers', (event: any) => { if (event) applyAffinityHeader(event.headers, process.env); });
 pi.on('before_provider_request', (event: any) => event ? applyProviderRouting(event.payload, process.env) : event);
 pi.on('tool_call', (event: any) => {
  if (!event) return;
  if (event.toolName === 'bash') event.input = guardBashInput(event.input, process.env);
  return guardPathAccess(event.toolName, event.input, process.env, process.cwd()) ?? undefined;
 });
}
```

`guardBashInput` only prepends stdin redirection and caps the timeout (`pi-guard.ts:82-92`). `guardPathAccess` only scans bash strings for `JUNIOR_PI_SOURCE_ROOT` (`pi-guard.ts:49-63`) and only applies write-root checks to `write`/`edit`. There is no argv normalization, no shell/package-manager resolution, and no `JUNIOR_COMMAND_POLICY` read.

The actual `spawn` of the bash tool happens inside Pi, not in this repository. From Junior's side the enforceable boundary is the `tool_call` event: the guard must either rewrite the command to the approved wrapper or return `{block:true, reason}` / replace the command with an exit-126 diagnostic.

### S2 — Contract checks (`worker.ts` → `runtime.ts`)

`worker.ts:803-804`:

```ts
const r=await executeCheck({ spawnChild:spawnChildDetached, command:c.command, args:c.args, cwd:checkCwd,
 timeoutMs:timeout, deadlineAt, signal, maxOutputBytes:deps.maxOutputBytes, heartbeat });
```

`runtime.ts:1086-1087`:

```ts
try {
 if (!opts.signal?.aborted) child = opts.spawnChild(opts.command, opts.args, { cwd: opts.cwd });
```

Validation is shape-only and happens earlier. `worker-contract.ts:536-539`:

```ts
if (!Array.isArray(t.checks) || !t.checks.length) throw Error('Missing checks');
for (const c of t.checks) {
 if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.command !== 'string' || !Array.isArray(c.args) || c.args.some((x:any)=>typeof x !== 'string')) throw Error('Invalid check');
 for (const k of Object.keys(c)) if (!(CHECK_FIELDS as readonly string[]).includes(k)) throw Error(`Unknown check field: ${k}`);
```

`CHECK_FIELDS` is `['command','args','cwd']` (`worker-contract.ts:34`). Anything can be a command; `cwd` is constrained to the workspace (`:540-544`) but the program is not constrained.

### S3 — `isolationSetup.commands` (`worker.ts` → `isolation.ts`)

`worker.ts:339` calls provisioning:

```ts
const provisioned=provisionIsolationSetup(rawSetup as IsolationSetup, sourceCwd, executionCwd, dir, { deadlineAt, checkTimeoutMs:settings.checkTimeoutMs });
```

`isolation.ts:293-302`:

```ts
for (const cmd of setup.commands ?? []) {
 const cwd = join(worktreeCwd, cmd.cwd ?? '.');
 const remaining = opts.deadlineAt - Date.now();
 if (remaining <= 0) {
  steps.push({ kind: 'command', target: cmd.command, ok: false, error: 'wall deadline exceeded before setup command' });
  lines.push(`command ${cmd.command} SKIPPED: wall deadline exceeded`);
  return finish('wall deadline exceeded before setup command');
 }
 const timeout = Math.max(1, Math.min(opts.checkTimeoutMs > 0 ? opts.checkTimeoutMs : remaining, remaining));
 const r = spawnSync(cmd.command, cmd.args ?? [], { cwd, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
```

Validation only checks the shape and that `cwd` stays relative/inside (`isolation.ts:144-173`). `command` and `args` are otherwise unrestricted. This path runs **before** the paid worker and before checks, so a policy that covers only S1/S2 leaves this third path open.

### Context spawn sites (not placement targets, listed so the inventory is complete)

| Site | file:line | Why it is outside `commandPolicy` |
|---|---|---|
| Pi CLI process itself | `worker.ts:718-723` | Fixed command `pi`, fixed `buildPiArgs`, prompt appended. The model does not supply this argv. The guard extension is loaded here via `piGuardModulePath()`. |
| Pi capability probe | `worker-pi.ts:71-77` | Fixed argv `pi --offline --no-approve --help`, 10 s timeout. |
| Internal Git/helper spawns | e.g. `worker-gates.ts:611`, `worker.ts:4` import | Fixed argv helpers, not a user/contract command string. They can still be *invoked as* a check command, which is covered by S2. |

`buildPiArgs` is quoted for context because it is where the guard module is attached:

```ts
export function buildPiArgs(requested:{provider:string;model:string}, sessionId?:string|null, thinking?:string, guardPath:string|null=piGuardModulePath(), isolationArgs:string[]=[]):string[] {
 const args=['--provider',requested.provider,'--model',requested.model,'--mode','json'];
 ...
 if (guardPath) args.push('-e',guardPath);
```

---

## 3. Indirections and bypass matrix (CR-2)

These examples assume the remote-only rule below is enforced:

```json
{
  "match": ["node --test", "node --import", "npm test", "npm run test", "npx vitest", "cargo test"],
  "placement": "remote",
  "wrapper": "~/.cache/x/npm-safe.sh"
}
```

`W` below means the expanded absolute path of that wrapper. The intended decision is the contract CMD1 must satisfy. The examples are concrete bypasses of a prompt-only rule; they are **inferred** from shell/package-manager semantics, not executed against a policy implementation (there is none yet).

| # | Class | Command | Intended decision | Why |
|---|---|---|---|---|
| 1 | direct remote | `npm test` | **refuse** | Matches remote rule, `argv[0]` is not `W`. |
| 2 | direct remote | `node --test test/a.test.ts` | **refuse** | Matches `node --test`, not wrapped. |
| 3 | direct remote | `npm run test` | **refuse** | Alias of `npm test`; must resolve before matching. |
| 4 | shell `-c` | `bash -c 'npm test'` | **refuse** | Recursively resolve script; inner command is unwrapped remote. |
| 5 | shell `-c` | `sh -lc 'node --test'` | **refuse** | Combined `-lc`; `c` flag means the next arg is a script. |
| 6 | shell `-c`, allowed inner | `bash -c 'git status'` | **allow** (local) | Inner command matches the local rule; shell itself is transparent only because it was fully parsed. |
| 7 | shell parse failure | `bash -c "$(printf 'npm test')"` | **refuse** | Opaque command substitution: cannot prove the inner command, so fail closed. |
| 8 | `env` prefix | `env CI=1 npm test` | **refuse** | Strip `env` options/assignments, then match `npm test`. |
| 9 | assignment prefix | `CI=1 npm test` | **refuse** | Strip leading `NAME=value` assignments, then match. |
| 10 | `env -i` | `env -i PATH=/usr/bin npm test` | **refuse** | `env` options must not hide the real command. |
| 11 | `npx` | `npx vitest run` | **refuse** | Normalize `npx [options] <bin>` to `<bin>`; matches remote. |
| 12 | `npx` options | `npx --yes --no-install vitest` | **refuse** | Strip npx flags and optional `pkg@version`; do not treat `npx` as the command. |
| 13 | package script | `npm run test:unit` where `package.json` has `"test:unit": "node --test"` | **refuse** | Nearest `package.json` script text is recursively resolved; cycle/depth cap required. |
| 14 | `node -e` | `node -e "require('node:child_process').execSync('npm test')"` | **refuse** | Dynamic eval is opaque arbitrary code; must never be treated as a remote test invocation. |
| 15 | `node -e` hidden by remote prefix | `node --import tsx -e "execSync('npm test')"` | **refuse** | The `node --import` remote prefix must not win when `-e`/`--eval`/`-p`/`--print` is present. |
| 16 | chain `&&` | `echo ok && npm test` | **refuse** | Every chain segment must be allowed; the second segment is unwrapped remote. |
| 17 | chain `;` | `npm test; echo done` | **refuse** | Same rule for `;`. |
| 18 | pipeline `|` | `npm test | tee /tmp/out` | **refuse** | Every pipeline segment; first segment is unwrapped remote. |
| 19 | command substitution | `echo "$(npm test)"` | **refuse** | Opaque substitution; fail closed when it cannot be fully parsed. |
| 20 | transparent wrapper | `command npm test` | **refuse** | `command`/`exec` must not hide `argv[0]`. |
| 21 | transparent wrapper | `timeout 30 npm test` | **refuse** | `timeout` must not hide the real command. |
| 22 | transparent wrapper | `nice npm test` | **refuse** | `nice` must not hide the real command. |
| 23 | indirect executor | `xargs npm test` | **refuse** | The executable is not statically the remote command; fail closed under enforce. |
| 24 | find `-exec` | `find . -name '*.test.ts' -exec node --test {} +` | **refuse** | Cannot prove the executed argv statically; fail closed. |
| 25 | allowed wrapper | `W npm test` | **allow** (remote) | `argv[0]` is the configured wrapper path (after `~` expansion/canonicalisation). |
| 26 | shell to wrapper | `bash -c 'W npm test'` | **allow** (remote) | Fully parsed shell script whose resolved argv[0] is the wrapper. |
| 27 | local rule | `env FOO=bar git status` | **allow** (local) | Strip env/assignment prefix; matches `git` local rule. |
| 28 | local rule | `bash -c 'rg foo src'` | **allow** (local) | Fully parsed inner command matches local rule. |
| 29 | no match under enforce | `echo hello` | **refuse** | ADR: when `enforce` is true and no rule matches, refuse. |
| 30 | no policy | `echo hello` | **allow**, placement `unknown` | ADR: without a policy, behaviour is unchanged. |

### Known residual evasion surface

Even a good argv normalizer cannot fully model shell. These are the cases CMD1 should explicitly refuse unless it can prove the full command tree:

- command substitution, backticks, process substitution, here-docs, arithmetic expansion;
- `source`/`.` of a script, shell functions/aliases defined in the same command;
- `xargs`, `find -exec`, `parallel`, `make`, `npm exec`, `pnpm exec`, `yarn exec`;
- interpreted one-liners (`python -c`, `perl -e`, `ruby -e`, `bun -e`) and `node -e`/`-p`;
- absolute paths and `./` variants of a remote binary (`/usr/bin/npm test`, `./node_modules/.bin/vitest`);
- environment-controlled loaders (`NODE_OPTIONS`, `npm_config_script_shell`);
- wrapper path spoofing through symlinks, relative paths, `$HOME`, or `env -i HOME=...`.

A conservative implementation should refuse opaque constructs under `enforce:true` even if it cannot classify them, and name the refusal reason. This trades some legitimate commands for a much smaller bypass surface.

---

## 4. Proposed normalisation algorithm (for CMD1)

This is a recommendation, not an existing control.

1. **Load policy once before spawning.** `parseCommandPolicy(value, cwd)` validates the object, resolves `manifest` relative to `cwd`, rejects a manifest outside `cwd`, reads it, validates it, and appends manifest rules after contract rules. First matching rule wins. `null`/absent policy means `allow` with placement `unknown`.
2. **Normalise argv.** If input is a string, tokenise without executing a shell. Strip leading assignments and transparent `env` options/assignments. Recognise `command`/`exec`/`timeout`/`nice` as either transparent (after consuming their own options) or opaque-refuse; do not silently ignore them.
3. **Split chains.** Split `&&`, `||`, `;`, newline, `&`, and `|` into segments; every segment must allow. A parser error is a refuse under `enforce:true`.
4. **Resolve shell wrappers.** For `sh|bash|zsh`, parse option clusters; if `-c` is present, recursively resolve the next argument as a script. If the shell invocation is interactive/file-based and cannot be parsed, refuse under enforce.
5. **Resolve package managers.** `npm test` → `npm run test`; `npm run <script>`/`npm run-script <script>` → nearest `package.json` script text; `pnpm <script>`, `yarn <script>` likewise. Recursively normalise the script with a depth cap (for example 8) and a visited-script set to stop cycles.
6. **Resolve `npx`.** Strip `npx` flags (`--yes`, `-y`, `--no-install`, `--package`, etc.) and an optional `pkg@version`, then treat the remaining binary and args as the command.
7. **Treat dynamic evaluation as opaque.** If the resolved command is `node` with `-e`, `--eval`, `-p`, or `--print`, or another interpreter's eval/`-c` form, refuse under enforce unless the whole invocation is the approved wrapper. Do this **before** applying a `node --import` prefix rule.
8. **Match rules.** After normalization, compare token prefixes. A `remote` rule allows only when the resolved `argv[0]` is the configured wrapper, after expanding a leading `~/` against the run's home and canonicalising the path. Otherwise refuse with `E_COMMAND_PLACEMENT`.
9. **Return structured evidence.** Include `decision`, `placement`, matched `rule`, `wrapper`, and a short `reason`. The caller records this on the check or tool result; it must not be inferred later from stdout.

### Wrapper-path rule to pin

ADR R6 says a remote rule allows only when `argv[0]` is the wrapper path. CMD1 must state:

- `~` expansion uses the **child process HOME**, not a shell, and is applied before comparison;
- relative wrapper paths resolve against the contract cwd and must stay inside it (or be rejected);
- symlink canonicalisation happens before comparison, so a symlink to the wrapper is not silently accepted;
- the wrapper's own arguments are not stripped from the recorded command; they remain evidence;
- a wrapper invoked through `env`, `command`, `exec`, `timeout`, or `nice` is **not** automatically allowed unless that prefix is explicitly consumed and the resolved first token is still the wrapper.

---

## 5. Fixtures for a remote-only rule

These are the fixtures CMD1 should use. They are declarative JSON, not production config.

### Fixture A — contract-local remote-only rule (no manifest)

```json
{
  "commandPolicy": {
    "enforce": true,
    "rules": [
      {
        "match": ["node --test", "node --import", "npm test", "npm run test", "npx vitest", "cargo test"],
        "placement": "remote",
        "wrapper": "~/.cache/x/npm-safe.sh"
      }
    ]
  }
}
```

### Fixture B — manifest-backed remote-only rule

Contract:

```json
{
  "commandPolicy": {
    "enforce": true,
    "manifest": "scripts/devbox/command-placement.json"
  }
}
```

Manifest `scripts/devbox/command-placement.json`:

```json
{
  "version": 1,
  "rules": [
    {
      "match": ["node --test", "node --import", "npm test", "npm run test", "npx vitest", "cargo test"],
      "placement": "remote",
      "wrapper": "~/.cache/x/npm-safe.sh"
    }
  ]
}
```

### Fixture C — remote-only plus local allowlist (for chain tests)

```json
{
  "version": 1,
  "rules": [
    {
      "match": ["node --test", "node --import", "npm test", "npm run test", "npx vitest", "cargo test"],
      "placement": "remote",
      "wrapper": "~/.cache/x/npm-safe.sh"
    },
    { "match": ["git", "rg", "cat", "ls"], "placement": "local" }
  ]
}
```

### Expected decision records

Examples CMD1 can turn into table-driven assertions. `W` is the canonical expanded wrapper path.

| Command | Expected `decision` | Expected `placement` | Expected reason/rule |
|---|---|---|---|
| `W npm test` | `allow` | `remote` | Remote rule; `argv[0]` is `W`. |
| `npm test` | `refuse` | `remote` | Remote rule; not wrapped. |
| `bash -c 'git status'` | `allow` | `local` | Inner `git status` matches local rule. |
| `bash -c 'npm test'` | `refuse` | `remote` | Inner command not wrapped. |
| `env CI=1 npm test` | `refuse` | `remote` | Env prefix stripped; remote command not wrapped. |
| `npx vitest run` | `refuse` | `remote` | `npx` resolved; remote command not wrapped. |
| `node --import tsx -e "execSync('npm test')"` | `refuse` | `unknown` | Dynamic eval is opaque; must not match `node --import`. |
| `echo ok && npm test` | `refuse` | `remote` | One segment refused; whole command refused. |
| `echo hello` | `refuse` | `unknown` | `enforce:true` and no rule matched. |
| `echo hello` with no policy | `allow` | `unknown` | No policy means unchanged behaviour. |

### Manifest schema to pin

The report proposes this minimal schema for `scripts/devbox/command-placement.json`:

```json
{
  "version": 1,
  "rules": [
    {
      "match": ["string prefix tokens"],
      "placement": "local | remote",
      "wrapper": "required when placement is remote"
    }
  ]
}
```

Validation rules:

- top level must be an object; `version` must be `1` when present; `rules` must be a non-empty array;
- each rule must have a non-empty string array `match`, a `placement` of `local` or `remote`, and `wrapper` for `remote`;
- unknown fields are rejected so a typo cannot silently disable enforcement;
- the manifest path is relative to the contract cwd, must not be absolute and must not escape via `..`;
- contract rules come first, manifest rules follow; first matching rule wins;
- an unreadable or malformed manifest is a contract-validation error, never a silent “no rules”.

---

## 6. Acceptance test outline for CMD1

No tests were created in this recon. These are atomic, declarative scenarios with one observable assertion each. They test public behaviour (`decideCommand`, the guard handler, the check runner), not private helpers.

| Scenario name | One assertion |
|---|---|
| `remote-only policy refuses an unwrapped npm test` | `decideCommand(policy, 'npm test').decision === 'refuse'` |
| `remote-only policy allows the configured wrapper` | `decideCommand(policy, `${W} npm test`).decision === 'allow'` |
| `remote-only policy resolves bash -c to its inner command` | `decideCommand(policy, "bash -c 'npm test'").decision === 'refuse'` |
| `shell with an allowed inner local command is allowed` | `decideCommand(policy, "bash -c 'git status'").decision === 'allow'` |
| `env assignment prefix does not hide the remote command` | `decideCommand(policy, 'CI=1 npm test').decision === 'refuse'` |
| `npx resolves to the remote binary` | `decideCommand(policy, 'npx --yes vitest').placement === 'remote'` |
| `npm run resolves the nearest package script` | `decideCommand(policy, 'npm run test:unit').decision === 'refuse'` |
| `node eval is refused even under a node --import remote rule` | `decideCommand(policy, `node --import tsx -e "execSync('npm test')"`).decision === 'refuse'` |
| `a chain is allowed only when every segment is allowed` | `decideCommand(policy, 'echo ok && npm test').decision === 'refuse'` |
| `enforce with no matching rule refuses an unknown command` | `decideCommand(policy, 'echo hello').decision === 'refuse'` |
| `no policy allows an unknown command` | `decideCommand(null, 'echo hello').decision === 'allow'` |
| `the Pi guard replaces a refused bash command` | `handlers.tool_call({toolName:'bash', input:{command:'npm test'}})` sets a command ending in `exit 126` |
| `a refused check is recorded and never spawned` | check result has `refused === 'E_COMMAND_PLACEMENT'` and the injected spawn seam was not called |

The last two are integration-level; the first eleven are fast unit-level. Do not duplicate the same decision at every layer.

---

## 7. Risk register

Every row is a lead. `Severity` and `Probability` are qualitative. Residual risk is **conditional on the proposed mitigation being implemented and tested**; it is not “eliminated” by this report.

### R-01 — Contract field is rejected before enforcement

- **Domain:** contract validation / feature reachability.
- **Failure mode:** A contract with `commandPolicy` is rejected as an unknown field.
- **Cause:** `TASK_FIELDS` omits `commandPolicy` (`worker-contract.ts:19-30`), and no validator is called (`:552-558`).
- **Effect:** The feature cannot be used at all; a manager may believe policy is enforced while the run never starts.
- **Severity:** High. **Probability:** High if CMD1 adds only the policy module.
- **Existing verified control:** Unknown-field rejection prevents silent typo acceptance.
- **Proposed mitigation:** Add `commandPolicy` to `TASK_FIELDS`, validate it with `parseCommandPolicy` before any paid call, and surface the parse error in the contract-validation message.
- **Justification:** The field must pass validation before any policy can be enforced; failing closed at validation is consistent with the existing contract design.
- **Production observability:** `validate`/`run` contract error names `commandPolicy` and the offending field; no worker is spawned.
- **Residual:** High severity / Medium probability until the field and validator are covered by contract tests.

### R-02 — Pi bash path can bypass a prompt-only rule

- **Domain:** model tool execution / shell.
- **Failure mode:** Model runs an unwrapped remote command through `bash`.
- **Cause:** `pi-guard.ts:126-129` only rewrites stdin/timeout and checks source-root strings; no placement decision is made. ADR itself records that rules “live only in the prompt” today (`ADR:45`).
- **Effect:** Remote-only repository policy is not enforced; tests run locally, possibly on the wrong host, with local side effects.
- **Severity:** High. **Probability:** High (the model can issue `npm test` directly).
- **Existing verified control:** stdin `/dev/null` + timeout cap (`pi-guard.ts:82-92`), source-root string check (`:49-63`), and Pi's own approval/tool controls.
- **Proposed mitigation:** In the `tool_call` handler, call `decideCommand` before the existing rewrite; if refused, replace the command with the ADR's `printf … >&2; exit 126` form or return `{block:true, reason}`.
- **Justification:** This is the earliest point where the model's command is visible before Pi spawns the bash tool; blocking here prevents execution rather than reporting it afterward.
- **Production observability:** Tool result/error contains `E_COMMAND_PLACEMENT` and the matched reason; `then` the command is not executed. Add a bounded log line with the rule/placement, never the full secret-bearing command.
- **Residual:** High severity / Medium probability after mitigation because shell grammar, wrappers, and aliases can still evade a parser.

### R-03 — Contract checks execute unwrapped commands

- **Domain:** independent check runner.
- **Failure mode:** A contract check named `npm test` (or `bash -c …`) runs on the local host despite a remote-only rule.
- **Cause:** `worker.ts:803-804` passes `c.command`/`c.args` directly to `executeCheck`; `runtime.ts:1087` spawns them. Validation only checks shape (`worker-contract.ts:536-539`).
- **Effect:** Checks pass locally against the wrong environment, producing false green results; the receipt records success for a policy violation.
- **Severity:** High. **Probability:** High.
- **Existing verified control:** Check `cwd` is confined to the workspace (`worker-contract.ts:540-544`); checks are timeout/process-group bounded and failures set `checks_failed` (`runtime.ts:1000-1115`, `worker.ts:874`).
- **Proposed mitigation:** Decide placement before `executeCheck`; on refuse, do not spawn, record `checks[i].placement` and `checks[i].refused: E_COMMAND_PLACEMENT`, and count the check as failed.
- **Justification:** The check runner is the second enforcement point named by ADR R6; refusing before spawn matches the “never counted as passed validation” requirement.
- **Production observability:** `result.json` carries `checks[i].refused` and placement; the compact receipt/check log names the refused command class.
- **Residual:** High severity / Medium probability until integration tests prove the spawn seam was not called.

### R-04 — `isolationSetup.commands` is an unguarded third spawn path

- **Domain:** worktree provisioning.
- **Failure mode:** A project/contract setup command runs a remote-only test or arbitrary local command before the worker and checks.
- **Cause:** `worker.ts:339` → `isolation.ts:293-302`; `spawnSync` is called directly, and validation (`isolation.ts:144-173`) does not inspect placement.
- **Effect:** Policy is bypassed before the paid run; setup can mutate the worktree or run expensive tests locally, and the run may fail or succeed for the wrong reason.
- **Severity:** High. **Probability:** Medium (requires a project to configure such a command, but the field is already supported).
- **Existing verified control:** setup commands are bounded by the remaining wall deadline and `checkTimeoutMs`, use argv without a shell, run with a constrained relative `cwd`, and stop at the first failure (`isolation.ts:293-310`).
- **Proposed mitigation:** Either apply `decideCommand` to every setup command before `spawnSync`, or explicitly exempt this path in the contract/ADR and document why. Prefer enforcement for consistency.
- **Justification:** The task explicitly asks for this spawn path; leaving it out creates a documented bypass that is easier to exploit than the model-driven paths.
- **Production observability:** `isolation-setup.log` and `steps[]` record `kind:'command'`, target, and refusal reason; a refused setup stops provisioning before the worker starts.
- **Residual:** High severity / Medium probability because ADR R6 does not currently require this coverage and the manager must decide.

### R-05 — Indirection resolver misses a class and allows a remote command

- **Domain:** command parsing / policy correctness.
- **Failure mode:** A shell wrapper, package script, `npx`, `env`, `node -e`, chain, or opaque executor hides the real command.
- **Cause:** The ADR only sketches resolution (`ADR:145-152`); a prefix matcher alone cannot handle `bash -c`, scripts, assignments, or dynamic evaluation. The task explicitly calls out `sh -c`, `npm run/npx`, `env`, and `node -e`.
- **Effect:** Remote-only rule is bypassed while the receipt shows “allow”.
- **Severity:** High. **Probability:** High for a naive prefix matcher.
- **Existing verified control:** None for placement; only current stdin/timeout/path guards.
- **Proposed mitigation:** Implement the normalisation algorithm in §4: recursive shell/script/npx resolution, chain splitting, env/assignment stripping, dynamic-eval refusal, depth/cycle caps, and fail-closed on opaque constructs. Keep a conservative allowlist and refuse anything unparsed under enforce.
- **Justification:** Parsing every shell feature is undecidable in general; fail-closed is the only defensible boundary for a security/policy rule. The depth cap prevents package-script cycles.
- **Production observability:** Refusal reason names the indirection class (`shell`, `package-script`, `npx`, `env`, `dynamic-eval`, `chain`, `opaque`), so the operator can see why a legitimate command was denied instead of guessing.
- **Residual:** High severity / Medium probability even after mitigation; shell and interpreters remain an open evasion surface.

### R-06 — Policy/manifest trust boundary is too broad

- **Domain:** configuration loading.
- **Failure mode:** A contract points `manifest` at a file outside the checkout, or an environment variable supplies a policy that the contract did not authorize.
- **Cause:** ADR says `pi-guard.ts` reads `JUNIOR_COMMAND_POLICY` (JSON) and `parseCommandPolicy` reads a manifest path (`ADR:139,153-154`); the trust boundary and path containment are not specified.
- **Effect:** An attacker/typo can make the policy weaker or empty; enforcement silently disappears.
- **Severity:** High. **Probability:** Medium.
- **Existing verified control:** Worktree writes and source-root reads are constrained by `pi-guard` path guards; contract `cwd` is the checkout.
- **Proposed mitigation:** Resolve manifest paths relative to the contract cwd, reject absolute paths and `..` escapes, parse before paid work, and have the worker set `JUNIOR_COMMAND_POLICY` from the validated contract rather than accepting an ambient value. If ambient env must be supported, require an explicit opt-in and log its source.
- **Justification:** A policy loaded from an untrusted path is not a policy; containment matches the existing `relativeSetupPath` and `withinWorkspace` patterns.
- **Production observability:** Contract validation error names the manifest path; run artifact records whether the policy came from contract, manifest, or ambient env.
- **Residual:** High severity / Low-to-Medium probability if containment and provenance are tested.

### R-07 — Wrapper identity is ambiguous

- **Domain:** remote execution / wrapper matching.
- **Failure mode:** A command is allowed because `argv[0]` looks like the wrapper, but the wrapper was invoked through a shell prefix, symlink, relative path, or a different `HOME`; or a legitimate wrapper is refused because `~` was not expanded.
- **Cause:** ADR says only “argv[0] is the wrapper path” (`ADR:146`) but does not pin expansion, canonicalisation, or handling of `env`/`command`/`timeout` prefixes.
- **Effect:** False allow (policy bypass) or false refuse (operator workaround, pressure to disable enforcement).
- **Severity:** High for false allow; Medium for false refuse. **Probability:** Medium.
- **Existing verified control:** None for wrapper identity.
- **Proposed mitigation:** Pin the wrapper rules in §4: expand `~/` against child HOME, resolve relative paths against cwd, canonicalise symlinks, require an executable path, consume only explicitly transparent prefixes, and record the canonical wrapper in the decision.
- **Justification:** Wrapper identity is the only thing separating a remote test from a local test; ambiguity here collapses the rule.
- **Production observability:** Decision record includes `wrapper` and `reason`; a refusal says “not the configured wrapper”.
- **Residual:** High severity / Medium probability until wrapper-path fixtures run in the target environment.

---

## 8. Recommended strategy for a follow-up run

1. **Manager decisions first:** confirm whether `commandPolicy` covers `isolationSetup.commands` (R-04), and confirm the manifest schema/wrapper path resolution in §5. These are requirement choices, not recon findings.
2. **Prerequisite implementation:** add `commandPolicy` to `TASK_FIELDS`, add `command-policy.ts` with the pure `parseCommandPolicy`/`decideCommand` seam, and pin the manifest schema.
3. **Wire S1/S2 (and S3 if approved):** decide before spawn; refused checks record `placement`/`refused` and are not spawned; refused Pi bash commands become the exit-126 diagnostic.
4. **Test in the pyramid order:** fast table-driven `decideCommand` cases from §5, then the Pi handler test, then one check-runner integration test proving the spawn seam was not called, and one `isolationSetup` refusal test if that path is in scope.
5. **Re-probe the bypass matrix** against the implemented resolver, especially shell `-c`, `npm run` script recursion, `npx`, `env`, `node -e`, and chains. Treat any new opaque construct as a refusal reason, not a silent allow.
6. **Do not declare residual risk eliminated.** Report residual severity/probability after tests, including the open shell/interpreter evasion surface.

---

## 9. Evidence index (opened and quoted)

- `worker-contract.ts:19-30` — `TASK_FIELDS`, no `commandPolicy`.
- `worker-contract.ts:536-539` — check shape validation only.
- `worker.ts:803-804` — checks passed directly to `executeCheck`.
- `runtime.ts:1086-1087` — `spawnChild(opts.command, opts.args)`.
- `worker.ts:339` — provisioning call.
- `isolation.ts:293-302` — setup command `spawnSync`.
- `isolation.ts:144-173` — setup shape validation only.
- `pi-guard.ts:82-92` — stdin/timeout rewrite only.
- `pi-guard.ts:126-130` — `tool_call` boundary, no command policy.
- `docs/adr/0015-pi-overlay-resume-lease-failures.md:45` — prompt-only rule today.
- `docs/adr/0015-pi-overlay-resume-lease-failures.md:121-155` — R6 target contract and enforcement points.
- `worker.ts:718-723` — Pi CLI spawn context.
- `worker-pi.ts:71-77` — fixed capability probe.

Labels used: **proven-here** means the cited file was opened and the span quoted above; **inferred** means derived from those facts or from shell/package-manager semantics without executing a policy; **unknown** means the repository does not contain enough evidence; **speculation** means a design hypothesis, not a finding.

---

## Manager decisions (2026-10-29)

- **S3 is in scope.** `isolationSetup.commands` is a process-spawn site and gets the same `decideCommand` check as contract checks (W4). A refused setup command ends the run as `isolation_setup_failed` with `E_COMMAND_PLACEMENT`.
- **Fail closed on opaque constructs under `enforce: true`.** That covers every item in "Known residual evasion surface", including absolute or `./` paths to a remote binary.
- **Wrapper-path rule.** The pinned rule in section 4 is adopted as written.
- **Manifest schema.** The schema in section 5 is adopted as written.
- **Split.**
  - CMD1a covers parsing, the manifest, prefix stripping (env, assignments, `command`/`exec`/`timeout`/`nice`), chain splitting, matching and the wrapper check.
  - CMD1b covers `sh`/`bash`/`zsh -c` recursion, npm/pnpm/yarn script resolution with a depth cap, `npx`, eval detection, and refusal of substitutions, `xargs` and `find -exec`.
