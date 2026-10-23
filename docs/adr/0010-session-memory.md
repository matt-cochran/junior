---
id: ADR-0010
title: Session memory is a local notes store that capture only proposes into
status: accepted
date: 2026-10-23
supersedes: []
applies_to:
  - notes.ts
  - precompact.ts
  - compact.ts
  - compact-prs.ts
  - context-hooks.ts
  - junior.ts
rules:
  - id: R1
    text: Notes live in one append-only JSONL file, <project root>/.delivery/notes.jsonl, one event per line. Events are add, done, promote and dismiss; standing is computed by folding the log, never stored. The file is local (.delivery/ is locally excluded) and is never committed.
  - id: R2
    text: A note has id, kind (note | decision | question | risk | hypothesis | todo), text (at most 500 characters), source (manager | capture), createdAt, and for capture notes captureId and evidence (at most 300 characters). A manager note is open until done. A capture note is a proposal until the manager promotes it (it becomes an open manager-visible note with source capture) or dismisses it.
  - id: R3
    text: notes.ts exports addNote, markDone, promote, dismiss, listOpen and writeProposal, each taking the project root first and an optional deps object {now, newId, readFile, appendFile, exists, mkdir} for tests. writeProposal returns null, and writes nothing, when an open note or pending proposal already has the same normalised text (lower case, whitespace collapsed).
  - id: R4
    text: Capture writes proposals only. precompact.ts never calls fmeca, cpm-planner, crossmatrix or scientific-process and never writes plan files; it imports nothing from tools/. Promoting a proposal into a risk, plan change or hypothesis is the manager's act through the companion tools.
  - id: R5
    text: Capture runs as junior compact --capture with the harness hook input as JSON on stdin. It always exits 0. Every attempt, including a skip or failure, writes one record to <project root>/.delivery/capture/<timestamp>.json with the input size, model, usage, proposal count and error.
  - id: R6
    text: Capture uses the project's pinned default model (loadModelConfig(cwd).provider/model, today deepseek/deepseek-v4.1-flash) through OpenRouter with the key from resolveGatewayKey('openrouter'). It never routes to another profile and never asks for model approval. Budget per capture - transcript tail at most 48000 characters, max_tokens 1500, temperature 0, one request, 30 second timeout, at most 12 proposals.
  - id: R7
    text: The compact block reads notes and capture proposals, open PRs and pending-decision runs; it still makes no model call, and every new section is dropped before the plan section under maxChars.
---

## Context

Issue #93. After a compaction, the Junior compact block (0.10) rebuilt the plan,
risk, hypothesis and in-flight-run state from the companion stores, but H8
stayed Inconclusive: the stores did not hold the open PRs, the decisions
waiting on the user, or loose items the manager meant to come back to. Those
lived only in the conversation, so the compaction summary was the only place
they survived, and summaries drop them.

Two sources can fill the gap:

- facts Junior can read without a model: open PRs (`gh`), runs stopped at
  `needs_answers`, `needs_choice` or `needs_model_approval`;
- items only the conversation holds: pending decisions, open questions,
  candidate risks and hypotheses. Claude Code runs a `PreCompact` hook with the
  transcript path just before it compacts, which is the last moment they can
  be read.

The companion stores are the system of record for risks (fmeca), plans
(cpm-planner) and hypotheses (scientific-process). A model reading a
transcript tail must not write to them: its output is a guess about what the
conversation meant (ADR-0003, Jev is advisory).

## Decision

1. **One notes store** (R1, R2, R3). A small append-only log in `.delivery/`
   holds both the manager's own notes (`junior note add`) and capture
   proposals. It is local session memory, not project history, so it is not
   committed and needs no schema version beyond the event shape.
2. **Capture proposes; the manager decides** (R4). Proposals list apart from
   notes in the compact block. The manager promotes or dismisses each one, and
   turns a promoted risk or hypothesis into an fmeca or scientific-process entry
   with the usual tools. Deduplication by normalised text stops repeated
   captures from piling up the same item.
3. **Capture is a fail-open hook** (R5). A hook that fails or blocks would cost
   the user their compaction, so every failure is recorded and swallowed. The
   capture record is also the evidence for H8's replay (X11).
4. **Cheapest model, fixed budget** (R6). Capture is a summarising read of at
   most 48k characters; the default commodity model is enough, and a hook
   cannot wait for a human's model approval, so it never leaves the default.
   One capture costs well under a cent at DeepSeek V4.1 Flash prices.
5. **The block stays model-free** (R7). The SessionStart side only reads what
   capture and the manager wrote, so session start costs nothing and works
   offline.

Decided in the deliverables that own them: the `gh` timeout and repository list
(C2-prs, `compact.repos` in `delivery.config.json`, 3 s default), and the
Codex and Cursor hook mechanisms (HK1-hooks).

## Shapes

`.delivery/notes.jsonl` events:

```json
{"op": "add", "id": "n-mh2x1k-3f9a", "kind": "decision", "text": "Ship 0.11 before 0.12 tracing?", "source": "capture", "captureId": "c-2026-10-23T15-49-11Z", "evidence": "user: let's decide after the release", "at": "2026-10-23T15:49:11.000Z"}
{"op": "add", "id": "n-mh2x9q-01bc", "kind": "todo", "text": "Remind the owner to publish cpm-planner 0.4.3 to crates.io", "source": "manager", "at": "2026-10-23T16:02:00.000Z"}
{"op": "promote", "id": "n-mh2x1k-3f9a", "at": "2026-10-23T16:05:00.000Z"}
{"op": "done", "id": "n-mh2x9q-01bc", "at": "2026-10-24T09:00:00.000Z"}
{"op": "dismiss", "id": "n-mh2xa0-77de", "at": "2026-10-24T09:01:00.000Z"}
```

`listOpen(root)` returns `{notes: Note[], proposals: Note[]}`: `notes` are open
manager notes and promoted capture notes, `proposals` are capture notes neither
promoted nor dismissed, both oldest first.

Model response asked for by capture (JSON object, validated; anything else is
an error with no proposals written):

```json
{"items": [{"kind": "decision", "text": "...", "evidence": "..."}]}
```

Claude Code `PreCompact` hook input (stdin): `{session_id, transcript_path,
cwd, hook_event_name: "PreCompact", trigger: "manual" | "auto",
custom_instructions}`. Capture reads only the tail of `transcript_path`
(JSONL), keeping user and assistant text and dropping tool results.

## Consequences

- After a compaction the block shows what was pending in the conversation,
  marked as proposals, without a human having written it down.
- A wrong proposal costs one `junior note dismiss`; it never reaches a
  companion store on its own.
- Notes do not follow the user to another clone; that is accepted for session
  memory.
- Harnesses without a pre-compact hook get the model-free sections only.
