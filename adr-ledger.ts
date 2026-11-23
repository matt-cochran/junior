// ---------------------------------------------------------------------------
// Append-only ADR decision ledger.
//
// ADR 0018 R6 makes every human decision about a flagged ADR finding durable,
// committed data. Entries are only ever appended as one JSON line; earlier
// lines are never edited or removed. R7 adds standing exceptions that expire
// by date or when the ADR text changes. R8 lets a ticket-stage decision be
// shown to the design and implementation stages of the same deliverable.
//
// This module is deliberately pure apart from appendDecision/readLedger: the
// active/lapsed/carried-forward queries fold the ledger in file order and do
// no I/O.
//
// #291: a rule-level decision is one entry whose target is ANY_TARGET ('*'),
// and an ADR-level decision also has ruleId ANY_RULE ('*'). The wildcard
// matches every target (and rule) of that ADR, including targets a later check
// flags for the first time. The latest matching entry still wins, whether it
// names one target or the wildcard.

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { systemClock, type Clock } from './clock.ts';

export type AdrDecisionStage = 'design' | 'implementation' | 'ticket';
export type AdrDecisionVerdict = 'contradicts' | 'uncertain' | 'conforms' | 'not_applicable';
export type AdrDecisionConfidence = 'high' | 'medium' | 'low';
export type AdrDecisionKind = 'override' | 'amend' | 'revise';

/** ADR 0018 R6: one recorded human decision in the ledger. */
export interface AdrDecision {
  schemaVersion: 1;
  id: string;
  at: string;
  by: string;
  stage: AdrDecisionStage;
  adrId: string;
  ruleId: string;
  target: string;
  verdict: AdrDecisionVerdict;
  probability: number | null;
  confidence: AdrDecisionConfidence | null;
  decision: AdrDecisionKind;
  rationale: string;
  deliverable?: string;
  pr?: string;
  ticket?: string;
  amendmentAdr?: string;
  expires?: string;
  standing: boolean;
  supersedes?: string;
  adrHash?: string;
}

/** The caller supplies the decision; the ledger owns schemaVersion/id/at. */
export type AdrDecisionInput = Omit<
  AdrDecision,
  'schemaVersion' | 'id' | 'at' | 'probability' | 'confidence' | 'standing'
> & {
  schemaVersion?: 1;
  id?: string;
  at?: string;
  probability?: number | null;
  confidence?: AdrDecisionConfidence | null;
  standing?: boolean;
};

export type AppendDecisionOptions = {
  /** Injected clock, used by tests and deterministic callers: a `() => Date`
   * or a `Clock` (#265). */
  clock?: (() => Date) | Clock;
  /** Alias for clock; a Date is also accepted. */
  now?: Date | (() => Date);
};

export type AdrDecisionKey = {
  adrId: string;
  ruleId: string;
  target: string;
  deliverable?: string;
  stage?: AdrDecisionStage;
};

export type AdrDecisionContext = {
  now: Date;
  adrHash: string;
};

export type AdrObservation = {
  relation: 'adr-conformance';
  from: string;
  to: string;
  token: AdrDecisionKind;
  evidence: string;
};

// Outside .delivery/ (which init excludes locally) so the ledger can be
// committed and worktree handoffs see the same decisions (ADR 0018 R6).
export const LEDGER_PATH = '.junior/adr-decisions.jsonl';

