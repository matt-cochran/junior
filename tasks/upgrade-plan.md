# Junior upgrade plan

1. D07: complete change evidence, opt-in worktree isolation and checkout/session locks. DeepSeek executing in /home/mc/working/junior-upgrade; original source retained.
2. D08: one handoff entry point with worktree default, compact manager receipt, execution deadline and bounded explicit repairs.
3. D09: analysis-only FMECA workflow based on tasks/fmeca-source.txt, qualitative risks, verified versus proposed mitigation, bounded iterations.

Acceptance: premium-manager review plus independent offline tests and a CLI integration smoke test. No automatic integration of worker changes; source copy-back only after review. No global auth/config edits or dependency installs.

Additional accepted requirements:
- Bounded execution is a primary NFR: observable progress/quiet state, total deadline, bounded tool execution, process-tree cancellation, partial artifact handback and bounded recovery. Quiet is not proof of stall; no automatic duplicate restart.
- Junior init installs the packaged delegation skill project-locally for Codex and Claude Code by default, preserves customized files, reports created/preserved/outdated status, and offers explicit user-wide target installation. Doctor reports skill discovery readiness. Keep skill copies consistent with the final CLI and runtime guarantees.

D09 additionally includes evaluate analysis workflow based on tasks/evaluate-source.txt: architecture validity first, revised architecture proposal, then qualitative risk review and calibration/observability/incremental delivery reality check. Analysis-only; removal/demotion are proposals, no code authority implied. Bound to three analysis iterations and run deadline; distinguish verified present controls from proposed mitigation and conditional residual risk; allow honest unresolved outcomes. Shared FMECA report conventions rather than duplicate orchestration.

Proposed optional Git handoff (not yet dispatched): source/base SHA, retained worktree, feature branch and exact handoff SHA, optional authorized draft PR URL and from-Junior provenance. CI repair/conflict fixes remain within deliverable scope/deadline/repair budget. Resolve only mechanical conflicts; decision conflicts return to manager. No automatic push/PR/merge implied by a local handoff.

Shared Praxec HOP: versioned JSON manifest with stable IDs, revisions, native state paths, exported snapshots, evidence, tool versions and manager acceptance. FMECA uses JSONL; CPM uses SQLite. Crossmatrix requires explicit model JSON save/reload because its current MCP model is in memory. Reject unsupported operations despite ok:true envelopes. Verify restart recovery for each tool. Jev classifies shared context; Junior executes validated calls. TRIZ remains a separate project built by DeepSeek through Junior.

Accepted implementation: isolated execution/evidence, streaming bounded runtime, compact handoff, fmeca/evaluate reports, init skill installer, common Praxec HOP adapter, optional fresh-session QA. Independently verified native FMECA JSONL, CPM SQLite and Crossmatrix save/replay across fresh processes. TRIZ lives separately at /home/mc/working/triz. GitHub CI and final repository checks added. Automatic PR/CI repair and an OS sandbox remain proposed capabilities, not implemented guarantees.
