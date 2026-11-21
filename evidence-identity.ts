// Governed evidence identity for check results (#280), lane E1.
//
// A check result proves something only about the inputs it ran on. The
// identity names those inputs: the touched projects' working-tree contents,
// the check command and its filter, the dependency lockfiles and the
// toolchain. `junior land` reuses a lane's evidence only when the identity it
// recomputes on the integration worktree is equal.

import type { CheckPhase, CheckTiming, EvidenceIdentity } from './worker-receipt.ts';

export interface CheckIdentityInput {
  /** Repository checkout the check ran in (the worktree for an isolated run). */
  cwd: string;
  check: { command: string; args?: string[]; cwd?: string };
  /** Files the run changed, relative to `cwd`; the projects that contain them are hashed. */
  touchedFiles: string[];
  /** Injected for tests: resolves a tool's version string. */
  toolVersion?: (tool: string) => string | null;
}

/** Compute the identity of one check. Never throws: on a git error the tree is `unknown:<reason>`, which never equals anything. */
export function checkIdentity(_input: CheckIdentityInput): EvidenceIdentity | null {
  return null;
}

/** True only when every field of both identities is equal and neither tree is `unknown:`. */
export function identityEqual(a: EvidenceIdentity | null | undefined, b: EvidenceIdentity | null | undefined): boolean {
  return false;
}

/** Classify a check argv as build, test or other. */
export function classifyCheck(_argv: string[]): CheckPhase {
  return 'other';
}

/** Sum check durations by phase. `warm` is passed through from the run's warm-start result. */
export function checkTiming(_checks: { phase?: CheckPhase; durationMs?: number }[], warm: boolean | null): CheckTiming {
  return { buildMs: 0, testMs: 0, otherMs: 0, warm };
}
