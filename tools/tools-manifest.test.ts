import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withManifestLock } from "./tools-manifest.ts";
import { mcpCallSequence, openMcpSession } from "./tools-mcp.ts";
import { createManualClock } from "../clock.ts";
import { ROOT, TOOLS, FAKE, NODE, tmpdir, toolEntry, writeConfig, writeJson, runCli, cliJson, initHop, cpmLoggingHop, managedState, initHopManifest, probeToolVersion, isReadTool, TOOL_NAMES } from "./tools-helpers.test.ts";

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

test("init emits CPM_PLANNER_DB anchored beside the generated Hop", () => {
  const dir = tmpdir();
  const manifest = initHopManifest(path.join(dir, "hop.json"), { probeVersion: () => null });
  assert.equal(manifest.tools.cpm.env.CPM_PLANNER_DB, path.join(dir, "cpm-planner.db"));
});

test("a cpm call rejects a planner that opened the default database", () => {
  const dir = tmpdir();
  const hop = cpmLoggingHop(dir, JSON.stringify(path.join(dir, "default-cpm-planner.db")));
  const out = cliJson(runCli(["call", "--full", hop, "cpm", "plan.status"]));
  assert.equal(out.error.code, "UPSTREAM_ERROR");
});

test("a cpm call accepts a planner that opened the project database", () => {
  const dir = tmpdir();
  const hop = cpmLoggingHop(dir, "process.env.CPM_PLANNER_DB");
  const out = cliJson(runCli(["call", "--full", hop, "cpm", "plan.status"]));
  assert.equal(out.ok, true);
});

