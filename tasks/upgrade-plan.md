# Junior upgrade plan

1. D07: complete change evidence, opt-in worktree isolation and checkout/session locks. DeepSeek executing in /home/mc/working/junior-upgrade; original source retained.
2. D08: one handoff entry point with worktree default, compact manager receipt, execution deadline and bounded explicit repairs.
3. D09: analysis-only FMECA workflow based on tasks/fmeca-source.txt, qualitative risks, verified versus proposed mitigation, bounded iterations.

Acceptance: premium-manager review plus independent offline tests and a CLI integration smoke test. No automatic integration of worker changes; source copy-back only after review. No global auth/config edits or dependency installs.

Additional accepted requirements:
- Bounded execution is a primary NFR: observable progress/quiet state, total deadline, bounded tool execution, process-tree cancellation, partial artifact handback and bounded recovery. Quiet is not proof of stall; no automatic duplicate restart.
- Junior init installs the packaged delegation skill project-locally for Codex and Claude Code by default, preserves customized files, reports created/preserved/outdated status, and offers explicit user-wide target installation. Doctor reports skill discovery readiness. Keep skill copies consistent with the final CLI and runtime guarantees.
