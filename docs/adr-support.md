# ADR support

Junior can check designs, tickets and code against your architecture decision records (ADRs) and make a
human decide whenever something looks like a violation. The rules are in ADR 0018
(`docs/adr/0018-adr-conformance-gate.md`).

## Setup

```bash
junior adr init            # no ADRs yet: scaffold docs/adr with a README index (asks before writing config)
```

Junior looks for an existing ADR folder: an `.adr-dir` file (adr-tools), then `docs/adr`, `docs/decisions`,
`doc/architecture/decisions`, `adr/`, `architecture/decisions`. It proposes what it finds and writes the
location to `delivery.config.json` only after you confirm:

```json
{ "adr": { "dir": "docs/adr", "format": "junior", "gate": "enforce" } }
```

| Field | Values | Meaning |
|---|---|---|
| `dir` | path | Where the ADRs live. Conventional folders are detected case-insensitively and reported in their real case (`Docs/adr`). |
| `format` | `junior`, `madr`, `nygard` | `junior` ADRs carry `applies_to` and `rules` front matter. MADR and Nygard ADRs are checked against their Decision section. |
| `filePattern` | regular expression (optional) | Selects which files are records and supplies the id from its `number` named group. The default is `^(?<number>\d{4})-(?<slug>.+)\.md$`; use `^ADR-(?<number>\d+[a-z]?)-(?<slug>.+)\.md$` for `ADR-001-title.md`. |
| `gate` | `enforce`, `advisory`, `off` | `enforce` blocks on findings. `advisory` only reports them. Defaults to `enforce` when accepted ADRs exist, and `off` otherwise. |
| `minConfidence` | 0..1 (optional) | Also flags any check whose confidence is below this |
| `flagUncertain` | `true` / `false` (default `false`) | Let low-confidence findings block under `enforce` too. By default only likely contradictions block; uncertain ones are listed as advisory. |

ADRs without Junior front matter work as they are. Junior can draft `applies_to` and `rules` for them, but
only as a proposal under `.delivery/adr-proposals/`. Your ADR files are never edited.

If your records use `ADR-001-title.md` instead of `0001-title.md`, `junior adr init` proposes:

```json
{ "adr": { "dir": "docs/adr", "format": "junior", "filePattern": "^ADR-(?<number>\\d+[a-z]?)-(?<slug>.+)\\.md$", "gate": "enforce" } }
```

A folder with Markdown files but no records matching `adr.filePattern` is reported as a `discovery`
object by `junior adr lint` and `junior adr check` (which exits 2, inconclusive) instead of silently
checking nothing.

## Scoping foreign ADRs

When MADR or Nygard ADRs have no `applies_to`, an implementation check cannot tell whether they apply to a
change. It reports the check as inconclusive (exit code 2) instead of clean, and points here. Run:

```bash
junior adr scope                          # every accepted foreign ADR
junior adr scope --adr ADR-0007           # only named ADRs
junior adr scope --max-candidates 50      # judge fewer candidate path globs
junior adr scope --samples 5              # majority vote over five judgments (default 3)
junior adr scope --json                   # proposals and skipped ADRs as JSON
```

Junior lists candidate globs (`<dir>/**` for tracked directories at depth 1 to 3) from `git ls-files`, then
asks Jev a yes/no judgment for each (ADR, candidate) pair: does this decision govern files under that path?
Jev has no temperature or seed, so the gateway can answer differently between runs. Junior therefore asks
each pair `--samples <k>` times (an odd number from 1 to 7; default 3) and takes a majority vote. A candidate
needs more than `k/2` confident yeses to become `applies_to`; the kept paths are then reduced so a nested glob
is dropped when its parent is already kept (`a/**` drops `a/b/**`). With `--samples 1` the result is the
single-run judgment. The rule stays the ADR's own Decision text as rule `D`; Jev never writes paths or rules
itself. `--max-candidates` caps the candidate list (default 150).

