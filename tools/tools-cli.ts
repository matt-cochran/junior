/**
 * CLI parsing and main entry point for junior-tools.
 * Split from tools/tools.ts per ADR 0016; the facade keeps the entry block.
 */

import fs from "node:fs";
import process from "node:process";
import {
  HopError,
  TOOL_NAMES,
  defaultManagedStatePath,
  initHop,
  isRecord,
  readJsonFile,
  toHopError,
} from "./tools-manifest.ts";
import type { HopManifest, InitOptions, ToolName } from "./tools-manifest.ts";
import { callHop, inspectHop } from "./tools-call.ts";
import type { InspectReport } from "./tools-call.ts";
import type { CallOutcome, CallRequest } from "./tools-env.ts";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseInitConfig(configPath: string | undefined): InitOptions {
  if (!configPath) return {};
  const raw = readJsonFile(configPath);
  if (!isRecord(raw)) throw new HopError("BAD_REQUEST", "config must be a JSON object");
  const options: InitOptions = {};
  if (typeof raw.projectId === "string") options.projectId = raw.projectId;
  if (typeof raw.timeoutMs === "number") options.timeoutMs = raw.timeoutMs;
  if (typeof raw.lockTimeoutMs === "number") options.lockTimeoutMs = raw.lockTimeoutMs;
  if (isRecord(raw.tools)) {
    options.tools = raw.tools as InitOptions["tools"];
  }
  return options;
}

async function cliInit(args: string[]): Promise<HopManifest> {
  const [hopPath, configPath] = args;
  if (!hopPath) throw new HopError("USAGE", "usage: tools.ts init <hop.json> [config.json]");
  return initHop(hopPath, { managedStatePath: defaultManagedStatePath(), ...parseInitConfig(configPath) });
}

const CALL_USAGE =
  "Usage: junior tools call [<hop.json>] <fmeca|cpm|crossmatrix|scientific-process|elicitation> <request.json|-> [key=value ...] [--full]";

function isToolName(value: string | undefined): value is ToolName {
  return value !== undefined && (TOOL_NAMES as readonly string[]).includes(value);
}

/** Read the full `call` request object from stdin (`-`). */
function readStdinRequest(): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (err) {
    throw new HopError("BAD_REQUEST", "cannot read request from stdin", err);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new HopError("BAD_REQUEST", "invalid JSON on stdin", err);
  }
}

/** Decode inline `key=value` pairs: JSON when valid, otherwise a raw string. */
function parseInlineArguments(pairs: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new HopError("USAGE", `inline argument must be key=value: ${pair}`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    try {
      args[key] = JSON.parse(raw);
    } catch {
      args[key] = raw;
    }
  }
  return args;
}

/**
 * Build the request from the positional tail: a request file path, `-` for
 * stdin, or an inline `<method> [key=value ...]` form keyed on whether the
 * first tail argument is an existing file path.
 */
function buildCallRequest(rest: string[]): CallRequest {
  const source = rest[0];
  if (source === undefined) throw new HopError("USAGE", CALL_USAGE);
  if (source === "-" || fs.existsSync(source)) {
    if (rest.length > 1) throw new HopError("USAGE", CALL_USAGE);
    const raw = source === "-" ? readStdinRequest() : readJsonFile(source);
    if (!isRecord(raw)) throw new HopError("BAD_REQUEST", "request must be a JSON object");
    return raw as unknown as CallRequest;
  }
  return { tool: source, arguments: parseInlineArguments(rest.slice(1)) };
}

async function cliCall(args: string[]): Promise<CallOutcome> {
  const defaultHop = isToolName(args[0]);
  let hopPath = defaultHop ? "" : (args[0] ?? "");
  if (defaultHop) {
    // Resolve late so the tools module does not form an import cycle with the
    // hop-context module (hop-context itself imports inspectHop from here).
    const { resolveHop } = await import("../hop-context.ts");
    const resolution = resolveHop(process.cwd());
    if (resolution.status === "ambiguous") {
      throw new HopError(
        "BAD_REQUEST",
        `${resolution.message} Use: ${resolution.candidates.map((hop) => hop.selectCommand).join(" or ")}`,
      );
    }
    hopPath = resolution.path;
  }
  const tool = defaultHop ? args[0] : args[1];
  const rest = args.slice(defaultHop ? 1 : 2);
  if (!hopPath || tool === undefined) throw new HopError("USAGE", CALL_USAGE);
  if (!isToolName(tool)) throw new HopError("UNKNOWN_TOOL", `unknown tool '${tool}'`);
  return callHop(hopPath, tool, buildCallRequest(rest));
}

