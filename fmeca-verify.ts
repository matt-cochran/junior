export type Proposal = {
  criterion: string;
  run: string;
  mitigation: string;
  request: {
    tool: 'append';
    arguments: {
      session_id: string;
      variant: 'set_mitigation_status';
      mitigation_id: string;
      status: 'verified';
      evidence: Array<{kind: 'test'; reference: string; basis: 'test'}>;
      note: string;
    };
  };
};

export type Skipped = {
  criterion: string;
  entry: unknown;
  reason: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function criteriaOf(result: unknown): unknown[] | undefined {
  if (!isRecord(result)) return undefined;
  const jev = result.jev;
  if (!isRecord(jev)) return undefined;
  const postflight = jev.postflight;
  if (!isRecord(postflight)) return undefined;
  const criteria = postflight.criteria;
  return Array.isArray(criteria) ? criteria : undefined;
}

/**
 * ADR 0011 R5: propose set_mitigation_status(verified) requests for every
 * (criterion, mitigation) pair whose criterion is met at tier check_passed.
 * Pure: reads the result in memory, performs no I/O and calls nothing.
 */
export function proposeVerified(
  result: unknown,
  runRef: string,
): {proposals: Proposal[]; skipped: Skipped[]} {
  const proposals: Proposal[] = [];
  const skipped: Skipped[] = [];
  const criteria = criteriaOf(result);
  if (!criteria) return {proposals, skipped};

  for (const criterion of criteria) {
    if (!isRecord(criterion)) continue;
    if (criterion.verdict !== 'met' || criterion.tier !== 'check_passed') continue;
    const id = criterion.id;
    if (typeof id !== 'string') continue;
    const mitigates = criterion.mitigates;
    if (!Array.isArray(mitigates)) continue;

    for (const entry of mitigates) {
      if (typeof entry !== 'string') {
        skipped.push({criterion: id, entry, reason: 'mitigates entry is not a string'});
        continue;
      }
      const slash = entry.indexOf('/');
      const sessionId = slash > 0 ? entry.slice(0, slash) : '';
      const mitigationId = slash >= 0 ? entry.slice(slash + 1) : '';
      if (!sessionId || !mitigationId) {
        skipped.push({
          criterion: id,
          entry,
          reason: "mitigates entry is not '<session_id>/<mitigation_id>'",
        });
        continue;
      }
      proposals.push({
        criterion: id,
        run: runRef,
        mitigation: entry,
        request: {
          tool: 'append',
          arguments: {
            session_id: sessionId,
            variant: 'set_mitigation_status',
            mitigation_id: mitigationId,
            status: 'verified',
            evidence: [{kind: 'test', reference: `${runRef}:${id}`, basis: 'test'}],
            note: `criterion ${id} met at tier check_passed`,
          },
        },
      });
    }
  }

  return {proposals, skipped};
}
