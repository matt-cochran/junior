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
import { initHop as initHopManifest, isReadTool, buildToolEnv, crossmatrixUsesStore, probeToolVersion, TOOL_NAMES } from "./tools.ts";

const ROOT = import.meta.dirname;
const TOOLS = path.join(ROOT, "tools.ts");
const FAKE = path.join(ROOT, "test-fixtures", "fake-mcp.mjs");
const NODE = process.execPath;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "junior-tools-test-"));
}

function toolEntry(mode, extra = {}) {
  return {
    command: NODE,
    args: [FAKE],
    env: { FAKE_MCP_MODE: mode },
    sourceVersion: "0.0.1",
    sourceSha: "0".repeat(64),
    ...extra,
  };
}

function writeConfig(dir, overrides = {}) {
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

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function runCli(args, timeout = 30000, extraEnv = {}, opts = {}) {
  const env = {
    ...process.env,
    // Keep the CLI independent of the developer's real managed install and auth.
    JUNIOR_TOOLS_ROOT: path.join(os.tmpdir(), "junior-no-managed-tools"),
    PI_CODING_AGENT_DIR: path.join(os.tmpdir(), "junior-tools-no-auth"),
  };
  delete env.OPENROUTER_API_KEY;
  delete env.CPM_OPENROUTER_KEY_FILE;
  Object.assign(env, extraEnv);
  return spawnSync(NODE, [TOOLS, ...args], { encoding: "utf8", timeout, env, cwd: opts.cwd, input: opts.input });
}

function cliJson(result) {
  return JSON.parse(result.stdout);
}

function initHop(dir, overrides) {
  const hop = path.join(dir, "hop.json");
  const cfg = writeConfig(dir, overrides);
  runCli(["init", hop, cfg]);
  return hop;
}

// --- init / manifest contract -------------------------------------------------

test("init writes a schemaVersion 1 manifest", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const manifest = JSON.parse(fs.readFileSync(hop, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
});

test("the managed tool registry includes scientific-process and elicitation", () => {
  assert.deepEqual(
    [...TOOL_NAMES].filter((tool) => tool === "scientific-process" || tool === "elicitation"),
    ["scientific-process", "elicitation"],
  );
});

test("init persists a stable project id across a later call", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const before = JSON.parse(fs.readFileSync(hop, "utf8")).projectId;
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  runCli(["call", hop, "fmeca", req]);
  const after = JSON.parse(fs.readFileSync(hop, "utf8")).projectId;
  assert.equal(after, before);
});

test("call advances the manifest revision monotonically", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  runCli(["call", hop, "fmeca", req]);
  runCli(["call", hop, "fmeca", req]);
  const manifest = JSON.parse(fs.readFileSync(hop, "utf8"));
  assert.equal(manifest.revision, 2);
});

test("call keeps manager acceptance pending after a worker call", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  runCli(["call", hop, "fmeca", req]);
  const manifest = JSON.parse(fs.readFileSync(hop, "utf8"));
  assert.equal(manifest.managerAcceptance, "pending");
});

test("call records a read snapshot whose sha256 matches the stored file", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  runCli(["call", hop, "fmeca", req]);
  const manifest = JSON.parse(fs.readFileSync(hop, "utf8"));
  const snap = manifest.snapshots[0];
  const bytes = fs.readFileSync(path.resolve(dir, snap.path));
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(snap.sha256, digest);
});

// --- call ergonomics ----------------------------------------------------------
//
// `call` keeps the request-file form, defaults the hop when the first argument
// is a tool name, accepts inline `method key=value` arguments, and prints only
// the result value unless `--full` asks for the whole envelope.

function defaultHop(dir, overrides) {
  const hopDir = path.join(dir, ".delivery", "setup");
  fs.mkdirSync(hopDir, { recursive: true });
  const hop = path.join(hopDir, "hop.json");
  const cfg = writeConfig(dir, overrides);
  runCli(["init", hop, cfg]);
  return hop;
}

test("call defaults the hop to .delivery/setup/hop.json under the current directory", () => {
  const dir = tmpdir();
  defaultHop(dir);
  const result = runCli(["call", "fmeca", "state.get", "session_id=s1"], 30000, {}, { cwd: dir });
  assert.equal(result.status, 0);
});

