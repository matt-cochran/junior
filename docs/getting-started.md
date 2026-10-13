# Getting started

[Back to the README](../README.md)

## Junior — deliverable delegation
Run inside Ubuntu WSL with Node 24 or newer (Node 26.5 is the tested
version; load nvm first, for example `nvm use 24`).

node --test worker.test.ts
node worker.ts doctor
node worker.ts init [--no-install]
node worker.ts validate smoke.json
node worker.ts run smoke.json --mock
node worker.ts status .delivery/<id>/<timestamp>/result.json


## Compact manager entry point (same worker/setup structures underneath).
node junior.ts handoff tasks/example-task.json --mock
node junior.ts handoff tasks/example-task.json --full
node junior.ts status .delivery/<id>/<timestamp>/result.json
node junior.ts status .delivery/<id>/<timestamp>/result.json --full
node junior.ts doctor
node junior.ts prune [--older-than 24h] [--keep-last 2] [--dry-run]
node junior.ts init [--no-install] [--no-companions]
node junior.ts update
node junior.ts validate smoke.json
node junior.ts run smoke.json --mock

`junior.ts handoff` is the compact entry point. It defaults a task to
`isolation: "worktree"` unless the task explicitly sets `isolation: "none"`,
runs the task and prints one small handoff object (see **Runtime, deadlines and
handoff** below). `junior.ts` `init`/`doctor`/`run`/`validate`/`status` delegate
to the same `setup.ts`/`worker.ts` code as the legacy `worker.ts` CLI, which is
retained unchanged for saved artifact/session paths.

`doctor` performs a read-only readiness check with no arguments. `init` creates
project defaults and an example task only when absent. Neither makes a paid
network call or writes global configuration.

`status` inspects a saved result file and prints its id, outcome, checks,
artifact directory and (when present) receipt and Jev gate record as JSON. Old
result files without those fields still work. It does not execute anything; a
saved failed run is reported successfully. Missing files, invalid JSON, and
malformed results print a concise error and exit nonzero.

Live execution: install/authenticate Pi with OpenRouter (`init`, then `pi` and
`/login`/`/model`), then opt in to the paid smoke test by omitting `--mock`.
Tasks declare id, deliverable, cwd, acceptance, checks (command + args), optional
constraints, model and `jev`. Provider/model come from `delivery.config.json`
when present, otherwise they default to openrouter and
deepseek/deepseek-v4.1-flash; an explicit task value always wins.


### Setup
- Node 24 or newer (`node --test`, `node worker.ts`); the worker is tested on
  Node 26.5, and `doctor` reports the running version and the minimum. Install nvm
  inside WSL and use it for both `node` and the global `pi` install so the two
  resolve from the same bin directory.
- The worker shells out to `pi` for live runs; `--mock` performs no Pi call.
- Logs and results are saved in the target checkout under `.delivery/`. `init`
  adds `.delivery/` and the exact generated scaffold/skill paths to the
  repository-local `.git/info/exclude` (never a tracked `.gitignore`), so it
  never broadly ignores a `tasks/` or manager skill directory.
- Jev gates use the installed Pi SDK. Resolution order: `PI_SDK_MODULE` (or
  `PI_SDK_PATH`) if set, then the global `node_modules` beside the running
  `node`, then normal package resolution. No dependency install is performed.
- Tests never load the SDK and never make paid calls: they inject an offline
  classifier through `run(task, mock, { classify })`.


### Setup commands: `doctor` and `init`
Both commands take no task file and are offline by default.

#### `node worker.ts doctor`
Read-only readiness check. It emits concise JSON and exits nonzero when a
required prerequisite fails. It never installs anything or writes
configuration, and by default it makes no network call. Checks:

- **Node**: the running version versus the supported minimum (`22.19.0`).
- **Pi**: resolves `pi` on `PATH`, records the bounded `pi --version` output,
  the executable location, and the tested version pinned by
  `delivery.config.json` (`pi.testedVersion`) or the built-in default (1.0.3). It
  reports `versionMatch` and a `versionStatus` pairing: an equal version
  matches, a newer patch is informational (`patch`), and a newer
  major/minor or an older install is a warning (`major`/`minor`/`older`).
  Version differences never fail `doctor`; they only add a note. It also flags a
  PATH/nvm mismatch when `pi` and the running `node` resolve from different
  directories (a global install under another nvm version is invisible to the
  active Node).
- **Credentials**: inspects whether the requested provider has a credential in
  Pi's `auth.json` or its environment variable. Only provider names and source
  labels are reported; credential values are never returned or printed.
- **Model**: verifies the configured provider/model (default `openrouter/deepseek/deepseek-v4.1-flash`) against Pi's
  local catalog (`models-store.json`) and agent `models.json` with no network
  call, and gives an actionable diagnosis when it is missing. It also reports
  the selected provider's catalog as `missing`, `empty`, or `populated` so the
  remediation is specific; another provider's models never count as populated.
