# Junior

Junior lets a frontier manager delegate one bounded deliverable at a time to a
capable commodity model through [Pi](https://github.com/earendil-works/pi-coding-agent).
The manager keeps the contract and the acceptance decision; Junior runs the task in
an optional Git worktree, returns a compact handoff with independent check results
and change evidence, and never accepts its own work. Planning and risk stay with the
manager: CPM planning, FMECA analysis and the Crossmatrix hub run as companion tools,
and optional Jev gates can block unsuitable or uncertain tasks before a paid call.

## Install

```bash
npm uninstall -g @matthew-cochran/junior && npm install -g @matthew-cochran/junior@latest --prefer-online && junior --version
```

Node 24 or newer. The package ships compiled JavaScript; there is no install-time
build and no runtime npm dependency. The build collects every production module,
so a new module is included without a separate list. Installation does not
authorize paid model calls.

## Quickstart

```bash
junior init                                   # project defaults, example task and local skill
junior doctor                                 # offline readiness check with remediation
junior handoff tasks/example-task.json --mock # offline dry run; omit --mock for a paid call
```

`junior init` sets up the project and installs the manager skill; `junior doctor`
reports readiness (Node, Pi, credentials, model, skill and companion tools);
`junior handoff` runs one contract and prints a compact handoff object. `--mock`
performs no provider call.

## Readiness and execution

`junior doctor` is the read-only start: it prints a `readiness` object for the
active harness (`--harness claude|cursor|codex`) covering skills, MCP
registration, managed tools and cached updates. When `readiness.ready` is false,
`junior setup` previews an ordered repair plan and confirms before applying it
(`--dry-run`, `--yes`). A cached 24-hour update notice may print one stderr line
on `init`, `doctor`, `status` or `validate`, including an outdated Junior skill
found by a local hash check; `JUNIOR_NO_UPDATE_CHECK=1` disables it, and
`junior update` adopts newer releases. `doctor` names an outdated, customized or
missing Junior skill in its `warnings` and `remediation`, and `junior init`
refreshes an unmodified outdated copy (a customized copy is kept unless
`--force`).

After reviewing a handoff, `junior apply <id|result.json> [--dry-run] [--force]`
applies its worktree diff (tracked and new files) to the source checkout with a
three-way merge; it refuses a run that is not `ready_for_review`, or whose base
commit is no longer an ancestor of `HEAD`, and leaves the tree unchanged on
conflict. A contract with `plan: {id, deliverable}` (and `hopFrom`) leases that
cpm deliverable before the worker starts and records its hours and evidence
afterwards (`in_progress` on success, `failed` otherwise); the manager still
reviews and marks it complete. `junior tools call cpm plan.status plan_id=...`
calls a tool inline against `.delivery/setup/hop.json` and prints only the
result.

Every live run probes `pi --help` and passes the isolation flags it supports,
including `--no-extensions`, `--no-skills`, `--no-context-files`,
`--no-prompt-templates`, `--no-approve`, `--no-mcp` and
`--tools read,bash,edit,write`. A contract can set `piContext`, and the handoff
reports `piIsolation` and any missing flag; `junior doctor` reports missing
isolation support. A contract can also set `scope` to declare its owned files;
the handoff reports `scope` and an `out of scope:` unresolved line without
changing the run status.

Junior routes each contract from Jev task traits to deterministic playbooks and a
`toolPlan` (worker directions plus manager setup) that is reflected before the
worker starts. When the contract is unclear it runs the `prepare` workflow and
stops at `needs_choice` with a numbered U/A brief; choose with
`junior handoff <task> --choose <option> --correct <id>=<text>`, gated by the
contract's `checkBack` (`auto|always|off`). A clarify returns a `needs_answers`
batch that `junior handoff <task> --answers <file>` resolves. An explicit
workflow that is still unclear also stops at `needs_answers`; its answers return
outcome `contract` with `clarified-contract.json`, the workflow kept and
`clarifiedFrom` set. Other contracts continue to a `plan-from-spec` draft or a
prepare brief. The `discover` and `investigate` workflows are report-only.

After a compaction or resume, `junior compact` prints a session-start block rebuilt
from the live stores with no model call: the active plan, pending decisions with
the file to read, open notes, FMECA, open hypotheses, recent unresolved runs, open
PRs from `gh` and capture proposals. `junior note add|list|done|promote|dismiss`
manages local notes in `.delivery/notes.jsonl`; `junior compact --capture` asks the
pinned default model once and writes only proposals, and `junior compact --cursor`
prints Cursor's `{additional_context}`. `junior setup --context-hooks` installs
Claude Code `SessionStart` and `PreCompact` hooks; `--harness codex|cursor` writes `.codex/hooks.json` or `.cursor/hooks.json` instead.

`junior doctor` adds a `companionSkills` report beside its `companions` report:
each companion's agent skills read as `present`, `missing`,
`modified`, `unknown` or `not_installed`, and an unready one carries a complete
`junior init --target ...` remediation command. Skill readiness is reported
separately and never gates `ok`.

Junior executes only on commodity/open-weight models. A built-in roster
(`general`, `deep-reasoning`, `long-horizon`, `agentic-tools`,
`fast-mechanical`) and `delivery.config.json` `models.routing`/`models.roster`
select the executor; Jev asks one model-profile choice when the contract names
no model. A non-default model needs a human approval, so a run without one stops
at `needs_model_approval` (`--approve-model`, plan `approvedProfiles`, or
`junior model approve`). `models.autoUpgrade` lets `junior update` adopt a newer
same-lineage commodity model only at price parity (`models.priceTolerance`).
`junior model status|list|upgrade` reports and adopts the roster, and
`junior plan check`/`junior plan contracts` shape a cpm plan into bounded
handoffs (`plan check --jev` adds a paid plan-time clarity report), and
`junior routes "<request>"` names the command for any manager job (delegate,
plan, risk, traceability, investigate, restore context). See
[Models](docs/models.md) and [Planning for Junior](docs/planning.md).

Acceptance criteria can carry a stable `id`, the 0-based `checks` indexes that
prove them and the fmeca `mitigates` links they verify (ADR 0011). After a run,
`junior fmeca propose-verified <result.json|run id>` prints a ready
`set_mitigation_status` request for every criterion met at tier `check_passed`;
the manager reviews each proposal and applies it with
`junior tools call fmeca`. A judged criterion is never proposed.

Execution settings live on the contract:

- `maxOutputBytes` (1-32 MiB, default 8 MiB) bounds the retained worker output.
  Pi events are compacted and oversized tool text is replaced by a head/tail
  marker, with the full text written once to `tool-output/<toolCallId>.txt`.
- `continuations` (0-3, default 1) starts an automatic fresh-session
  continuation after an output-capped segment, writing `checkpoint-<n>.md` and
  `events-<n>.jsonl`.

A Pi guard extension (`pi-guard.ts`) makes each bash tool call read stdin from
`/dev/null` and caps its timeout ten seconds under `execution.toolTimeoutMs`
(half the budget below 20s), so a slow or interactive command fails only that
call and the model continues. Junior's per-tool watchdog stays as the backstop;
if any tool outlasts it, the run stops and the receipt names it as
`timedOutTool`.

`junior validate` adds non-blocking warnings when a contract names more than six
distinct context paths or more than ten acceptance criteria, suggesting chained
contracts.

The cpm tool's `plan.review` uses Junior's managed OpenRouter key when the
process and hop env set neither `OPENROUTER_API_KEY` nor
`CPM_OPENROUTER_KEY_FILE`, and runs on the project's commodity model
(`CPM_LLM_MODEL`); `junior tools inspect` reports whether a review key is
visible as `cpmReview` (`available` or `unavailable`) and never its value.

One OpenRouter key covers everything. To send Jev calls straight to TypeSafe,
set `TYPESAFE_JEV_API_KEY` ([DPA](https://typesafe.ai/legal/data-processing));
`jev.provider` pins either one. To run the worker through a LiteLLM proxy,
define a `litellm` provider in Pi's `models.json`. See
[docs/models.md](docs/models.md) for both.

## What's in the box

- **[Getting started](docs/getting-started.md)** — setup, the
  `doctor`/`setup`/`init` readiness commands, Pi installation and
  authentication.
- **[Contracts](docs/contracts.md)** — the contract schema, micro-deliverable
  stages, workflow templates, session continuation and the Jev gates.
- **[Runtime](docs/runtime.md)** — execution receipts, cost and billing, Git
  worktree isolation, Pi run isolation, scope checks, the clarity gate, change
  evidence, deadlines and the compact handoff.
- **[Models](docs/models.md)** — the commodity-only policy, roster, routing,
  detection and the `junior model` commands.
- **[Planning for Junior](docs/planning.md)** — shaping a cpm plan into safe,
  bounded handoffs with `junior plan check` and `junior plan contracts`.
- **[Tools](docs/tools.md)** — the `junior tools call` forms, `junior routes`,
  common tool handoffs, `junior report-issue`, MCP registration and
  frontier-attention classification.
- **[Crossmatrix state graph](skills/junior/SKILL.md)** — the `matrix` commands
  (`init`, `export`, `sync`, `bootstrap`, `confirm`, `autolink`, `codemap`,
  `link`, `graph`, `qc`, `analyze`, `adr`, `jtbd`, `plan-from-spec`), the
  playbook/toolPlan routing, check-back and the managed `scientific-process`
  and `elicitation` tools.
- **[Releasing](docs/releasing.md)** — packing, publishing and trusted-publisher
  setup.

## Documentation

| Document | Contents |
| --- | --- |
| [README](README.md) | This front page. |
| [docs/getting-started.md](docs/getting-started.md) | Install, quickstart, `doctor` and `init`. |
| [docs/contracts.md](docs/contracts.md) | Contract fields, workflows, sessions and Jev gates. |
| [docs/runtime.md](docs/runtime.md) | Receipts, cost, isolation, evidence and the handoff. |
| [docs/models.md](docs/models.md) | Commodity-only policy, roster, routing and `junior model`. |
| [docs/planning.md](docs/planning.md) | Junior-ready cpm plans, `plan check` and `plan contracts`. |
| [docs/tools.md](docs/tools.md) | Companion tools, `report-issue` and MCP registration. |
| [docs/releasing.md](docs/releasing.md) | Packing and publishing. |
| [docs/adr/](docs/adr/) | Architecture decision records (MADR) and their conformance rules, checked by `junior matrix adr`. |
| [skills/junior/SKILL.md](skills/junior/SKILL.md) | The agent instructions that `junior init` installs into your project. |
| [CHANGELOG.md](CHANGELOG.md) | Release history. |

## Contributing, security and support

- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability.
- [SUPPORT.md](SUPPORT.md) — troubleshooting and where to ask.
- [LICENSE](LICENSE) — MIT.
