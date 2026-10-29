// Behavioral tests for the junior-tools CLI/library.
//
// Every scenario is offline, uses its own temp directory, and asserts exactly
// one observable outcome through the public CLI. No source text is inspected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initHop as initHopManifest, isReadTool, buildToolEnv, crossmatrixUsesStore, probeToolVersion, TOOL_NAMES, callHop, cpmModelEnv, companionKeyEnv } from "./tools.ts";

export const ROOT = import.meta.dirname;
export const TOOLS = path.join(ROOT, "tools.ts");
export const FAKE = path.join(ROOT, "test-fixtures", "fake-mcp.mjs");
export const NODE = process.execPath;

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "junior-tools-test-"));
}

export function toolEntry(mode, extra = {}) {
  return {
    command: NODE,
    args: [FAKE],
    env: { FAKE_MCP_MODE: mode },
    sourceVersion: "0.0.1",
    sourceSha: "0".repeat(64),
    ...extra,
  };
}

export function writeConfig(dir, overrides = {}) {
  const cfg = {
    projectId: "test-project",
    timeoutMs: 20000,
    lockTimeoutMs: 5000,
    tools: {
      fmeca: toolEntry("echo"),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix"),
    },
    ...overrides,
  };
  const p = path.join(dir, "config.json");
  fs.writeFileSync(p, JSON.stringify(cfg));
  return p;
}

export function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

export function runCli(args, timeout = 30000, extraEnv = {}, opts = {}) {
  const env = {
    ...process.env,
    // Keep the CLI independent of the developer's real managed install and auth.
    JUNIOR_TOOLS_ROOT: path.join(os.tmpdir(), "junior-no-managed-tools"),
    PI_CODING_AGENT_DIR: path.join(os.tmpdir(), "junior-tools-no-auth"),
  };
  delete env.OPENROUTER_API_KEY;
  delete env.TYPESAFE_JEV_API_KEY;
  delete env.CPM_OPENROUTER_KEY_FILE;
  Object.assign(env, extraEnv);
  return spawnSync(NODE, [TOOLS, ...args], { encoding: "utf8", timeout, env, cwd: opts.cwd, input: opts.input });
}

export function cliJson(result) {
  return JSON.parse(result.stdout);
}

export function initHop(dir, overrides) {
  const hop = path.join(dir, "hop.json");
  const cfg = writeConfig(dir, overrides);
  runCli(["init", hop, cfg]);
  return hop;
}

export function cpmLoggingHop(dir, openedDbExpression) {
  const script = path.join(dir, "cpm-logs-db.mjs");
  fs.writeFileSync(
    script,
    `console.error("opening planner database db=" + (${openedDbExpression}));\n` +
      `await import(${JSON.stringify(FAKE)});\n`,
  );
  return initHop(dir, {
    tools: {
      fmeca: toolEntry("echo"),
      cpm: toolEntry("echo", { command: NODE, args: [script] }),
      crossmatrix: toolEntry("crossmatrix"),
    },
  });
}
export function defaultHop(dir, overrides) {
  const hopDir = path.join(dir, ".delivery", "setup");
  fs.mkdirSync(hopDir, { recursive: true });
  const hop = path.join(hopDir, "hop.json");
  const cfg = writeConfig(dir, overrides);
  runCli(["init", hop, cfg]);
  return hop;
}
export function nestedProjectHop(root, name) {
  const dir = path.join(root, ".delivery", name);
  fs.mkdirSync(dir, { recursive: true });
  return initHop(dir);
}
export function legacyHop(dir) {
  const hop = initHop(dir);
  const manifest = JSON.parse(fs.readFileSync(hop, "utf8"));
  for (const tool of ["scientific-process", "elicitation"]) {
    delete manifest.tools[tool];
    delete manifest.native[tool];
  }
  fs.writeFileSync(hop, JSON.stringify(manifest));
  return hop;
}
export function managedState(dir) {
  const bin = path.join(dir, "fmeca-mcp");
  fs.writeFileSync(bin, "");
  const statePath = path.join(dir, "installed.json");
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1,
    tools: { fmeca: { version: "0.2.0", sourceSha: "a".repeat(40), path: bin } },
  }));
  return { bin, statePath };
}
export function crossmatrixManifest(statePath = "crossmatrix-model.json") {
  return { native: { crossmatrix: { statePath } } };
}
export const STORED_MODEL = {
  schemaVersion: "0.2.0",
  modelId: "state_demo",
  dimensions: [
    { id: "d1", order: 0, members: [{ id: "a" }] },
    { id: "d2", order: 1, members: [{ id: "x" }] },
  ],
  scales: [],
  relations: [],
};

