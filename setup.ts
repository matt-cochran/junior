// ---------------------------------------------------------------------------
// Read-only `doctor` and idempotent `init` for the delivery worker CLI.
//
// Both commands are offline by default. `doctor` only inspects local state:
// the running Node, the `pi` executable (`pi --version`), Pi's local auth file
// (presence only, never values) and Pi's local model catalog. It never
// installs anything, writes configuration, or makes a paid network call.
//
// `init` writes project-local files only when absent and never touches global
// auth or model configuration. Installing Pi is available only through the
// explicit `init --install` flag, which uses npm argv (no shell) and the exact
// pinned tested package version; inspect the local Pi
// package.json for diagnostics.
//
// This file is a facade (ADR 0016). The implementation lives in setup-env.ts,
// setup-skill.ts, setup-doctor.ts and setup-init.ts; this file re-exports the
// original setup.ts API so importers and tests need no changes.
// ---------------------------------------------------------------------------

export { CLAUDE_STORE_DENY_RULES, inspectStoreDenyRules, installStoreDenyRules, mergeStoreDenyRules } from './harness.ts';

export { DEFAULT_MODEL, DEFAULT_PROVIDER, DOCTOR_TIMEOUT_MS, INSTALL_TIMEOUT_MS, PACKAGED_SKILL_PATH, PI_PACKAGE, SKILL_FILENAME, SKILL_MANIFEST_FILENAME, SKILL_NAME, SUPPORTED_NODE_MIN, TESTED_PI_VERSION, checkPi, compareSemver, discoverInstalledPi, loadDefaults, resolveJuniorCliPath, whichOnPath } from './setup-env.ts';
export type { ExecResult, SetupDeps, PiVersionStatus, PiProbeStatus, PiCheck, Defaults } from './setup-env.ts';

export { inspectSkill, installSkill } from './setup-skill.ts';
export type { SkillManager, SkillTargetSelection, SkillScope, SkillActionStatus, SkillAction, SkillResult, SkillReadiness, SkillInstallOptions, InitOptions } from './setup-skill.ts';

export { OPENROUTER_KEY_URL, checkCredentials, checkCredentialsOnline, checkModel, detectSlowMount, doctor, inspectGateways, inspectLitellm, loadTestedPi, summarizeInstall } from './setup-doctor.ts';
export type { CredentialCheck, FetchResponse, FetchLike, OnlineCredentialCheck, ModelStoreStatus, ModelCheck, TestedPi, GatewayKindStatus, JevGatewayStatus, LitellmStatus, GatewaysResult, DoctorCheck, DoctorVerdict, DoctorResult, InitInstallAttempt, InitInstallSummary } from './setup-doctor.ts';

import { init as initProject, parseInitOptions, setupCompanions } from './setup-init.ts';
import type { MatrixOutcome, InitResult, CompanionSetupResult } from './setup-init.ts';
import { installStoreDenyRules } from './harness.ts';

/** Project setup also locks down an existing `.crossmatrix/` store with the
 * Claude Code deny rules, so the CLI/MCP stays the only route to it. */
export function init(deps:SetupDeps = {}, opts:InitOptions = {}):InitResult {
 const result:any=initProject(deps, opts);
 try {
  const lockdown=installStoreDenyRules({ projectDir:result.cwd });
  if (lockdown.changed) result.storeLockdown=lockdown;
 } catch { /* doctor reports an unwritable settings file */ }
 return result;
}

export { parseInitOptions, setupCompanions };
export type { MatrixOutcome, InitResult, CompanionSetupResult } from './setup-init.ts';
