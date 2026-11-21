// ---------------------------------------------------------------------------
// Human approval for agent-raised policy changes.
//
// An agent shell may propose a larger budget or a new external-context
// consent, but it may not authorize either itself. requireHuman refuses when
// an agent environment has no controlling terminal; on a terminal it shows a
// one-time six-character code that the human must type back. There is no
// --yes bypass. Budget approvals are recorded locally so the next preflight
// can verify that a human approved the exact contract and amount.
// ---------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import { systemClock, type Clock } from './clock.ts';

export const E_HUMAN_APPROVAL_REQUIRED = 'E_HUMAN_APPROVAL_REQUIRED';

/** Environment markers left by an agent shell. Presence means the caller is an
 * agent, not a human at a terminal. */
export const AGENT_ENVIRONMENT_KEYS = [
  'CLAUDECODE',
  'PI_CODING_AGENT',
  'JUNIOR_WORKER',
  'CODEX_SANDBOX',
  'CURSOR_AGENT',
] as const;

export type AgentEnvironmentKey = typeof AGENT_ENVIRONMENT_KEYS[number];

/** The first agent-shell marker present in `env`, or null for a human shell. */
export function agentEnvironment(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of AGENT_ENVIRONMENT_KEYS) {
    if (env[key]) return key;
  }
  return null;
}

/** A refused human approval. `code` is stable for programmatic handling. */
export class HumanApprovalError extends Error {
  readonly code = E_HUMAN_APPROVAL_REQUIRED;

  constructor(message: string) {
    super(`${E_HUMAN_APPROVAL_REQUIRED}: ${message}`);
    this.name = 'HumanApprovalError';
  }
}

export type HumanPrompt = (question: string) => string | Promise<string>;

export type HumanApprovalOptions = {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  prompt?: HumanPrompt;
  /** Injectable entropy for the six-character display code. */
  randomCode?: () => string;
};

/** A stable six-character code. Letters and digits avoid shell escaping and
 * ambiguous lowercase input; the answer is compared case-insensitively. */
function defaultCode(): string {
  return randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
}

async function terminalPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * Require a human to authorize `action` and return the human-issued token.
 *
 * - Agent environment without a TTY: refuse before prompting.
 * - TTY: show a six-character code and accept only that code typed back.
 * - Non-agent, non-TTY: no terminal handshake is possible, but this is not an
 *   agent shell, so the caller may continue with a fresh token.
 */
export async function requireHuman(action: string, options: HumanApprovalOptions = {}): Promise<string> {
  if (!action || !action.trim()) throw Error('requireHuman needs an action to approve');
  const env = options.env ?? process.env;
  const marker = agentEnvironment(env);
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  if (marker && !isTTY) {
    throw new HumanApprovalError(
      `${action} must be approved by a human. Agent shell detected (${marker}) without a controlling terminal; run this in your own terminal: ${action}`,
    );
  }
  const token = (options.randomCode ?? defaultCode)();
  if (!/^[A-Za-z0-9]{6}$/.test(token)) throw Error('Human approval codes must be six letters or digits');
  if (!isTTY) return token;
  const prompt = options.prompt ?? terminalPrompt;
  const answer = String(await prompt(`Human approval required for ${action}\nEnter code ${token}: `)).trim();
  if (answer.toUpperCase() !== token.toUpperCase()) {
    throw new HumanApprovalError(`${action} was not approved: the typed code did not match. Nothing was recorded.`);
  }
  return token;
}

// ---------------------------------------------------------------------------
// Budget approvals
//
// A human-issued approval covers one contract id up to an approved maximum.
// The unchanged workflow default never needs an approval.
// ---------------------------------------------------------------------------

export type BudgetApproval = {
  id: string;
  maxTotalTokens: number;
  approvedAt: string;
  token: string;
};

export type BudgetApprovalInput = {
  id: string;
  maxTotalTokens: number;
  token: string;
  approvedAt?: string;
};

/** The project-local approval file. It contains no credential; the token only
 * binds the record to the human approval that created it. */
export function budgetApprovalsPath(project: string): string {
  return join(resolve(project), '.junior', 'budget-approvals.json');
}

function validApproval(value: unknown): value is BudgetApproval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && !!record.id.trim()
    && typeof record.maxTotalTokens === 'number' && Number.isFinite(record.maxTotalTokens) && record.maxTotalTokens > 0
    && typeof record.approvedAt === 'string'
    && typeof record.token === 'string' && !!record.token.trim();
}

/** Read every well-formed approval, ignoring a missing or malformed file. */
export function readBudgetApprovals(project: string): BudgetApproval[] {
  const path = budgetApprovalsPath(project);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  const values = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as any).approvals)
      ? (parsed as any).approvals
      : parsed && typeof parsed === 'object'
        ? Object.values(parsed as Record<string, unknown>)
        : [];
  return values.filter(validApproval).map((record) => ({
    id: record.id.trim(),
    maxTotalTokens: record.maxTotalTokens,
    approvedAt: record.approvedAt,
    token: record.token,
  }));
}

/** Record a human approval for one contract id, replacing an earlier approval
 * for the same id. Returns the stored record and the file path. */
export function recordBudgetApproval(
  project: string,
  input: BudgetApprovalInput,
  clock: Clock = systemClock,
): { path: string; approval: BudgetApproval } {
  const id = String(input.id ?? '').trim();
  if (!id) throw Error('Budget approval needs a contract id');
  if (!Number.isInteger(input.maxTotalTokens) || input.maxTotalTokens <= 0) {
    throw Error('Budget approval needs a positive integer maxTotalTokens');
  }
  const token = String(input.token ?? '').trim();
  if (!token) throw Error('Budget approval needs the human-issued token');
  const approval: BudgetApproval = {
    id,
    maxTotalTokens: input.maxTotalTokens,
    approvedAt: input.approvedAt ?? clock.iso(),
    token,
  };
  const path = budgetApprovalsPath(project);
  const records = readBudgetApprovals(project).filter((record) => record.id !== id);
  records.push(approval);
  mkdirSync(join(resolve(project), '.junior'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`);
  return { path, approval };
}

/** The approval that covers `id` up to at least `maxTotalTokens`, if any. */
export function findBudgetApproval(project: string, id: string, maxTotalTokens: number): BudgetApproval | null {
  const key = String(id ?? '').trim();
  if (!key || !Number.isFinite(maxTotalTokens)) return null;
  return readBudgetApprovals(project)
    .filter((record) => record.id === key && record.maxTotalTokens >= maxTotalTokens)
    .sort((a, b) => b.maxTotalTokens - a.maxTotalTokens)[0] ?? null;
}