- **Skill**: reports delegation-skill readiness **separately** from Pi execution
  readiness in the `skill` field (`current`, `outdated`, `customized` or
  `missing` per manager). A missing or customized skill does not change the
  Pi execution `ok`/exit status.
- **Retained worktrees**: reports the count and approximate disk usage of
  retained Junior worktrees under `.delivery/<id>/<timestamp>/worktree`, plus a
  readiness note pointing at `junior prune`. The traversal never follows a
  symlinked root or parent outside `.delivery/`, and when an entry/time bound
  stops the walk the note says the measurement was truncated instead of
  presenting a partial size as complete. This is a read-only count; it never
  removes anything and never makes a provider call.
- **Integrations**: reports prebuilt FMECA/CPM/Crossmatrix readiness (installed
  version, release provenance and binary path) separately from Pi execution and
  auth readiness in the `integrations`/`integrationsReady` fields, plus the
  optional TRIZ status. It is offline and never compiles Rust; an existing
  configured local binary is reported usable from its metadata without an
  implicit build.

The result includes `checks` (one entry per prerequisite) and `remediation`
strings. If `pi` is missing it recommends `init --install`; if credentials are
missing it recommends `pi` then `/login` and `/model` first. Remediation is
ordered and specific: a missing or empty selected-provider catalog names the
provider and leads with `/login` first and then `pi update --models`; an
authenticated empty catalog suggests `pi update --models`; an authenticated
populated catalog that lacks the configured model suggests starting `pi` and
choosing with `/model`.

The result includes a `warnings` array of non-blocking advisories that never
change `ok`. A checkout on a slow Windows-mounted filesystem — a `/mnt/<letter>/`
drive-letter path, or a path whose deepest `/proc/mounts` mount is `9p` or
`drvfs` — adds a warning recommending a Linux-native path for a `worktree`
handoff to avoid slow file operations.

`--online` opts in to one read-only network request (`GET
https://openrouter.ai/api/v1/key`) that asks OpenRouter whether the configured
credential is valid and still has credit. It is free, never returns or prints
the key, and is off by default, so plain `doctor` makes no network call. The
result is added as `credentialsOnline` (`provider`, `valid`, `usage`, `limit`,
`remaining`, `ready`, plus an `error` when the check is inconclusive).

```bash
junior doctor            # offline readiness, including any slow-mount warnings
junior doctor --online   # also verify the OpenRouter credential and credit
```

#### `node worker.ts init`
Idempotent project setup. It creates, only when absent:

- `delivery.config.json` with the project defaults (`provider`, `model`, and the
  pinned tested Pi version (1.0.3)).
- `tasks/example-task.json` with a runnable example contract.
- The packaged delegation skill under `.agents/skills/junior/` (Codex) and
  `.claude/skills/junior/` (Claude Code), copied from the canonical
  `skills/junior/SKILL.md` resolved relative to the Junior module, never from
  the caller's working directory.

Existing files are preserved and global auth/model configuration is never
touched. `run` loads `delivery.config.json` from the task's resolved `cwd`; an
explicit task `provider`/`model` always takes precedence over the defaults.

`init` reports readiness honestly: it runs the same checks as `doctor` and
returns `ready` (Pi execution **and** skill install), plus `instructions` when
something is missing.

> **Project init keeps the checkout clean.** For the files it actually creates
> it appends exact local exclusions to `.git/info/exclude`: `/delivery.config.json`,
> `/tasks/example-task.json`, `/.delivery/`, and the specific installed
> `junior` skill + manifest paths. A pre-existing untracked config, task or
> skill is **not** excluded, so it stays visible as a source change; `.delivery/`
> is always excluded because it is runtime-owned output. Existing exclude
> content, tracked edits and unrelated untracked files are untouched, and
> nothing under `tasks/` or a manager skill root other than the Junior-owned
> paths is ignored. A fresh `init` is therefore immediately ready for the
> default `worktree` handoff with no manual commit or stash. Junior never
> commits and never edits a tracked `.gitignore`.

##### Skill install and upgrade
By default `init` installs the skill for both managers into the project. The
operations are explicitly scoped:

- `--target codex|claude|both|none` (or `--no-skill`) selects the manager
  targets; the default is `both` for the project.
- `--user` switches to a user-wide install under `HOME` —
  `HOME/.agents/skills/junior` for Codex and `HOME/.claude/skills/junior` for
  Claude Code. Without `--user`, `init` never writes outside the project.
- `--skill-root DIR` supplies an explicit skill root (for example a Windows
  manager user directory) and overrides the resolved root.

