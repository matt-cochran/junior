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
import { initHop as initHopManifest, isReadTool, buildToolEnv, crossmatrixUsesStore } from "./tools.ts";

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

function runCli(args, timeout = 30000) {
  return spawnSync(NODE, [TOOLS, ...args], {
    encoding: "utf8",
    timeout,
    // Keep the CLI independent of the developer's real managed install.
    env: { ...process.env, JUNIOR_TOOLS_ROOT: path.join(os.tmpdir(), "junior-no-managed-tools") },
  });
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
  const out = cliJson(runCli(["call", hop, "fmeca", req]));
  assert.equal(out.isError, true);
});

test("unsupported operation note is surfaced even when upstream ok is true", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "crossmatrix.command",
    arguments: { request: { requestId: "r1", op: { kind: "observe" } } },
  });
  const out = cliJson(runCli(["call", hop, "crossmatrix", req]));
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
  const out = cliJson(runCli(["call", hop, "crossmatrix", queryReq]));
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

test("fmeca vet is classified as a command", () => {
  assert.equal(isReadTool("fmeca", "vet"), false);
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