test("inline key=value arguments decode JSON values and keep bare tokens as strings", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const result = runCli([
    "call",
    hop,
    "cpm",
    "plan.status",
    "plan_id=plan_x",
    "max_count=1",
    'ids=["A"]',
    'status={"status":"complete"}',
  ]);
  assert.deepEqual(cliJson(result).echo, {
    plan_id: "plan_x",
    max_count: 1,
    ids: ["A"],
    status: { status: "complete" },
  });
});

test("compact success prints only the result value", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const result = runCli(["call", hop, "fmeca", "state.get", "session_id=s1"]);
  assert.deepEqual(cliJson(result), { ok: true, echo: { session_id: "s1" } });
});

test("compact success writes one summary line to stderr", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const result = runCli(["call", hop, "fmeca", "state.get", "session_id=s1"]);
  assert.match(result.stderr, /^junior tools: fmeca state\.get revision 1 snapshot snap_/);
});

test("compact failure exits 1", () => {
  const dir = tmpdir();
  const hop = initHop(dir, {
    tools: {
      fmeca: toolEntry("error"),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix"),
    },
  });
  const result = runCli(["call", hop, "fmeca", "state.get", "session_id=s1"]);
  assert.equal(result.status, 1);
});

test("--full still exits 1 on a tool failure", () => {
  const dir = tmpdir();
  const hop = initHop(dir, {
    tools: {
      fmeca: toolEntry("error"),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix"),
    },
  });
  const result = runCli(["call", "--full", hop, "fmeca", "state.get", "session_id=s1"]);
  assert.equal(result.status, 1);
});

test("compact tool failure prints an ok:false error envelope", () => {
  const dir = tmpdir();
  const hop = initHop(dir, {
    tools: {
      fmeca: toolEntry("error"),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix"),
    },
  });
  const result = runCli(["call", hop, "fmeca", "state.get", "session_id=s1"]);
  assert.equal(cliJson(result).error.code, "UPSTREAM_ERROR");
});

test("a - request path reads the request from stdin", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const input = JSON.stringify({ tool: "state.get", arguments: { session_id: "s1" } });
  const result = runCli(["call", hop, "fmeca", "-"], 30000, {}, { input });
  assert.deepEqual(cliJson(result), { ok: true, echo: { session_id: "s1" } });
});

test("the request-file form still works", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  const result = runCli(["call", hop, "fmeca", req]);
  assert.deepEqual(cliJson(result), { ok: true, echo: { session_id: "s1" } });
});

test("--full prints the full call envelope", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const result = runCli(["call", "--full", hop, "fmeca", "state.get", "session_id=s1"]);
  assert.equal(cliJson(result).kind, "read");
});

test("an unknown call option fails with USAGE", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const result = runCli(["call", "--nope", hop, "fmeca", "state.get"]);
  assert.equal(cliJson(result).error.code, "USAGE");
});

// --- failure surfaces ---------------------------------------------------------

test("missing MCP binary is reported as a spawn error", () => {
  const dir = tmpdir();
  const hop = initHop(dir, {
    tools: {
      fmeca: toolEntry("echo", { command: "/nonexistent/fake-mcp-binary" }),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix"),
    },
  });
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  const out = cliJson(runCli(["call", hop, "fmeca", req]));
  assert.equal(out.error.code, "SPAWN_ERROR");
});

test("malformed manifest is rejected", () => {
  const dir = tmpdir();
  const hop = path.join(dir, "hop.json");
  fs.writeFileSync(hop, "{ this is not json");
  const out = cliJson(runCli(["inspect", hop]));
  assert.equal(out.error.code, "MALFORMED_MANIFEST");
});

function legacyHop(dir) {
  const hop = initHop(dir);
  const manifest = JSON.parse(fs.readFileSync(hop, "utf8"));
  for (const tool of ["scientific-process", "elicitation"]) {
    delete manifest.tools[tool];
    delete manifest.native[tool];
  }
  fs.writeFileSync(hop, JSON.stringify(manifest));
  return hop;
}