A path with at least one yes vote but no majority is **uncertain**. It never enters `applies_to`, but it is
reported instead of silently disappearing: `--json` adds `uncertain` and per-path vote counts to each
proposal, the text line appends `uncertain: <n>`, and the proposal file lists each marginal path as a YAML
comment directly after `applies_to`. An ADR with no majority path but some uncertain paths is skipped as
`only uncertain paths (<n>)`, with those paths in the skipped entry.

Junior writes one proposal per answered ADR under `.delivery/adr-proposals/`, for example
`.delivery/adr-proposals/0007-front-matter.md`. Review the proposals, copy the front matter you accept into
the ADR, then commit the ADR. An ADR with no yes vote, or one whose answers are all unknown, is skipped and
gets no file. Rerunning overwrites that ADR's proposal. Junior never edits, commits or applies the original
ADR itself.

## The checkpoints

| When | Command |
|---|---|
| Before accepting a design, plan or brief | `junior adr check --stage design --input <file>` |
| Before filing a ticket | `junior adr check --stage ticket --draft <file>` |
| Before starting work on a ticket | `junior adr check --stage ticket --ticket <id>` |
| Before opening a pull request | `junior adr check --stage implementation [--base <ref>] [--result <result.json>]` |
| Across open tickets (read-only report) | `junior adr check-tickets` |

Junior also runs the gate automatically in two places. A prepare brief gates every option, and an option
with uncleared findings cannot be chosen. A code handoff gates its changed files before it is ready for
review.

An implementation check judges the change, not the head of the file. Each changed path is sent to Jev as a
unified diff against the base (or against `HEAD` in a handoff worktree), with enough surrounding context to
read the change. Jev is asked to judge only the added or changed lines; unchanged context is reference
only. A new untracked file is sent whole with a `new file <path>` label so it is still checked. Large diffs
keep whole hunks up to the subject limit and end with a `[truncated: <n> more hunks]` marker. When git is
unavailable, or a recorded result worktree is gone, the check falls back to the file head as before.

`junior init` and `junior update` write these checkpoints into a managed `<junior>…</junior>` block in
`CLAUDE.md` (Claude Code) and `AGENTS.md` (Codex and Cursor), so the agents you use know to run them. Junior
owns only that block. Everything else in those files is left exactly as you wrote it.

## What a check does

For each accepted ADR rule whose `applies_to` matches the work, Jev (on the commodity default model) rates
the work as conforms, contradicts or not applicable. A **finding** is a contradiction, or any rating Jev is
not confident about (marked uncertain). Work with no file list, such as a design document or a ticket,
first goes through one relevance pass, so ADRs that clearly don't apply are skipped. Jev is rarely
confident about abstract text, so only likely contradictions block by default. Uncertain findings stay in
the report for you to review.

Jev never passes or fails anything by itself. With no findings the check passes. Under `enforce`, a likely
contradiction stops the stage until you decide; uncertain findings are listed for you to review but do not
block unless you set `flagUncertain: true`.

## Deciding

```bash
junior adr decide <finding> --override --reason "<why this exception is acceptable>"
junior adr decide <finding> --amend      # Junior drafts an updated ADR (proposed); the finding clears once it is accepted
junior adr decide <finding> --revise     # the work goes back to be changed
```

Every decision is appended to `.junior/adr-decisions.jsonl`. Commit it so reviewers see each exception
and its reason. An override covers one deliverable. A standing override (`--standing --expires <date>` or
`--expires until-adr-change`) also applies to later work until it lapses, and the next run then flags the
finding again, citing the lapsed decision. A ticket-stage decision is shown again at design and
implementation for the same work, so you can confirm it in one step.

Agents never record a decision. When a check reports findings, they stop and show them to you.

## Tickets

Ticket checks use GitHub Issues by default (through `gh`) or Jira (`tickets.provider: "jira"`, with
credentials from `JIRA_EMAIL` and `JIRA_API_TOKEN`). Ticket text is treated as untrusted data and never as
instructions. Set `tickets.redact` patterns to strip anything sensitive before it is sent. Junior posts or
labels tickets only with `--post` or `tickets.writeBack: true`.
