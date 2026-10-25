// ---------------------------------------------------------------------------
// `junior compute` local control-plane CLI.
//
// This module is the public, file-backed edge around the pure domain contract
// in compute.ts. It implements the three local commands that an operator uses
// before any provider call:
//
//   • `init` validates a policy completely before atomically recording it. An
//     invalid or unsafe policy never reaches disk.
//   • `doctor` reports policy readiness, explicit adapter capabilities and the
//     ownership safety of every recorded resource status.
//   • `status` prints one versioned, machine-readable status document plus its
//     inspection, so callers key on stable codes rather than prose.
//
// All state lives under `<cwd>/.delivery/compute` as ordinary JSON. Tests use
// fake provider/capability/status fixtures only; this module performs no
// network or provider work.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDirectEntry } from './cli-entry.ts';
import {
  COMPUTE_CLI_SCHEMA,
  COMPUTE_MODE_OPERATIONS,
  COMPUTE_MODES,
  COMPUTE_OPERATIONS,
  COMPUTE_SCHEMA_VERSION,
  DEFAULT_COMPUTE_POLICY,
  inspectComputeCapabilities,
  inspectComputePolicy,
  inspectComputeStatus,
  type ComputeCapability,
  type ComputeCapabilityInspection,
  type ComputeCliOption,
  type ComputeOperation,
  type ComputePolicyInspection,
} from './compute.ts';

export type ComputeCliDeps = {
  cwd?: string;
  out?: (line: string) => void;
};

type ParsedCompute = {
  command: string;
  flags: Set<string>;
  values: Record<string, string>;
};

type CommandOutcome = { exitCode: number; result: Record<string, unknown> };

class ComputeUsageError extends Error {}

const IMPLEMENTED_COMMANDS = new Set(['init', 'doctor', 'status']);
const COMPUTE_USAGE = [
  'Usage: junior compute <command> [options]',
  '  init    [--config <path>] [--mode adopt|managed-existing|provision] [--dry-run] [--json]',
  '  doctor  [--json]',
  '  status  --resource <id> [--json]',
].join('\n');

export function computeStateDir(cwd: string): string {
  return join(cwd, '.delivery', 'compute');
}

export function computePolicyPath(cwd: string): string {
  return join(computeStateDir(cwd), 'policy.json');
}

export function computeCapabilitiesPath(cwd: string): string {
  return join(computeStateDir(cwd), 'capabilities.json');
}

export function computeStatusDir(cwd: string): string {
  return join(computeStateDir(cwd), 'status');
}

