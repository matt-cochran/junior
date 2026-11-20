/**
 * ADR retrieval (#276): which ADRs the gate must judge for a subject no matter
 * what the relevance pre-filter or the applies_to scope says. runAdrGate keeps
 * every ADR this returns a reason for, so a cited, path-scoped or on-topic ADR
 * is never silently skipped.
 *
 * Phase-1 contract seam (contracts/phase1.md §1): this stub returns null; lane
 * A1 implements the rules.
 */
import type { Adr } from './adr.ts';
import type { GateSubject } from './adr-gate.ts';

export type MustJudgeReason = 'cited' | 'scope' | 'topic';

/** Why `adr` must be judged for `subject`, or null when the normal filters decide. */
export function mustJudge(_adr: Adr, _subject: GateSubject): MustJudgeReason | null {
  return null;
}