function cliInspect(args: string[]): InspectReport {
  const [hopPath] = args;
  if (!hopPath) throw new HopError("USAGE", "usage: tools.ts inspect <hop.json>");
  return inspectHop(hopPath);
}

function errorEnvelope(err: unknown): { ok: false; error: { code: string; message: string; detail?: unknown } } {
  const hopErr = err instanceof HopError ? err : toHopError(err);
  const error: { code: string; message: string; detail?: unknown } = {
    code: hopErr.code,
    message: hopErr.message,
  };
  if (hopErr.detail !== undefined) error.detail = hopErr.detail;
  return { ok: false, error };
}

/** Compact `{ok:false,error}` for an outcome that failed without a HopError. */
function compactCallError(outcome: CallOutcome): { ok: false; error: { code: string; message: string; detail?: unknown } } {
  if (outcome.error) return { ok: false, error: outcome.error };
  return {
    ok: false,
    error: {
      code: outcome.unsupported ? "UNSUPPORTED" : "UPSTREAM_ERROR",
      message: outcome.note ?? "tool call failed",
      detail: outcome.result,
    },
  };
}

const TOOLS_USAGE = [
  "Usage: junior tools <command> [args]",
  "  init    <hop.json> [config.json]",
  `  call    ${CALL_USAGE.slice("Usage: junior tools call ".length)}`,
  "  inspect <hop.json>",
].join("\n");

const TOOLS_COMMANDS: Record<string, { min: number; max: number; usage: string }> = {
  init: { min: 1, max: 2, usage: "Usage: junior tools init <hop.json> [config.json]" },
  call: { min: 2, max: Number.POSITIVE_INFINITY, usage: CALL_USAGE },
  inspect: { min: 1, max: 1, usage: "Usage: junior tools inspect <hop.json>" },
};

function wantsHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  // Help is resolved before any command runs, so no HOP file is ever touched.
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(TOOLS_USAGE + "\n");
    return 0;
  }
  const spec = TOOLS_COMMANDS[command];
  if (!spec) {
    process.stdout.write(JSON.stringify(errorEnvelope(new HopError("USAGE", TOOLS_USAGE)), null, 2) + "\n");
    return 1;
  }
  if (wantsHelp(rest)) {
    process.stdout.write(spec.usage + "\n");
    return 0;
  }
  try {
    const full = command === "call" && rest.includes("--full");
    const positional = command === "call" ? rest.filter((arg) => arg !== "--full") : rest;
    for (const arg of positional) {
      if (arg.startsWith("-") && arg !== "-") {
        throw new HopError("USAGE", `Unknown option for tools ${command}: ${arg}`);
      }
    }
    if (positional.length < spec.min || positional.length > spec.max) {
      throw new HopError("USAGE", spec.usage);
    }
    if (command === "call") {
      const outcome = await cliCall(positional);
      if (full) {
        process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
      } else if (outcome.ok) {
        process.stdout.write(JSON.stringify(outcome.result ?? null, null, 2) + "\n");
        process.stderr.write(
          `junior tools: ${outcome.tool} ${outcome.toolName} revision ${outcome.revision} snapshot ${outcome.snapshot?.id ?? "none"}\n`,
        );
      } else {
        process.stdout.write(JSON.stringify(compactCallError(outcome), null, 2) + "\n");
      }
      return outcome.ok ? 0 : 1;
    }
    let output: unknown;
    if (command === "init") output = await cliInit(positional);
    else output = cliInspect(positional);
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    return 0;
  } catch (err) {
    process.stdout.write(JSON.stringify(errorEnvelope(err), null, 2) + "\n");
    return 1;
  }
}