const STAGES = new Set<AdrDecisionStage>(['design', 'implementation', 'ticket']);
const DECISIONS = new Set<AdrDecisionKind>(['override', 'amend', 'revise']);
const VERDICTS = new Set<AdrDecisionVerdict>([
  'contradicts',
  'uncertain',
  'conforms',
  'not_applicable',
]);
const CONFIDENCES = new Set<AdrDecisionConfidence>(['high', 'medium', 'low']);
const UNTIL_ADR_CHANGE = 'until-adr-change';
/** #291: the target of a rule- or ADR-level decision; it matches every target. */
export const ANY_TARGET = '*';
/** #291: the ruleId of an ADR-level decision; it matches every rule of the ADR. */
export const ANY_RULE = '*';
const RFC3339_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2}))?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string when set`);
  }
  return value;
}

function validExpires(value: string): boolean {
  if (value === UNTIL_ADR_CHANGE) return true;
  if (!RFC3339_DATE.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function resolveNow(options: AppendDecisionOptions): Date {
  if (typeof options.clock === 'function') return options.clock();
  if (typeof options.now === 'function') return options.now();
  if (options.now instanceof Date) return options.now;
  return (options.clock ?? systemClock).date();
}

function generatedId(): string {
  return `adrd-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function validate(input: AdrDecisionInput): Omit<AdrDecision, 'id' | 'at'> {
  if (!isRecord(input)) throw new Error('decision input must be an object');

  if (!STAGES.has(input.stage)) {
    throw new Error(`unknown stage: ${String(input.stage)}`);
  }
  if (!DECISIONS.has(input.decision)) {
    throw new Error(`unknown decision: ${String(input.decision)}`);
  }
  if (!VERDICTS.has(input.verdict)) {
    throw new Error(`unknown verdict: ${String(input.verdict)}`);
  }

  const probability = input.probability ?? null;
  if (
    probability !== null &&
    (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1)
  ) {
    throw new Error('probability must be a number between 0 and 1 or null');
  }
  const confidence = input.confidence ?? null;
  if (confidence !== null && !CONFIDENCES.has(confidence)) {
    throw new Error(`unknown confidence: ${String(confidence)}`);
  }

  const rationale = typeof input.rationale === 'string' ? input.rationale : '';
  // ADR 0018 R5: an override is an exception and must say why.
  if (input.decision === 'override' && rationale.trim().length === 0) {
    throw new Error('an override needs a non-empty rationale');
  }
  // ADR 0018 R5: amend names the proposed superseding/updated ADR.
  if (input.decision === 'amend') {
    nonEmpty(input.amendmentAdr, 'amendmentAdr');
  }

  const standing = input.standing === true;
  if (input.standing !== undefined && typeof input.standing !== 'boolean') {
    throw new Error('standing must be a boolean');
  }
  const expires = optionalString(input.expires, 'expires');
  if (standing && expires === undefined) {
    throw new Error('a standing decision needs expires (an RFC 3339 date or until-adr-change)');
  }
  if (expires !== undefined && !validExpires(expires)) {
    throw new Error('expires must be an RFC 3339 date or until-adr-change');
  }

  const by = nonEmpty(input.by, 'by');
  const adrId = nonEmpty(input.adrId, 'adrId');
  const ruleId = nonEmpty(input.ruleId, 'ruleId');
  const target = nonEmpty(input.target, 'target');
  if (ruleId === ANY_RULE && target !== ANY_TARGET) {
    throw new Error(`an ADR-level decision (ruleId ${ANY_RULE}) needs target ${ANY_TARGET}`);
  }
  const deliverable = optionalString(input.deliverable, 'deliverable');
  const pr = optionalString(input.pr, 'pr');
  const ticket = optionalString(input.ticket, 'ticket');
  const amendmentAdr = optionalString(input.amendmentAdr, 'amendmentAdr');
  const supersedes = optionalString(input.supersedes, 'supersedes');
  const adrHash = optionalString(input.adrHash, 'adrHash');

  return {
    schemaVersion: 1,
    by,
    stage: input.stage,
    adrId,
    ruleId,
    target,
    verdict: input.verdict,
    probability,
    confidence,
    decision: input.decision,
    rationale,
    ...(deliverable !== undefined ? {deliverable} : {}),
    ...(pr !== undefined ? {pr} : {}),
    ...(ticket !== undefined ? {ticket} : {}),
    ...(amendmentAdr !== undefined ? {amendmentAdr} : {}),
    ...(expires !== undefined ? {expires} : {}),
    standing,
    ...(supersedes !== undefined ? {supersedes} : {}),
    ...(adrHash !== undefined ? {adrHash} : {}),
  };
}

/**
 * ADR 0018 R6: append one validated decision as exactly one JSON line.
 * The directory and file are created when absent. An existing file is only
 * read to decide whether a separating newline is needed, never rewritten.
 */
export function appendDecision(
  root: string,
  input: AdrDecisionInput,
  options: AppendDecisionOptions = {},
): AdrDecision {
  const entry = validate(input);
  const stored: AdrDecision = {
    ...entry,
    id: generatedId(),
    at: resolveNow(options).toISOString(),
  };

  const path = join(root, LEDGER_PATH);
  mkdirSync(dirname(path), {recursive: true});
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(path, `${prefix}${JSON.stringify(stored)}\n`, 'utf8');
  return stored;
}

