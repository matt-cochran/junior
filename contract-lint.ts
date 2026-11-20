/**
 * Contract-shape lint (#279), run by `junior validate`, `junior handoff`
 * preflight (through validate) and `junior plan check`.
 *
 * Phase-1 contract seam (contracts/phase1.md §4): this stub finds nothing;
 * lane L1 implements CHECK_UNFILTERED and CONTRACT_OVER_BUDGET.
 */

export type ContractLintCode = 'CHECK_UNFILTERED' | 'CONTRACT_OVER_BUDGET';

export interface ContractLintFinding {
  code: ContractLintCode;
  /** 'error' only under jev.mode enforce; validate then refuses the contract. */
  severity: 'warning' | 'error';
  message: string;
  /** A concrete fix: the filtered check command, or the code/test split. */
  suggestion?: string;
  /** Index into checks for CHECK_UNFILTERED. */
  checkIndex?: number;
}

export interface ContractLintOptions {
  /** Directory whose past `.delivery/<id>/<stamp>/result.json` receipts give tokens per changed line. */
  deliveryDir?: string;
}

export function contractLint(_t: any, _opts: ContractLintOptions = {}): ContractLintFinding[] {
  return [];
}
