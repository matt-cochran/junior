// ---------------------------------------------------------------------------
// Crossmatrix ADR-0004 Dimensions adapters.
//
// Each `*Dimension` export is a PURE adapter: it takes already-read data
// (file bytes, parsed JSON, parsed plan/state graphs) and returns one ADR-0004
// Dimension object. The `junior matrix export` CLI is the thin, side-effecting
// shell around them: it gathers tracked files, reads the jevitate catalog, or
// performs the single `cpm plan.get` / `fmeca state.get` read through the
// existing HOP wrapper, then writes one canonical Dimensions document per
// source through `writeDimensionSet`.
//
// No new dependencies: canonical JSON, hashing and the schema subset checks are
// implemented here. The vendored schema is never modified.
// ---------------------------------------------------------------------------
// This file is a re-export facade per ADR 0016; implementation lives in matrix-adapters.ts, matrix-dimensions.ts and matrix-cli.ts.

import { isDirectEntry } from './cli-entry.ts';
import { main } from './matrix-cli.ts';

export {
  canonicalJson,
  codeLocations,
  cpmDeliverables,
  fmecaFailureModes,
  jevitateJobs,
  jevitateJourneys,
  jevitatePersonas,
  sha256Hex,
  sortKeysDeep,
  tests,
} from './matrix-adapters.ts';
export type {
  DimensionKind,
  DimensionsDocument,
  MatrixDimension,
  MatrixFile,
  MatrixMember,
  MatrixSourceRef,
} from './matrix-adapters.ts';
export { buildDimensionSet, validateDimensionSet, writeDimensionSet } from './matrix-dimensions.ts';
export { MATRIX_USAGE, main, parseMatrixArgs } from './matrix-cli.ts';

if (isDirectEntry(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