test("an old hop without the new tools still runs a cpm call", () => {
  const dir = tmpdir();
  const hop = legacyHop(dir);
  const req = writeJson(path.join(dir, "req.json"), { tool: "plan.status", arguments: {} });
  const out = cliJson(runCli(["call", "--full", hop, "cpm", req]));
  assert.equal(out.ok, true);
});

test("calling a new tool on an old hop names the re-init remedy", () => {
  const dir = tmpdir();
  const hop = legacyHop(dir);
  const req = writeJson(path.join(dir, "req.json"), { tool: "state.get", arguments: {} });
  const out = cliJson(runCli(["call", hop, "scientific-process", req]));
  assert.match(out.error.message, /junior init --install/);
});

test("stale expected revision is rejected", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const first = writeJson(path.join(dir, "first.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  runCli(["call", hop, "fmeca", first]);
  const stale = writeJson(path.join(dir, "stale.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
    expectedRevision: 0,
  });
  const out = cliJson(runCli(["call", hop, "fmeca", stale]));
  assert.equal(out.error.code, "STALE_REVISION");
});

test("a timed-out MCP call is reported as a timeout", () => {
  const dir = tmpdir();
  const hop = initHop(dir, {
    timeoutMs: 1200,
    tools: {
      fmeca: toolEntry("timeout"),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix"),
    },
  });
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  const out = cliJson(runCli(["call", hop, "fmeca", req]));
  assert.equal(out.error.code, "TIMEOUT");
});

test("upstream tool isError is propagated", () => {
  const dir = tmpdir();
  const hop = initHop(dir, {
    tools: {
      fmeca: toolEntry("error"),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix"),
    },
  });
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  const out = cliJson(runCli(["call", "--full", hop, "fmeca", req]));
  assert.equal(out.isError, true);
});

test("unsupported operation note is surfaced even when upstream ok is true", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "crossmatrix.command",
    arguments: { request: { requestId: "r1", op: { kind: "observe" } } },
  });
  const out = cliJson(runCli(["call", "--full", hop, "crossmatrix", req]));
  assert.equal(out.unsupported, true);
});

test("a held manifest lock blocks a concurrent call", () => {
  const dir = tmpdir();
  const hop = initHop(dir, { lockTimeoutMs: 250 });
  fs.writeFileSync(hop + ".lock", JSON.stringify({ pid: 999999 }));
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  const out = cliJson(runCli(["call", hop, "fmeca", req]));
  assert.equal(out.error.code, "LOCKED");
});

// --- crossmatrix persistence --------------------------------------------------

test("crossmatrix query sees the model imported in an earlier process", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const model = {
    schemaVersion: "0.2.0",
    modelId: "state_demo",
    dimensions: [
      { id: "d1", order: 0, members: [{ id: "a" }] },
      { id: "d2", order: 1, members: [{ id: "x" }] },
    ],
    scales: [],
    relations: [],
  };
  const importReq = writeJson(path.join(dir, "import.json"), {
    tool: "crossmatrix.command",
    arguments: {
      request: { requestId: "import-1", modelId: "state_demo", model },
    },
  });
  runCli(["call", hop, "crossmatrix", importReq]);
  const queryReq = writeJson(path.join(dir, "query.json"), {
    tool: "crossmatrix.query",
    arguments: { request: { requestId: "q1", query: { kind: "validate" } } },
  });
  const out = cliJson(runCli(["call", "--full", hop, "crossmatrix", queryReq]));
  assert.equal(out.result.validated, true);
});

// --- inspect ------------------------------------------------------------------

test("inspect lists the snapshots recorded by prior reads", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  runCli(["call", hop, "fmeca", req]);
  const out = cliJson(runCli(["inspect", hop]));
  assert.equal(out.snapshots.length, 1);
});

// --- read vs command classification ------------------------------------------
//
// `isReadTool` is the exported classifier `callHop` uses to decide whether a
// successful result is exported as an immutable snapshot. These tests pin the
// newer FMECA/CPM query tools as reads and keep the write tools as commands.

test("cpm plan.get is classified as a read", () => {
  assert.equal(isReadTool("cpm", "plan.get"), true);
});

test("cpm plan.lint is classified as a read", () => {
  assert.equal(isReadTool("cpm", "plan.lint"), true);
});