test("a cpm call accepts the project database when CPM also reports state_mode", () => {
  const dir = tmpdir();
  const hop = cpmLoggingHop(dir, "process.env.CPM_PLANNER_DB + ' state_mode=Normal'");
  const out = cliJson(runCli(["call", "--full", hop, "cpm", "plan.status"]));
  assert.equal(out.ok, true);
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

// --- manifest lock reaping ---------------------------------------------------

/** A pid that is guaranteed gone: a short-lived child that has been waited on. */
function deadPid() {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid;
}

/**
 * Contend for a held lock on a manual clock: the attempt is still waiting one
 * millisecond before `lockTimeoutMs` and fails LOCKED exactly at it.
 */
async function assertLockedAtDeadline(hop, lockTimeoutMs) {
  const clock = createManualClock(0);
  let settled = false;
  const attempt = withManifestLock(hop, lockTimeoutMs, async () => {}, clock);
  attempt.then(() => { settled = true; }, () => { settled = true; });
  await clock.advanceAsync(lockTimeoutMs - 1);
  assert.equal(settled, false, `still retrying ${lockTimeoutMs - 1}ms in`);
  await clock.advanceAsync(1);
  await assert.rejects(attempt, (err) => err.code === "LOCKED");
  assert.equal(clock.pending(), 0, "no retry timer outlives the failure");
}

function writeLock(hop, extra) {
  fs.writeFileSync(hop + ".lock", JSON.stringify({ pid: process.pid, hostname: os.hostname(), at: new Date().toISOString(), ...extra }));
}

test("a same-host dead-pid lock is reaped so acquisition proceeds", async () => {
  const dir = tmpdir();
  const hop = path.join(dir, "hop.json");
  writeLock(hop, { pid: deadPid() });
  let ran = false;
  const clock = createManualClock(0);
  await withManifestLock(hop, 5000, async () => { ran = true; }, clock);
  assert.equal(ran, true);
  assert.equal(clock.pending(), 0, "acquired without waiting");
});

test("the manifest lock retries every 25ms on its clock until the holder lets go", async () => {
  const dir = tmpdir();
  const hop = path.join(dir, "hop.json");
  writeLock(hop, { pid: process.pid });
  const clock = createManualClock(0);
  let ran = false;
  const attempt = withManifestLock(hop, 1000, async () => { ran = true; }, clock);
  await clock.advanceAsync(50);
  assert.equal(ran, false);
  fs.unlinkSync(hop + ".lock");
  await clock.advanceAsync(24);
  assert.equal(ran, false, "the next retry is not due until 75ms");
  await clock.advanceAsync(1);
  await attempt;
  assert.equal(ran, true);
  assert.equal(fs.existsSync(hop + ".lock"), false, "the lock is released afterwards");
});

test("the manifest lock records the holder's acquisition time from its clock", async () => {
  const dir = tmpdir();
  const hop = path.join(dir, "hop.json");
  const clock = createManualClock("2026-01-02T03:04:05.000Z");
  let holder;
  await withManifestLock(hop, 1000, async () => { holder = JSON.parse(fs.readFileSync(hop + ".lock", "utf8")); }, clock);
  assert.equal(JSON.stringify(holder).includes("2026-01-02T03:04:05.000Z"), true);
});

test("a live-pid lock is never reaped and yields LOCKED", async () => {
  const dir = tmpdir();
  const hop = path.join(dir, "hop.json");
  writeLock(hop, { pid: process.pid });
  await assertLockedAtDeadline(hop, 100);
});

test("a foreign-host lock is never reaped and yields LOCKED", async () => {
  const dir = tmpdir();
  const hop = path.join(dir, "hop.json");
  writeLock(hop, { pid: deadPid(), hostname: "other-host.invalid" });
  await assertLockedAtDeadline(hop, 100);
});

test("an unparseable lock is never reaped and yields LOCKED", async () => {
  const dir = tmpdir();
  const hop = path.join(dir, "hop.json");
  fs.writeFileSync(hop + ".lock", "{not json");
  await assertLockedAtDeadline(hop, 100);
});

// --- #210: a server that drops stdin mid-probe is a failed call, not a crash --

test("mcpCallSequence reports SPAWN_ERROR when the server closes stdin before the request", { skip: process.platform === "win32" }, async () => {
  // The server closes its stdin and lingers, so the request write hits EPIPE
  // asynchronously; unhandled, that 'error' event aborts the whole process.
  // The deadline sits on a manual clock that never advances, so only the real
  // EPIPE/exit event can settle the call.
  const clock = createManualClock(0);
  const err = await mcpCallSequence(
    { command: "sh", args: ["-c", "exec 0<&-; sleep 2"], timeoutMs: 5000, clock },
    [{ name: "noop", arguments: {} }],
  ).then(() => null, (e) => e);
  assert.ok(err, "expected the call to fail");
  assert.equal(err.code, "SPAWN_ERROR");
  assert.equal(clock.pending(), 0, "the deadline timer is cleared");
});

test("mcpCallSequence reports SPAWN_ERROR when the server exits at once", async () => {
  const clock = createManualClock(0);
  const err = await mcpCallSequence(
    { command: process.execPath, args: ["-e", "process.exit(1)"], timeoutMs: 5000, clock },
    [{ name: "noop", arguments: {} }],
  ).then(() => null, (e) => e);
  assert.ok(err, "expected the call to fail");
  assert.equal(err.code, "SPAWN_ERROR");
  assert.equal(clock.pending(), 0, "the deadline timer is cleared");
});

// --- MCP deadlines on an injected clock -----------------------------------------

const TIMEOUT_SERVER = { command: NODE, args: [FAKE], env: { FAKE_MCP_MODE: "timeout" } };

test("mcpCallSequence times out exactly at timeoutMs on its clock", async () => {
  const clock = createManualClock(0);
  let settled = false;
  const call = mcpCallSequence({ ...TIMEOUT_SERVER, timeoutMs: 500, clock }, [{ name: "noop", arguments: {} }]);
  call.then(() => { settled = true; }, () => { settled = true; });
  assert.equal(clock.pending(), 1, "the deadline is scheduled at spawn");
  await clock.advanceAsync(499);
  assert.equal(settled, false, "not timed out 1ms early");
  await clock.advanceAsync(1);
  await assert.rejects(call, (err) => err.code === "TIMEOUT" && /exceeded 500ms/.test(err.message));
});

test("an MCP session call times out on its clock and the session stays dead", async () => {
  const clock = createManualClock(0);
  const session = await openMcpSession({ ...TIMEOUT_SERVER, timeoutMs: 30_000, clock });
  try {
    assert.equal(clock.pending(), 0, "the handshake schedules no timer");
    let settled = false;
    const call = session.call([{ name: "noop", arguments: {} }], 300);
    call.then(() => { settled = true; }, () => { settled = true; });
    assert.equal(clock.pending(), 1);
    await clock.advanceAsync(299);
    assert.equal(settled, false, "not timed out 1ms early");
    await clock.advanceAsync(1);
    await assert.rejects(call, (err) => err.code === "TIMEOUT" && /exceeded 300ms/.test(err.message));
    assert.equal(clock.pending(), 0, "the fired deadline is cleared");
    await assert.rejects(session.call([{ name: "noop", arguments: {} }]), (err) => err.code === "TIMEOUT");
  } finally {
    await session.close();
  }
});
