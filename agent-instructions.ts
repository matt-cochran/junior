// Junior-owned agent instruction files (ADR 0018 R11).
//
// `init` and `update` keep exactly one managed `<junior>` block in CLAUDE.md
// (claude target) and AGENTS.md (codex target; Codex and Cursor read it). The
// block routes agents through the four ADR checkpoints. File bytes outside the
// block are preserved, an unchanged block is never rewritten, and a duplicated,
// nested or unbalanced tag is reported without writing the file.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectBlock, upsertBlock } from './managed-block.ts';

export const AGENT_INSTRUCTIONS_VERSION = 1;

/** The exact guidance written into every managed block (R11: the four
 * checkpoints, "stop and show the human", and the human-only decision). */
export function renderAgentInstructions(): string {
  return [
    'Use the installed Junior skill for delegation, CPM planning, FMECA risk, crossmatrix traceability and investigations; run `junior routes "<request>"` when unsure which command fits. Review receipts and independent checks before accepting work.',
    '',
    'ADR compliance checkpoints (ADR 0018). Run the check, and if it reports findings, stop and show them to the human; never record a decision yourself:',
    '- Design: before accepting a design, plan or brief, `junior adr check --stage design --input <file>`.',
    '- Ticket proposal: before filing a ticket, `junior adr check --stage ticket --draft <file>`.',
    '- Ticket pickup: before starting work on a ticket, `junior adr check --stage ticket --ticket <id>`.',
    '- Implementation: before opening a pull request, `junior adr check --stage implementation`.',
    'The human resolves a finding with `junior adr decide` (override with a reason, amend the ADR, or revise the work). If the repository has no ADRs, offer `junior adr init` and ask before running it.',
  ].join('\n');
}

export type AgentTarget = 'codex' | 'claude' | 'both' | 'none';

export type AgentInstructionDeps = {
  exists?: (path: string) => boolean;
  readFile?: (path: string, encoding?: string) => string;
  writeFile?: (path: string, data: string) => void;
};

export type AgentFileAction = 'created' | 'added' | 'updated' | 'unchanged' | 'skipped' | 'conflict';

export type AgentFileResult = {
  path: string;
  action: AgentFileAction;
  reason?: string;
  lines?: number[];
};

export type ApplyAgentInstructionsResult = { files: AgentFileResult[] };

export type InspectAgentInstructionsResult = {
  path: string;
  state: 'current' | 'outdated' | 'missing' | 'conflict';
  lines?: number[];
};

/** Map a skill target to the instruction files it owns (R11). */
export function instructionFiles(target: AgentTarget): string[] {
  if (target === 'claude') return ['CLAUDE.md'];
  if (target === 'codex') return ['AGENTS.md'];
  if (target === 'both') return ['CLAUDE.md', 'AGENTS.md'];
  return [];
}

function read(deps: AgentInstructionDeps, path: string): string {
  return (deps.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(path, 'utf8');
}

function exists(deps: AgentInstructionDeps, path: string): boolean {
  return (deps.exists ?? existsSync)(path);
}

function write(deps: AgentInstructionDeps, path: string, data: string): void {
  (deps.writeFile ?? ((p: string, d: string) => writeFileSync(p, d)))(path, data);
}

function sameContent(blockContent: string): boolean {
  return blockContent.replace(/\r\n/g, '\n').trimEnd() === renderAgentInstructions();
}

/** Keep exactly one managed block in each target file (R11).
 *
 * `init` creates missing files and upserts existing ones; `update` only
 * upserts files that already exist and reports a missing file as skipped. A
 * conflict reports its reason and lines and leaves that file untouched. */
export function applyAgentInstructions(
  cwd: string,
  opts: { target: AgentTarget; command: 'init' | 'update'; deps?: AgentInstructionDeps },
): ApplyAgentInstructionsResult {
  const deps = opts.deps ?? {};
  const content = renderAgentInstructions();
  const files: AgentFileResult[] = [];

  for (const file of instructionFiles(opts.target)) {
    const path = join(cwd, file);

    if (!exists(deps, path)) {
      if (opts.command === 'update') {
        files.push({ path: file, action: 'skipped' });
        continue;
      }
      const block = upsertBlock('', content);
      if ('conflict' in block) {
        files.push({ path: file, action: 'conflict', reason: block.conflict.reason, lines: block.conflict.lines });
        continue;
      }
      write(deps, path, block.text);
      files.push({ path: file, action: 'created' });
      continue;
    }

    const text = read(deps, path);
    const seen = inspectBlock(text);
    if (seen.state === 'conflict') {
      files.push({ path: file, action: 'conflict', reason: seen.reason, lines: seen.lines });
      continue;
    }

    const result = upsertBlock(text, content);
    if ('conflict' in result) {
      files.push({ path: file, action: 'conflict', reason: result.conflict.reason, lines: result.conflict.lines });
      continue;
    }

    if (seen.state === 'absent') {
      write(deps, path, result.text);
      files.push({ path: file, action: 'added' });
      continue;
    }

    if (!result.changed) {
      files.push({ path: file, action: 'unchanged' });
      continue;
    }

    write(deps, path, result.text);
    files.push({ path: file, action: 'updated' });
  }

  return { files };
}

/** Report each target file for `doctor`: current, outdated, missing or conflict. */
export function inspectAgentInstructions(
  cwd: string,
  opts: { target: AgentTarget; deps?: AgentInstructionDeps },
): InspectAgentInstructionsResult[] {
  const deps = opts.deps ?? {};
  return instructionFiles(opts.target).map((file) => {
    const path = join(cwd, file);
    if (!exists(deps, path)) return { path: file, state: 'missing' as const };

    const seen = inspectBlock(read(deps, path));
    if (seen.state === 'conflict') return { path: file, state: 'conflict' as const, lines: seen.lines };
    if (seen.state === 'absent') return { path: file, state: 'missing' as const };
    return { path: file, state: sameContent(seen.content) ? 'current' as const : 'outdated' as const };
  });
}