test("cpm plan.schedule is classified as a read", () => {
  assert.equal(isReadTool("cpm", "plan.schedule"), true);
});

test("cpm plan.simulate is classified as a read", () => {
  assert.equal(isReadTool("cpm", "plan.simulate"), true);
});

test("cpm plan.list is classified as a read", () => {
  assert.equal(isReadTool("cpm", "plan.list"), true);
});

test("cpm plan.compare is classified as a read", () => {
  assert.equal(isReadTool("cpm", "plan.compare"), true);
});

test("cpm plan.ev is classified as a read", () => {
  assert.equal(isReadTool("cpm", "plan.ev"), true);
});

test("cpm plan.review is classified as a read", () => {
  assert.equal(isReadTool("cpm", "plan.review"), true);
});

test("cpm plan.export is classified as a command", () => {
  assert.equal(isReadTool("cpm", "plan.export"), false);
});

test("cpm plan.snapshot is classified as a command", () => {
  assert.equal(isReadTool("cpm", "plan.snapshot"), false);
});

test("cpm plan.baseline is classified as a command", () => {
  assert.equal(isReadTool("cpm", "plan.baseline"), false);
});

test("cpm plan.submit is classified as a command", () => {
  assert.equal(isReadTool("cpm", "plan.submit"), false);
});

test("fmeca session.list is classified as a read", () => {
  assert.equal(isReadTool("fmeca", "session.list"), true);
});

test("fmeca actions.suggest is classified as a read", () => {
  assert.equal(isReadTool("fmeca", "actions.suggest"), true);
});

test("fmeca policy.list is classified as a read", () => {
  assert.equal(isReadTool("fmeca", "policy.list"), true);
});

test("fmeca append is classified as a command", () => {
  assert.equal(isReadTool("fmeca", "append"), false);
});

test("fmeca vet is classified as a read", () => {
  assert.equal(isReadTool("fmeca", "vet"), true);
});

test("elicitation spec.export is classified as a read", () => {
  assert.equal(isReadTool("elicitation", "spec.export"), true);
});

test("scientific-process report.export is classified as a read", () => {
  assert.equal(isReadTool("scientific-process", "report.export"), true);
});

// --- managed tool defaults ----------------------------------------------------
//
// A fresh HOP points at Junior's managed, checksum-verified binaries when they
// are installed, and records their real version instead of a built-in pin.

function managedState(dir) {
  const bin = path.join(dir, "fmeca-mcp");
  fs.writeFileSync(bin, "");
  const statePath = path.join(dir, "installed.json");
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1,
    tools: { fmeca: { version: "0.2.0", sourceSha: "a".repeat(40), path: bin } },
  }));
  return { bin, statePath };
}

test("init defaults a tool to its managed binary when one is installed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hop-managed-"));
  const { bin, statePath } = managedState(dir);
  const hop = initHopManifest(path.join(dir, "hop.json"), { managedStatePath: statePath });
  assert.equal(hop.tools.fmeca.command, bin);
});

test("init records the managed binary's installed version", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hop-managed-"));
  const { statePath } = managedState(dir);
  const hop = initHopManifest(path.join(dir, "hop.json"), { managedStatePath: statePath });
  assert.equal(hop.tools.fmeca.sourceVersion, "0.2.0");
});

test("init keeps the PATH command for a tool with no managed install", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hop-managed-"));
  const { statePath } = managedState(dir);
  const hop = initHopManifest(path.join(dir, "hop.json"), { managedStatePath: statePath });
  assert.equal(hop.tools.cpm.command, "cpm-planner");
});

// --- probed provenance --------------------------------------------------------
//
// A command that is not Junior's managed binary records the version it reports
// through `--version` and an unknown source SHA; there is no built-in release
// table to go stale.

test("init with no managed install records the version the tool command reports", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hop-provenance-"));
  const hop = initHopManifest(path.join(dir, "hop.json"), { probeVersion: () => "9.8.7" });
  assert.equal(hop.tools.cpm.sourceVersion, "9.8.7");
});

