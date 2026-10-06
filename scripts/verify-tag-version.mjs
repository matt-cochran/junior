#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Release gate: the git tag must exactly match the package.json version.
//
// Tag pushes (`vX.Y.Z`) and manual dispatch (INPUT_TAG=vX.Y.Z) both funnel
// through this check, so a mismatched or unpinned release can never publish.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const refType = process.env.GITHUB_REF_TYPE;
const refName = process.env.GITHUB_REF_NAME ?? '';
const inputTag = process.env.INPUT_TAG ?? '';
const tag = refType === 'tag' ? refName : inputTag;

if (!tag) {
  console.error('No release tag: push a vX.Y.Z tag or set INPUT_TAG for a manual run.');
  process.exit(1);
}
const expected = `v${pkg.version}`;
if (tag !== expected) {
  console.error(`Release tag ${tag} does not match package version ${pkg.version} (expected ${expected}).`);
  process.exit(1);
}
console.log(`Release tag ${tag} matches package version ${pkg.version}.`);