export function computeStatusPath(cwd: string, resourceId: string): string {
  return join(computeStatusDir(cwd), `${resourceId}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resourceIdIsSafe(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0');
}

function policyInspectionError(message: string): ComputePolicyInspection {
  return {
    valid: false,
    safe: false,
    issues: [{ code: 'policy.object', severity: 'invalid', path: '', message }],
  };
}

function readJson(path: string): { found: boolean; value?: unknown } {
  if (!existsSync(path)) return { found: false };
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return { found: true, value };
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function commandOptions(command: string): readonly ComputeCliOption[] {
  const entry = COMPUTE_CLI_SCHEMA.commands.find((candidate) => candidate.name === command);
  if (!entry) throw new ComputeUsageError(COMPUTE_USAGE);
  return entry.options as readonly ComputeCliOption[];
}

function parseComputeCommand(argv: string[]): ParsedCompute {
  const command = argv[0];
  if (!command || !IMPLEMENTED_COMMANDS.has(command)) throw new ComputeUsageError(COMPUTE_USAGE);
  const options = commandOptions(command);
  const flags = new Set<string>();
  const values: Record<string, string> = {};

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('-')) throw new ComputeUsageError(`Unexpected argument for compute ${command}: ${arg}`);
    if (!arg.startsWith('--')) throw new ComputeUsageError(`Unknown option for compute ${command}: ${arg}`);
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    const option = options.find((candidate) => candidate.name === name);
    if (!option) throw new ComputeUsageError(`Unknown option for compute ${command}: ${name}`);
    if (option.value === undefined) {
      if (inline !== undefined) throw new ComputeUsageError(`Option ${name} does not take a value`);
      flags.add(name);
      continue;
    }
    let value = inline;
    if (value === undefined) value = argv[++index];
    if (value === undefined || value === '' || value.startsWith('-')) {
      throw new ComputeUsageError(`Option ${name} requires a value`);
    }
    values[name] = value;
  }
  return { command, flags, values };
}

function initCommand(parsed: ParsedCompute, cwd: string): CommandOutcome {
  const configArg = parsed.values['--config'];
  const modeArg = parsed.values['--mode'];
  if (modeArg !== undefined && !COMPUTE_MODES.includes(modeArg as typeof COMPUTE_MODES[number])) {
    throw new ComputeUsageError(`Invalid --mode value: ${modeArg} (expected ${COMPUTE_MODES.join(', ')})`);
  }

  let policy: unknown = DEFAULT_COMPUTE_POLICY;
  const configPath = configArg === undefined ? undefined : (isAbsolute(configArg) ? configArg : resolve(cwd, configArg));
  if (configPath !== undefined) {
    const loaded = readJson(configPath);
    if (!loaded.found) throw new Error(`policy config not found: ${configPath}`);
    policy = loaded.value;
  }
  if (modeArg !== undefined && isRecord(policy)) policy = { ...policy, mode: modeArg };

  const inspection = inspectComputePolicy(policy);
  const policyPath = computePolicyPath(cwd);
  const dryRun = parsed.flags.has('--dry-run');
  if (!inspection.safe) {
    return {
      exitCode: 1,
      result: {
        schemaVersion: COMPUTE_SCHEMA_VERSION,
        command: 'init',
        ok: false,
        code: inspection.valid ? 'policy.unsafe' : 'policy.invalid',
        mutated: false,
        dryRun,
        policyPath,
        policy,
        inspection,
      },
    };
  }

  if (!dryRun) writeJsonAtomic(policyPath, policy);
  return {
    exitCode: 0,
    result: {
      schemaVersion: COMPUTE_SCHEMA_VERSION,
      command: 'init',
      ok: true,
      code: dryRun ? 'policy.validated' : 'policy.recorded',
      mutated: !dryRun,
      dryRun,
      policyPath,
      policy,
      inspection,
    },
  };
}

function requiredOperations(policy: unknown, inspection: ComputePolicyInspection): ComputeOperation[] {
  if (inspection.safe && isRecord(policy) && typeof policy.mode === 'string'
    && COMPUTE_MODES.includes(policy.mode as typeof COMPUTE_MODES[number])) {
    return [...COMPUTE_MODE_OPERATIONS[policy.mode as typeof COMPUTE_MODES[number]]];
  }
  return [...COMPUTE_OPERATIONS];
}

function capabilityFixture(cwd: string, policy: unknown, policyInspection: ComputePolicyInspection): {
  path: string;
  present: boolean;
  required: ComputeOperation[];
  inspection: ComputeCapabilityInspection;
} {
  const path = computeCapabilitiesPath(cwd);
  const required = requiredOperations(policy, policyInspection);
  let value: unknown;
  let present = false;
  try {
    const loaded = readJson(path);
    present = loaded.found;
    value = loaded.value;
  } catch {
    value = undefined;
  }
  const inspection = inspectComputeCapabilities(value, required);
  return { path, present, required, inspection };
}

function resourceReports(cwd: string): Array<Record<string, unknown>> {
  const dir = computeStatusDir(cwd);
  if (!existsSync(dir)) return [];
  const reports: Array<Record<string, unknown>> = [];
  for (const file of readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
    const resourceId = file.slice(0, -'.json'.length);
    const path = join(dir, file);
    let status: unknown;
    try {
      status = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      reports.push({
        resourceId,
        path,
        valid: false,
        safe: false,
        ownership: 'missing',
        issues: [{ code: 'status.object', severity: 'invalid', path: '', message: 'status file is not valid JSON' }],
      });
      continue;
    }
    const inspection = inspectComputeStatus(status);
    const ownership = isRecord(status) && isRecord(status.ownership) && typeof status.ownership.status === 'string'
      ? status.ownership.status
      : 'missing';
    reports.push({ resourceId, path, ownership, status, ...inspection });
  }
  return reports;
}

function doctorCommand(cwd: string): CommandOutcome {
  const policyPath = computePolicyPath(cwd);
  let policy: unknown;
  let policyInspection: ComputePolicyInspection;
  let policyPresent = false;
  try {
    const loaded = readJson(policyPath);
    policyPresent = loaded.found;
    policy = loaded.value;
    policyInspection = loaded.found
      ? inspectComputePolicy(policy)
      : policyInspectionError(`no compute policy recorded at ${policyPath}`);
  } catch {
    policyInspection = policyInspectionError(`compute policy at ${policyPath} is not valid JSON`);
  }

  const capabilities = capabilityFixture(cwd, policy, policyInspection);
  const resources = resourceReports(cwd);
  const policyOk = policyInspection.valid && policyInspection.safe;
  const capabilitiesOk = capabilities.inspection.ready;
  const resourcesOk = resources.every((resource) => resource.valid === true && resource.safe === true);
  const ok = policyPresent && policyOk && capabilitiesOk && resourcesOk;
  return {
    exitCode: ok ? 0 : 1,
    result: {
      schemaVersion: COMPUTE_SCHEMA_VERSION,
      command: 'doctor',
      ok,
      policy: {
        path: policyPath,
        present: policyPresent,
        policy: policyPresent ? policy : null,
        inspection: policyInspection,
      },
      capabilities: {
        path: capabilities.path,
        present: capabilities.present,
        required: capabilities.required,
        ...capabilities.inspection,
      },
      resources,
    },
  };
}

function statusCommand(parsed: ParsedCompute, cwd: string): CommandOutcome {
  const resourceId = parsed.values['--resource'];
  if (resourceId === undefined) throw new ComputeUsageError('compute status requires --resource <id>');
  if (!resourceIdIsSafe(resourceId)) throw new ComputeUsageError(`Invalid --resource value: ${resourceId}`);
  const path = computeStatusPath(cwd, resourceId);
  let status: unknown;
  try {
    const loaded = readJson(path);
    if (!loaded.found) {
      return {
        exitCode: 3,
        result: {
          schemaVersion: COMPUTE_SCHEMA_VERSION,
          command: 'status',
          ok: false,
          code: 'status.missing',
          resourceId,
          path,
          status: null,
          inspection: {
            valid: false,
            safe: false,
            issues: [{ code: 'status.object', severity: 'invalid', path: '', message: `no status recorded at ${path}` }],
          },
        },
      };
    }
    status = loaded.value;
  } catch (error) {
    return {
      exitCode: 3,
      result: {
        schemaVersion: COMPUTE_SCHEMA_VERSION,
        command: 'status',
        ok: false,
        code: 'status.unreadable',
        resourceId,
        path,
        status: null,
        inspection: {
          valid: false,
          safe: false,
          issues: [{
            code: 'status.object',
            severity: 'invalid',
            path: '',
            message: error instanceof Error ? error.message : String(error),
          }],
        },
      },
    };
  }

  const inspection = inspectComputeStatus(status);
  const ok = inspection.valid && inspection.safe;
  return {
    exitCode: ok ? 0 : 1,
    result: {
      schemaVersion: COMPUTE_SCHEMA_VERSION,
      command: 'status',
      ok,
      resourceId,
      path,
      status,
      inspection,
    },
  };
}

/** Run one compute command without printing. The returned result is the same
 * machine-readable object the CLI writes to stdout. */
export async function runComputeCommand(argv: string[], deps: ComputeCliDeps = {}): Promise<CommandOutcome> {
  const args = argv[0] === 'compute' ? argv.slice(1) : argv;
  const cwd = deps.cwd ?? process.cwd();
  const command = args[0] ?? 'compute';
  if (!args[0] || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    return {
      exitCode: 0,
      result: { schemaVersion: COMPUTE_SCHEMA_VERSION, command: 'help', ok: true, usage: COMPUTE_USAGE },
    };
  }
  try {
    const parsed = parseComputeCommand(args);
    if (parsed.command === 'init') return initCommand(parsed, cwd);
    if (parsed.command === 'doctor') return doctorCommand(cwd);
    return statusCommand(parsed, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const usage = error instanceof ComputeUsageError;
    return {
      exitCode: usage ? 2 : 3,
      result: {
        schemaVersion: COMPUTE_SCHEMA_VERSION,
        command,
        ok: false,
        code: usage ? 'usage' : 'error',
        error: message,
        ...(usage ? { usage: COMPUTE_USAGE } : {}),
      },
    };
  }
}

/** `junior compute` entry point. `argv` starts at the subcommand so the
 * top-level dispatcher can call `main(rest)` just like the other command
 * modules; an explicit leading `compute` is also accepted for direct use. */
export async function main(argv: string[], deps: ComputeCliDeps = {}): Promise<number> {
  const { exitCode, result } = await runComputeCommand(argv, deps);
  const out = deps.out ?? ((line: string) => console.log(line));
  out(JSON.stringify(result, null, 2));
  return exitCode;
}

if (isDirectEntry(import.meta.url)) {
  main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 3;
  });
}