Reruns are safe: an identical copy is left as-is, a missing copy is created, an
unmodified but outdated copy is reported and preserved until `--upgrade`, and a
customized copy is reported as a conflict and preserved unless `--force` is
given. Junior records the hash it wrote in a `.junior-manifest.json` beside the
installed skill; `--upgrade` only replaces a file whose current hash still
matches that manifest, so a customization is never silently overwritten.

##### Installing Pi (`init`)
`init` installs Pi when it is missing (opt out with `--no-install`; the older
`--install` flag is still accepted). The Pi install:

- Uses the pinned tested `@earendil-works/pi-coding-agent@1.0.3` release; preserves an existing working Pi installation. The local Pi
  `package.json` can also be inspected for version diagnosis (no floating install version).
- Runs `npm install -g --ignore-scripts <name>@<version>` as argv with no shell
  interpolation and a bounded `300000` ms timeout.

After a successful installation, readiness is checked again. Fresh installations use the pinned version even when no local Pi metadata exists. It
reports authentication and model setup instructions to run with the
active Node/nvm.

The JSON result keeps the Pi-only `install` field for compatibility and adds an
`installSummary` that distinguishes the two explicit attempts:
`installSummary.pi` (`attempted`/`ok`) for Pi, `installSummary.tools` for the
prebuilt tools (or `null` when not attempted), plus a combined
`installSummary.attempted` and `installSummary.ok`. A Pi that was already
present is not re-attempted, so the combined `attempted` is truthful about what
actually ran, and the process exits nonzero only when an attempted install
failed.

##### Prebuilt release tools (`init`, `update`, `--with-triz`)
`init` also downloads checksum-verified **prebuilt** binaries for the
FMECA, CPM Planner and Crossmatrix MCP servers; no Rust, Cargo or Git local
build is ever performed, and no shell installer is used. Releases come from the
stable GitHub release API for `praxec/fmeca`, `praxec/cpm-planner` and
`praxec/crossmatrix`.

- Asset names are `<binary>-<triple>.tar.gz` on Linux/macOS and
  `<binary>-<triple>.zip` on Windows. Supported targets:

  | OS | Architecture | Target triple |
  | --- | --- | --- |
  | Linux (incl. WSL) | x64 | `x86_64-unknown-linux-gnu` |
  | Linux (incl. WSL) | arm64 | `aarch64-unknown-linux-gnu` |
  | macOS | x64 | `x86_64-apple-darwin` |
  | macOS | arm64 | `aarch64-apple-darwin` |
  | Windows | x64 | `x86_64-pc-windows-msvc` |
  | Windows | arm64 | `aarch64-pc-windows-msvc` |

- Windows ARM64 is detected from the native processor environment even when the
  running Node process is x64-emulated. An unsupported OS/architecture fails
  explicitly with the matrix above; there is no compile fallback.
- Every selected asset must match a SHA-256 from the release's
  `checksums.sha256` (or the release asset digest metadata) before it is
extracted. Downloads are HTTPS-only to approved GitHub release hosts (redirects
are re-validated) and are bounded by request timeout, size and an overall
install deadline.
- Archives are listed first; absolute paths, `..` traversal and symlink /
  hardlink entries are rejected. The exact regular binary entry is streamed out
  with the system `tar` and written atomically only to the managed destination.
- A downloaded binary must pass a conservative MCP `initialize` protocol probe
  (no model call) before it replaces anything. A failed download, checksum,
  extraction or probe preserves the previous working install.
- The first explicit install resolves the current complete published release.
  Re-running is idempotent and does not re-download; a newer release is reported
  but not adopted until `junior update` (or `init --update`). Installed version, repo, tag, source SHA,
  asset digest, binary digest and path are recorded in the managed user-state
  manifest and `.delivery/setup/hop.json`; existing project id, revision,
  acceptance, native paths and snapshots are preserved, and explicitly custom
  tool command/args/env are never overwritten. The recorded **source SHA** is
  taken only from the checksum-verified `release-manifest.json` (`sourceSha` for
  Praxec, `commit` for TRIZ); it is never fabricated from the binary digest. A
  new-format manifest must agree with the release tag and list all six supported
  targets, or the install fails explicitly.
- `--with-triz` additionally downloads the optional portable compiled-JS archive
  from `matt-cochran/triz` (`triz-vVERSION-node.tgz`), verifies its checksum and
  resolves `dist/triz.js`. The file is installed under a managed
  `package.json` (`"type": "module"`) and must pass a bounded offline ESM smoke
  test before it replaces a working installation, so a broken module or missing
  ESM metadata preserves the previous working TRIZ. A newer TRIZ release is
  never adopted without an explicit `--update`. TRIZ stays a separate CLI run
  with the active Node; it is never compiled locally and never makes a paid
  model call.