test("init with no managed install records an unknown source sha", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hop-provenance-"));
  const hop = initHopManifest(path.join(dir, "hop.json"), { probeVersion: () => "9.8.7" });
  assert.equal(hop.tools.cpm.sourceSha, "");
});

test("init records sourceVersion unknown when the tool command reports no version", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hop-provenance-"));
  const hop = initHopManifest(path.join(dir, "hop.json"), { probeVersion: () => null });
  assert.equal(hop.tools.crossmatrix.sourceVersion, "unknown");
});

test("a config command override pointing away from the managed binary records that command's reported version", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hop-provenance-"));
  const { statePath } = managedState(dir);
  const otherBinary = path.join(dir, "other-fmeca-mcp");
  const hop = initHopManifest(path.join(dir, "hop.json"), {
    managedStatePath: statePath,
    tools: { fmeca: { command: otherBinary } },
    probeVersion: (command) => (command === otherBinary ? "0.2.5" : null),
  });
  assert.equal(hop.tools.fmeca.sourceVersion, "0.2.5");
});

test("probeToolVersion reads the semver a command prints for --version", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hop-probe-"));
  const script = path.join(dir, "fake-tool.mjs");
  fs.writeFileSync(script, "#!/usr/bin/env node\nconsole.log('fake-tool 1.4.2');\n", { mode: 0o755 });
  assert.equal(probeToolVersion(script), "1.4.2");
});

// --- crossmatrix project store (0.3.0+) ---------------------------------------
//
// Crossmatrix 0.3+ keeps its validated model in a committed
// `<project>/.crossmatrix` store. The wrapper points the server at that store
// instead of replaying the imported model; 0.2.x keeps the legacy
// wrapper-owned replay.

function crossmatrixManifest(statePath = "crossmatrix-model.json") {
  return { native: { crossmatrix: { statePath } } };
}

test("buildToolEnv points CROSSMATRIX_DIR at the git project's store", () => {
  const root = tmpdir();
  const project = path.join(root, "project");
  const hopDir = path.join(project, "sub");
  fs.mkdirSync(hopDir, { recursive: true });
  fs.mkdirSync(path.join(project, ".git"));
  fs.mkdirSync(path.join(project, ".crossmatrix"));
  const env = buildToolEnv(path.join(hopDir, "hop.json"), "crossmatrix", crossmatrixManifest());
  assert.deepEqual(env, { CROSSMATRIX_DIR: path.join(project, ".crossmatrix") });
});

test("buildToolEnv falls back to the hop file's grandparent outside a git repo", () => {
  const root = tmpdir();
  const project = path.join(root, "project");
  const hopDir = path.join(project, "sub");
  fs.mkdirSync(hopDir, { recursive: true });
  fs.mkdirSync(path.join(project, ".crossmatrix"));
  const env = buildToolEnv(path.join(hopDir, "hop.json"), "crossmatrix", crossmatrixManifest());
  assert.deepEqual(env, { CROSSMATRIX_DIR: path.join(project, ".crossmatrix") });
});

test("buildToolEnv omits crossmatrix env when the project store is absent", () => {
  const root = tmpdir();
  const hopDir = path.join(root, "project", "sub");
  fs.mkdirSync(hopDir, { recursive: true });
  const env = buildToolEnv(path.join(hopDir, "hop.json"), "crossmatrix", crossmatrixManifest());
  assert.deepEqual(env, {});
});

test("a fresh hop anchors the scientific-process state env beside the hop", () => {
  const dir = tmpdir();
  const hopPath = path.join(dir, "hop.json");
  const manifest = initHopManifest(hopPath, { probeVersion: () => null });
  assert.deepEqual(buildToolEnv(hopPath, "scientific-process", manifest), {
    SCIENTIFIC_PROCESS_STATE_DIR: path.join(dir, "scientific-process-state"),
  });
});

test("a fresh hop anchors the elicitation state env beside the hop", () => {
  const dir = tmpdir();
  const hopPath = path.join(dir, "hop.json");
  const manifest = initHopManifest(hopPath, { probeVersion: () => null });
  assert.deepEqual(buildToolEnv(hopPath, "elicitation", manifest), {
    ELICITATION_STATE_DIR: path.join(dir, "elicitation-state"),
  });
});