export function crossmatrixHop(dir, sourceVersion, observed) {
  const hop = initHop(dir, {
    tools: {
      fmeca: toolEntry("echo"),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix", {
        sourceVersion,
        env: { FAKE_MCP_MODE: "crossmatrix", FAKE_MCP_MODEL_FILE: observed },
      }),
    },
  });
  const serialized = JSON.stringify(STORED_MODEL);
  fs.writeFileSync(path.join(dir, "crossmatrix-model.json"), serialized + "\n");
  const manifest = JSON.parse(fs.readFileSync(hop, "utf8"));
  manifest.native.crossmatrix = {
    statePath: "crossmatrix-model.json",
    modelId: STORED_MODEL.modelId,
    modelSha256: crypto.createHash("sha256").update(serialized).digest("hex"),
  };
  fs.writeFileSync(hop, JSON.stringify(manifest));
  return hop;
}
export function storeHop(dir, log, sourceVersion) {
  return initHop(dir, {
    tools: {
      fmeca: toolEntry("echo"),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix", {
        sourceVersion,
        env: { FAKE_MCP_MODE: "crossmatrix", FAKE_CROSSMATRIX_WRITES: log },
      }),
    },
  });
}

export function commandRequest(op) {
  return {
    tool: "crossmatrix.command",
    arguments: {
      request: {
        schemaVersion: "0.3.0",
        requestId: "r-1",
        modelId: "m1",
        actor: { actorType: "system", persona: "model_admin" },
        op,
      },
    },
  };
}

export function readWrites(log) {
  return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
export function scientificHop(dir, log) {
  return initHop(dir, {
    tools: {
      fmeca: toolEntry("echo"),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix"),
      "scientific-process": toolEntry("scientific-process", {
        env: { FAKE_MCP_MODE: "scientific-process", FAKE_SCIENTIFIC_LOG: log },
      }),
    },
  });
}

export function readScientificCalls(log) {
  return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
export const PROBE_SOURCE = String.raw`
import fs from "node:fs";
export const log = process.env.JUNIOR_TEST_ENV_LOG;
if (log) {
  fs.writeFileSync(log, JSON.stringify({
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? null,
    TYPESAFE_JEV_API_KEY: process.env.TYPESAFE_JEV_API_KEY ?? null,
    CPM_OPENROUTER_KEY_FILE: process.env.CPM_OPENROUTER_KEY_FILE ?? null,
    CPM_LLM_MODEL: process.env.CPM_LLM_MODEL ?? null,
  }));
}
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});
export function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
export function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "env-probe", version: "0.0.1" } } });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "{}" }], structuredContent: { ok: true }, isError: false } });
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}
`;

export function writeAuthJson(dir, key) {
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key } }));
}

export function writeAuthEntries(dir, entries) {
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(entries));
}

export function probeEntry(dir, log, env = {}) {
  const probe = path.join(dir, "env-probe.mjs");
  fs.writeFileSync(probe, PROBE_SOURCE);
  return {
    command: NODE,
    args: [probe],
    env: { JUNIOR_TEST_ENV_LOG: log, ...env },
    sourceVersion: "0.0.1",
    sourceSha: "0".repeat(64),
  };
}

export function probeHop(dir, log, { tool = "cpm", probeEnv = {} } = {}) {
  const tools = Object.fromEntries(TOOL_NAMES.map((name) => [name, toolEntry("echo")]));
  tools.crossmatrix = toolEntry("crossmatrix");
  tools[tool] = probeEntry(dir, log, probeEnv);
  const cfg = path.join(dir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ projectId: "test-project", timeoutMs: 20000, lockTimeoutMs: 5000, tools }));
  const hop = path.join(dir, "hop.json");
  runCli(["init", hop, cfg]);
  return hop;
}

export function readProbeEnv(log) {
  return JSON.parse(fs.readFileSync(log, "utf8"));
}
export const companionAuth = (entries) => ({
  env: {},
  readAuthFile: () => JSON.stringify(entries),
});
export const MODEL_HOP = path.join(os.tmpdir(), "project", ".delivery", "setup", "hop.json");

export function projectDefaults(provider, model) {
  return { provider, model, source: "builtin", path: null };
}

export { initHopManifest, isReadTool, buildToolEnv, crossmatrixUsesStore, probeToolVersion, TOOL_NAMES, callHop, cpmModelEnv, companionKeyEnv };