- `doctor` verifies each recorded binary against its recorded SHA-256 and checks
  the executable bit before calling it usable; a bare file's existence is not
  enough. A configured local path in `.delivery/setup/hop.json` is reported as
  usable **unverified** provenance when no managed install is present.

Prerequisites for the prebuilt tools are Node, a system `tar`, and `npm` for Pi
and the companion tools. Rust/Cargo and Git are **not** client requirements.

A fresh `junior tools init` HOP points each tool at its managed binary and
records the installed version when one is present (`JUNIOR_TOOLS_ROOT`
overrides `~/.junior/tools`); otherwise it uses the bare command on `PATH`.

##### Companion tools and skills
`init` also installs the npm companion CLIs, which carry the tools' own agent
skills and MCP launchers for the manager's agent:

| Companion | npm package | CLI | Skills installed with |
| --- | --- | --- | --- |
| FMECA | `@matthew-cochran/fmeca` | `fmeca-mcp` | `fmeca-mcp skills install --target <t> --project <cwd>\|--user` |
| CPM Planner | `@matthew-cochran/cpm` | `cpm` | `cpm skills install --target <t> --project <cwd>\|--user` |
| Crossmatrix | `@matthew-cochran/crossmatrix` | `crossmatrix-mcp` | `crossmatrix-mcp skills install --target <t> --project <cwd>\|--user` |
| jevitate | `@jevitate/cli` | `jevitate` | `jevitate init --skip-keys --skip-project --targets <ids>` |
| TRIZ | `@matthew-cochran/triz` | `triz` | none yet |

- A missing companion is installed with `npm install -g --prefer-online
  <pkg>@latest` (argv, no shell); an installed one is left alone unless you
  update. `--no-companions` skips companions entirely.
- Skills go to the same `--target` and scope as Junior's own skill (`both` maps
  to each tool's `all`/`claude-code,codex`). Each installer keeps files you
  edited. jevitate's installer also writes its user-level Claude Code skills and
  registers its MCP server; FMECA and CPM are not registered as MCP servers,
  because delegated runs reach them through `junior tools call` (see
  `doctor`'s `companions[].mcpRegister` for the one-line command if you want them
  interactively).
- Files that became untracked during the skill install are recorded as exact
  local Git exclusions, like Junior's own generated files, so the checkout stays
  ready for a `worktree` handoff. A tracked file an installer edits (for
  example an `AGENTS.md` block) is listed in `companions.modifiedTracked` for
  you to review and commit; it is never hidden.
- `junior matrix init [--dir <project>]` creates the project's committed
  `.crossmatrix/` store through the Crossmatrix 0.3.0+ `crossmatrix-mcp init`
  command (PATH first, then the managed binary). `junior init` does not create
  the store itself; it only suggests `junior matrix init` when `.crossmatrix/`
  is absent.

##### Keeping tools current
`junior doctor --check-updates` compares the managed binaries with their latest
GitHub releases and the companions with npm `latest` (read-only; nothing is
downloaded) and reports `updates.managed.outdated` and `updates.companions`.
`junior update` adopts every newer managed and companion release and replaces
only skill copies Junior or the tool itself wrote and you have not modified.

#### Authentication and the paid smoke test
Authenticate through Pi itself: start `pi` and run `/login`, then choose a model
with `/model`. For headless or scripted setups, `junior auth` stores a provider
API key in Pi's `auth.json` without opening an interactive session. Either way
the setup commands never print, copy, or read a credential value for output.

`junior auth set <provider> [--verify]` reads the key from **stdin only** —
never a command-line argument, so it cannot leak through a process listing or
shell history — and writes an atomic replacement for `auth.json` in the Pi agent
directory (`PI_CODING_AGENT_DIR`, else `$HOME/.pi/agent`). The file ends up mode
`0600` and its directory mode `0700`; unrelated provider entries are preserved,
and a malformed or non-object existing file is refused unchanged. `junior auth
remove <provider>` deletes one entry and preserves the rest.

```bash
printf '%s' "$OPENROUTER_API_KEY" | junior auth set openrouter --verify
junior auth remove openrouter
```

`--verify` applies to `set` and is opt-in and only meaningful for `openrouter`:
it makes one read-only request to the key-status endpoint and reports `valid`,
`usage`, `limit`, `remaining` and `ready`. For another provider it records
`verified: null` with a clear reason instead of probing the wrong endpoint. The
key itself is never returned or written to the result.

The setup checks are free. A **paid smoke test is a separate, explicit opt-in**:
run a live task without `--mock`, for example
`node worker.ts run tasks/example-task.json`. That is the only path that spends
money. It is never part of `node --test worker.test.ts`, and `doctor`/`init`
never trigger it. Use `--mock` for an offline simulation.