/** ADR 0018 R6: read the ledger in file order; a missing file is empty. */
export function readLedger(root: string): AdrDecision[] {
  const path = join(root, LEDGER_PATH);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }

  const entries: AdrDecision[] = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `malformed ADR ledger line ${index + 1}: ${(error as Error).message}`,
      );
    }
    if (!isRecord(parsed)) {
      throw new Error(`malformed ADR ledger line ${index + 1}: expected a JSON object`);
    }
    entries.push(parsed as unknown as AdrDecision);
  }
  return entries;
}

function isSuperseded(entries: readonly AdrDecision[], index: number): boolean {
  const id = entries[index]?.id;
  if (!id) return false;
  for (let later = index + 1; later < entries.length; later += 1) {
    if (entries[later]?.supersedes === id) return true;
  }
  return false;
}

function matchesRule(entry: AdrDecision, ruleId: string): boolean {
  return entry.ruleId === ruleId || entry.ruleId === ANY_RULE;
}

function matchesKey(entry: AdrDecision, key: AdrDecisionKey): boolean {
  return (
    entry.adrId === key.adrId &&
    matchesRule(entry, key.ruleId) &&
    (entry.target === key.target || entry.target === ANY_TARGET)
  );
}

function hasLapsed(entry: AdrDecision, ctx: AdrDecisionContext): boolean {
  if (!entry.standing) return false;
  if (entry.expires === UNTIL_ADR_CHANGE) return entry.adrHash !== ctx.adrHash;
  if (entry.expires === undefined) return false;
  const expiry = Date.parse(entry.expires);
  if (Number.isNaN(expiry)) return true;
  return expiry <= ctx.now.getTime();
}

/**
 * ADR 0018 R6/R7: the latest non-superseded entry for the key that still
 * applies. Non-standing entries cover one deliverable; standing entries apply
 * across deliverables until their expiry date or ADR content hash lapses them.
 */
export function activeDecision(
  entries: readonly AdrDecision[],
  key: AdrDecisionKey,
  ctx: AdrDecisionContext,
): AdrDecision | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || !matchesKey(entry, key)) continue;
    if (isSuperseded(entries, index)) continue;
    if (entry.standing) {
      if (!hasLapsed(entry, ctx)) return entry;
    } else if (entry.deliverable === key.deliverable) {
      return entry;
    }
  }
  return null;
}

/**
 * ADR 0018 R7: the most recent standing entry for the key whose expiry date or
 * ADR content hash has lapsed, so the next run can cite it by id.
 */
export function lapsedStanding(
  entries: readonly AdrDecision[],
  key: AdrDecisionKey,
  ctx: AdrDecisionContext,
): AdrDecision | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || !entry.standing || !matchesKey(entry, key)) continue;
    if (isSuperseded(entries, index)) continue;
    if (hasLapsed(entry, ctx)) return entry;
  }
  return null;
}

/**
 * ADR 0018 R8: the latest ticket-stage decision for the same deliverable,
 * adrId and ruleId, shown to the design and implementation stages.
 */
export function carriedForward(
  entries: readonly AdrDecision[],
  key: Pick<AdrDecisionKey, 'adrId' | 'ruleId' | 'deliverable'>,
): AdrDecision | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.stage !== 'ticket') continue;
    if (entry.adrId !== key.adrId || !matchesRule(entry, key.ruleId)) continue;
    if (entry.deliverable !== key.deliverable) continue;
    return entry;
  }
  return null;
}

/** ADR 0018 R7: sha256 of the ADR text with CRLF normalised to LF. */
export function adrContentHash(markdown: string): string {
  return createHash('sha256').update(markdown.replace(/\r\n/g, '\n')).digest('hex');
}

/** A pure mapping for a later crossmatrix caller; no mirroring happens here. */
export function toObservation(entry: AdrDecision): AdrObservation {
  return {
    relation: 'adr-conformance',
    from: `adr:${entry.adrId}/${entry.ruleId}`,
    to: entry.target,
    token: entry.decision,
    evidence: entry.id,
  };
}
