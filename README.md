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
build and no runtime npm dependency. Installation does not authorize paid model
calls.

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

## What's in the box

- **[Getting started](docs/getting-started.md)** — setup, the `doctor`/`init`
  readiness commands, Pi installation and authentication.
- **[Contracts](docs/contracts.md)** — the contract schema, micro-deliverable
  stages, workflow templates, session continuation and the Jev gates.
- **[Runtime](docs/runtime.md)** — execution receipts, cost and billing, Git
  worktree isolation, change evidence, deadlines and the compact handoff.
- **[Tools](docs/tools.md)** — common tool handoffs, `junior report-issue`, MCP
  registration and frontier-attention classification.
- **[Releasing](docs/releasing.md)** — packing, publishing and trusted-publisher
  setup.

## Documentation

| Document | Contents |
| --- | --- |
| [README](README.md) | This front page. |
| [docs/getting-started.md](docs/getting-started.md) | Install, quickstart, `doctor` and `init`. |
| [docs/contracts.md](docs/contracts.md) | Contract fields, workflows, sessions and Jev gates. |
| [docs/runtime.md](docs/runtime.md) | Receipts, cost, isolation, evidence and the handoff. |
| [docs/tools.md](docs/tools.md) | Companion tools, `report-issue` and MCP registration. |
| [docs/releasing.md](docs/releasing.md) | Packing and publishing. |
| [skills/junior/SKILL.md](skills/junior/SKILL.md) | The agent instructions that `junior init` installs into your project. |
| [CHANGELOG.md](CHANGELOG.md) | Release history. |

## Contributing, security and support

- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability.
- [SUPPORT.md](SUPPORT.md) — troubleshooting and where to ask.
- [LICENSE](LICENSE) — MIT.