test("crossmatrixUsesStore is true for a 0.3.0 source version", () => {
  assert.equal(crossmatrixUsesStore({ tools: { crossmatrix: { sourceVersion: "0.3.0" } } }), true);
});

test("crossmatrixUsesStore is false for a 0.2.1 source version", () => {
  assert.equal(crossmatrixUsesStore({ tools: { crossmatrix: { sourceVersion: "0.2.1" } } }), false);
});

test("crossmatrixUsesStore is false for an unparseable source version", () => {
  assert.equal(crossmatrixUsesStore({ tools: { crossmatrix: { sourceVersion: "not-a-version" } } }), false);
});

const STORED_MODEL = {
  schemaVersion: "0.2.0",
  modelId: "state_demo",
  dimensions: [
    { id: "d1", order: 0, members: [{ id: "a" }] },
    { id: "d2", order: 1, members: [{ id: "x" }] },
  ],
  scales: [],
  relations: [],
};

function crossmatrixHop(dir, sourceVersion, observed) {
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

test("a 0.3.0 hop sends no model replay before a crossmatrix query", () => {
  const dir = tmpdir();
  const observed = path.join(dir, "server-received-model.json");
  const hop = crossmatrixHop(dir, "0.3.0", observed);
  const req = writeJson(path.join(dir, "query.json"), {
    tool: "crossmatrix.query",
    arguments: { request: { requestId: "q1", query: { kind: "validate" } } },
  });
  runCli(["call", hop, "crossmatrix", req]);
  assert.equal(fs.existsSync(observed), false);
});

test("a 0.2.1 hop still sends the model replay before a crossmatrix query", () => {
  const dir = tmpdir();
  const observed = path.join(dir, "server-received-model.json");
  const hop = crossmatrixHop(dir, "0.2.1", observed);
  const req = writeJson(path.join(dir, "query.json"), {
    tool: "crossmatrix.query",
    arguments: { request: { requestId: "q1", query: { kind: "validate" } } },
  });
  runCli(["call", hop, "crossmatrix", req]);
  assert.equal(fs.existsSync(observed), true);
});

test("a 0.3.0 import does not persist the model to the hop native file", () => {
  const dir = tmpdir();
  const hop = initHop(dir, {
    tools: {
      fmeca: toolEntry("echo"),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix", { sourceVersion: "0.3.0" }),
    },
  });
  const req = writeJson(path.join(dir, "import.json"), {
    tool: "crossmatrix.command",
    arguments: { request: { requestId: "import-1", modelId: "state_demo", model: STORED_MODEL } },
  });
  runCli(["call", hop, "crossmatrix", req]);
  assert.equal(fs.existsSync(path.join(dir, "crossmatrix-model.json")), false);
});

// --- crossmatrix 0.3+ per-process model.open ----------------------------------
//
// A Crossmatrix 0.3+ server holds the opened model per process, so `tools call`
// prepends model.open to every store-backed command that names a model. The
// fake write log records both calls in order, proving the open ran in the same
// server session before the real command.

function storeHop(dir, log, sourceVersion) {
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

function commandRequest(op) {
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

function readWrites(log) {
  return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("a 0.3.0 store call opens the model before the command", () => {
  const dir = tmpdir();
  const log = path.join(dir, "writes.log");
  const hop = storeHop(dir, log, "0.3.0");
  const req = writeJson(path.join(dir, "req.json"), commandRequest({ kind: "dimension.register", dimensionId: "code" }));
  runCli(["call", hop, "crossmatrix", req]);
  const ops = readWrites(log);
  const at = ops.findIndex((entry) => entry.op.kind === "dimension.register");
  assert.equal(ops[at - 1]?.op?.kind, "model.open");
});

test("a 0.3.0 model.open command is not preceded by a second open", () => {
  const dir = tmpdir();
  const log = path.join(dir, "writes.log");
  const hop = storeHop(dir, log, "0.3.0");
  const req = writeJson(path.join(dir, "req.json"), commandRequest({ kind: "model.open" }));
  runCli(["call", hop, "crossmatrix", req]);
  const opens = readWrites(log).filter((entry) => entry.op.kind === "model.open");
  assert.equal(opens.length, 1);
});

test("a 0.2.1 hop sends no extra open before a command", () => {
  const dir = tmpdir();
  const log = path.join(dir, "writes.log");
  const hop = storeHop(dir, log, "0.2.1");
  const req = writeJson(path.join(dir, "req.json"), commandRequest({ kind: "dimension.register", dimensionId: "code" }));
  runCli(["call", hop, "crossmatrix", req]);
  const opens = readWrites(log).filter((entry) => entry.op.kind === "model.open");
  assert.equal(opens.length, 0);
});

test("a 0.3.0 store call reports the command's own result", () => {
  const dir = tmpdir();
  const log = path.join(dir, "writes.log");
  const hop = storeHop(dir, log, "0.3.0");
  const req = writeJson(path.join(dir, "req.json"), commandRequest({ kind: "dimension.register", dimensionId: "code" }));
  const out = cliJson(runCli(["call", "--full", hop, "crossmatrix", req]));
  assert.equal(out.result.op, "dimension.register");
});

// --- cpm review key derivation -----------------------------------------------
//
// cpm's `plan.review` may need the OpenRouter key Pi manages in auth.json. The
// wrapper derives it into the cpm child spawn env only — never the HOP, argv or
// evidence — and an explicit OPENROUTER_API_KEY / CPM_OPENROUTER_KEY_FILE in
// the process or hop env always wins. A probe MCP server records the review env
// it received so each scenario asserts exactly one child-environment outcome.

const PROBE_SOURCE = String.raw`
import fs from "node:fs";
const log = process.env.JUNIOR_TEST_ENV_LOG;
if (log) {
  fs.writeFileSync(log, JSON.stringify({
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? null,
    CPM_OPENROUTER_KEY_FILE: process.env.CPM_OPENROUTER_KEY_FILE ?? null,
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
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function handle(line) {
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

function writeAuthJson(dir, key) {
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key } }));
}

function probeEntry(dir, log, env = {}) {
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

function probeHop(dir, log, { tool = "cpm", probeEnv = {} } = {}) {
  const tools = {
    fmeca: toolEntry("echo"),
    cpm: toolEntry("echo"),
    crossmatrix: toolEntry("crossmatrix"),
  };
  tools[tool] = probeEntry(dir, log, probeEnv);
  const cfg = path.join(dir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ projectId: "test-project", timeoutMs: 20000, lockTimeoutMs: 5000, tools }));
  const hop = path.join(dir, "hop.json");
  runCli(["init", hop, cfg]);
  return hop;
}

function readProbeEnv(log) {
  return JSON.parse(fs.readFileSync(log, "utf8"));
}

test("cpm spawn receives the OpenRouter key Pi manages in auth.json", () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  writeAuthJson(dir, "sk-derived-from-auth");
  const hop = probeHop(dir, log);
  const req = writeJson(path.join(dir, "req.json"), { tool: "plan.review", arguments: {} });
  runCli(["call", hop, "cpm", req], 30000, { PI_CODING_AGENT_DIR: dir });
  assert.equal(readProbeEnv(log).OPENROUTER_API_KEY, "sk-derived-from-auth");
});

test("an explicit process OPENROUTER_API_KEY is not overridden by auth.json", () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  writeAuthJson(dir, "sk-derived-from-auth");
  const hop = probeHop(dir, log);
  const req = writeJson(path.join(dir, "req.json"), { tool: "plan.review", arguments: {} });
  runCli(["call", hop, "cpm", req], 30000, { PI_CODING_AGENT_DIR: dir, OPENROUTER_API_KEY: "sk-explicit-process" });
  assert.equal(readProbeEnv(log).OPENROUTER_API_KEY, "sk-explicit-process");
});

test("an explicit hop OPENROUTER_API_KEY is not overridden by auth.json", () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  writeAuthJson(dir, "sk-derived-from-auth");
  const hop = probeHop(dir, log, { probeEnv: { OPENROUTER_API_KEY: "sk-explicit-hop" } });
  const req = writeJson(path.join(dir, "req.json"), { tool: "plan.review", arguments: {} });
  runCli(["call", hop, "cpm", req], 30000, { PI_CODING_AGENT_DIR: dir });
  assert.equal(readProbeEnv(log).OPENROUTER_API_KEY, "sk-explicit-hop");
});

test("an explicit process CPM_OPENROUTER_KEY_FILE suppresses the derived key", () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  writeAuthJson(dir, "sk-derived-from-auth");
  const hop = probeHop(dir, log);
  const req = writeJson(path.join(dir, "req.json"), { tool: "plan.review", arguments: {} });
  runCli(["call", hop, "cpm", req], 30000, { PI_CODING_AGENT_DIR: dir, CPM_OPENROUTER_KEY_FILE: "/tmp/review-key" });
  assert.equal(readProbeEnv(log).OPENROUTER_API_KEY, null);
});

test("an explicit hop CPM_OPENROUTER_KEY_FILE suppresses the derived key", () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  writeAuthJson(dir, "sk-derived-from-auth");
  const hop = probeHop(dir, log, { probeEnv: { CPM_OPENROUTER_KEY_FILE: "/tmp/review-key" } });
  const req = writeJson(path.join(dir, "req.json"), { tool: "plan.review", arguments: {} });
  runCli(["call", hop, "cpm", req], 30000, { PI_CODING_AGENT_DIR: dir });
  assert.equal(readProbeEnv(log).OPENROUTER_API_KEY, null);
});

test("fmeca spawn does not receive the derived OpenRouter key", () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  writeAuthJson(dir, "sk-derived-from-auth");
  const hop = probeHop(dir, log, { tool: "fmeca" });
  const req = writeJson(path.join(dir, "req.json"), { tool: "state.get", arguments: { session_id: "s1" } });
  runCli(["call", hop, "fmeca", req], 30000, { PI_CODING_AGENT_DIR: dir });
  assert.equal(readProbeEnv(log).OPENROUTER_API_KEY, null);
});

test("crossmatrix spawn does not receive the derived OpenRouter key", () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  writeAuthJson(dir, "sk-derived-from-auth");
  const hop = probeHop(dir, log, { tool: "crossmatrix" });
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "crossmatrix.query",
    arguments: { request: { requestId: "q1", query: { kind: "validate" } } },
  });
  runCli(["call", hop, "crossmatrix", req], 30000, { PI_CODING_AGENT_DIR: dir });
  assert.equal(readProbeEnv(log).OPENROUTER_API_KEY, null);
});

test("the derived review key is never written to the hop or its snapshots", () => {
  const dir = tmpdir();
  writeAuthJson(dir, "sk-canary-secret-value");
  const hop = initHop(dir);
  const req = writeJson(path.join(dir, "req.json"), { tool: "plan.status", arguments: {} });
  runCli(["call", hop, "cpm", req], 30000, { PI_CODING_AGENT_DIR: dir });
  const artifacts = [fs.readFileSync(hop, "utf8")];
  const snapshots = path.join(dir, "snapshots");
  if (fs.existsSync(snapshots)) {
    for (const name of fs.readdirSync(snapshots)) artifacts.push(fs.readFileSync(path.join(snapshots, name), "utf8"));
  }
  assert.equal(artifacts.join("\n").includes("sk-canary-secret-value"), false);
});

test("tools inspect reports cpmReview available when auth.json holds an OpenRouter key", () => {
  const dir = tmpdir();
  writeAuthJson(dir, "sk-inspect-value");
  const hop = initHop(dir);
  const out = cliJson(runCli(["inspect", hop], 30000, { PI_CODING_AGENT_DIR: dir }));
  assert.equal(out.cpmReview, "available");
});

test("tools inspect reports cpmReview unavailable without any OpenRouter key", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const out = cliJson(runCli(["inspect", hop], 30000, { PI_CODING_AGENT_DIR: path.join(dir, "empty-agent") }));
  assert.equal(out.cpmReview, "unavailable");
});

test("tools inspect output does not contain the OpenRouter key value", () => {
  const dir = tmpdir();
  writeAuthJson(dir, "sk-inspect-secret-canary");
  const hop = initHop(dir);
  const result = runCli(["inspect", hop], 30000, { PI_CODING_AGENT_DIR: dir });
  assert.equal(result.stdout.includes("sk-inspect-secret-canary"), false);
});
