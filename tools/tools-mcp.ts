/**
 * Bounded MCP stdio JSON-RPC client for junior-tools.
 * Split from tools/tools.ts per ADR 0016; the facade re-exports the public API.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import process from "node:process";
import { systemClock } from "../clock.ts";
import type { Clock, ClockTimer } from "../clock.ts";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  HopError,
  MCP_PROTOCOL_VERSION,
  isRecord,
} from "./tools-manifest.ts";

// ---------------------------------------------------------------------------
// MCP stdio JSON-RPC client (bounded, id-correlated, process-group kill)
// ---------------------------------------------------------------------------

export interface McpCallSpec {
  name: string;
  arguments: unknown;
}

export interface McpSequenceOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes?: number;
  /** Time source for the call deadline (default: the system clock). */
  clock?: Clock;
}

export interface McpSequenceResult {
  value: unknown;
  isError: boolean;
  /** Bounded stderr tail, used to verify which native database a server opened. */
  stderr: string;
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

function extractStructured(result: unknown): unknown {
  if (!isRecord(result)) return result;
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (result.structured_content !== undefined) return result.structured_content;
  const content = Array.isArray(result.content) ? result.content : [];
  const textPart = content.find(
    (part): part is Record<string, unknown> =>
      isRecord(part) && part.type === "text" && typeof part.text === "string",
  );
  if (textPart && typeof textPart.text === "string") {
    try {
      return JSON.parse(textPart.text);
    } catch {
      return textPart.text;
    }
  }
  return result;
}

type McpSequenceState = {
  child: ChildProcess;
  settled: boolean;
  clock: Clock;
  timer: ClockTimer | null;
  stdoutBuf: Buffer;
  stdoutBytes: number;
  stderrText: string;
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>;
  resolve: (value: McpSequenceResult) => void;
  reject: (err: unknown) => void;
};

function sequenceCleanup(st: McpSequenceState): void {
  if (st.timer) {
    st.clock.clearTimeout(st.timer);
    st.timer = null;
  }
}

function sequenceFail(st: McpSequenceState, err: unknown): void {
  if (st.settled) return;
  st.settled = true;
  sequenceCleanup(st);
  killTree(st.child);
  for (const p of st.pending.values()) p.reject(err);
  st.pending.clear();
  st.reject(err);
}

function sequenceSucceed(st: McpSequenceState, value: McpSequenceResult): void {
  if (st.settled) return;
  st.settled = true;
  sequenceCleanup(st);
  killTree(st.child);
  st.resolve(value);
}

function sequenceWrite(st: McpSequenceState, obj: unknown): void {
  const child = st.child;
  if (!child.stdin || child.stdin.destroyed) return;
  try {
    child.stdin.write(JSON.stringify(obj) + "\n");
  } catch (err) {
    sequenceFail(st, new HopError("SPAWN_ERROR", `cannot write to MCP server: ${String(err)}`, err));
  }
}

function sequenceRequest(st: McpSequenceState, method: string, params: unknown): Promise<unknown> {
  const id = st.nextId++;
  return new Promise<unknown>((res, rej) => {
    st.pending.set(id, { resolve: res, reject: rej });
    sequenceWrite(st, { jsonrpc: "2.0", id, method, params });
  });
}

function sequenceNotify(st: McpSequenceState, method: string, params: unknown): void {
  sequenceWrite(st, { jsonrpc: "2.0", method, params });
}

function sequenceHandleLine(st: McpSequenceState, line: string): void {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(msg) || msg.id === undefined || msg.id === null) return;
  const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
  const entry = st.pending.get(id);
  if (!entry) return;
  st.pending.delete(id);
  if (isRecord(msg.error)) {
    const message = typeof msg.error.message === "string" ? msg.error.message : "JSON-RPC error";
    entry.reject(new HopError("RPC_ERROR", message, msg.error));
  } else {
    entry.resolve(msg.result);
  }
}

function attachSequenceProcessListeners(st: McpSequenceState, command: string): void {
  const child = st.child;
  child.on("error", (err) => {
    sequenceFail(st, new HopError("SPAWN_ERROR", `failed to spawn '${command}': ${err.message}`, err));
  });
  // A server that exits or closes stdin while a request is being written
  // raises EPIPE asynchronously on the stdin stream; unhandled, it aborts the
  // whole process (and strands any lock its caller holds). Report it as a
  // failed call instead (#210).
  child.stdin?.on("error", (err) => {
    sequenceFail(st, new HopError("SPAWN_ERROR", `cannot write to MCP server '${command}': ${err.message}`, err));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (st.stderrText.length < 8192) st.stderrText += chunk.toString("utf8");
  });
  child.on("exit", (code, signal) => {
    if (st.settled) return;
    if (st.pending.size > 0) {
      const tail = st.stderrText.trim();
      sequenceFail(
        st,
        new HopError(
          "SPAWN_ERROR",
          `MCP server exited before responding (code=${String(code)} signal=${String(signal)})${tail ? `: ${tail}` : ""}`,
        ),
      );
    }
  });
}

function attachSequenceStdout(st: McpSequenceState, maxOutputBytes: number): void {
  st.child.stdout?.on("data", (chunk: Buffer) => {
    st.stdoutBytes += chunk.length;
    if (st.stdoutBytes > maxOutputBytes) {
      sequenceFail(st, new HopError("OUTPUT_LIMIT", `MCP output exceeded ${maxOutputBytes} bytes`));
      return;
    }
    st.stdoutBuf = Buffer.concat([st.stdoutBuf, chunk]);
    let idx: number;
    while ((idx = st.stdoutBuf.indexOf(0x0a)) !== -1) {
      const line = st.stdoutBuf.subarray(0, idx).toString("utf8").trim();
      st.stdoutBuf = st.stdoutBuf.subarray(idx + 1);
      if (line) sequenceHandleLine(st, line);
    }
  });
}

async function runSequenceCalls(st: McpSequenceState, calls: McpCallSpec[]): Promise<void> {
  await sequenceRequest(st, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "junior-tools", version: "0.1.0" },
  });
  sequenceNotify(st, "notifications/initialized", {});
  let last: unknown;
  for (const call of calls) {
    last = await sequenceRequest(st, "tools/call", { name: call.name, arguments: call.arguments ?? {} });
  }
  const isError = isRecord(last) && last.isError === true;
  sequenceSucceed(st, { value: extractStructured(last), isError, stderr: st.stderrText });
}

/**
 * Spawn an MCP server, run `initialize` + `notifications/initialized`, then
 * issue each `tools/call` in order, returning the LAST result. The connection
 * is closed and the whole process group killed on success, error, or timeout.
 */
export async function mcpCallSequence(
  options: McpSequenceOptions,
  calls: McpCallSpec[],
): Promise<McpSequenceResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const child = spawn(options.command, options.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(options.env ?? {}) },
    detached: true,
  });

  return new Promise<McpSequenceResult>((resolve, reject) => {
    const st: McpSequenceState = {
      child,
      settled: false,
      clock: options.clock ?? systemClock,
      timer: null,
      stdoutBuf: Buffer.alloc(0),
      stdoutBytes: 0,
      stderrText: "",
      nextId: 1,
      pending: new Map(),
      resolve,
      reject,
    };

    st.timer = st.clock.setTimeout(() => {
      sequenceFail(st, new HopError("TIMEOUT", `MCP call exceeded ${timeoutMs}ms`));
    }, timeoutMs);

    attachSequenceProcessListeners(st, options.command);
    attachSequenceStdout(st, maxOutputBytes);

    void runSequenceCalls(st, calls).catch((err) => sequenceFail(st, err));
  });
}
/** Convenience wrapper for a single tool call. */
export function mcpCallTool(
  options: McpSequenceOptions,
  toolName: string,
  args: unknown,
): Promise<McpSequenceResult> {
  return mcpCallSequence(options, [{ name: toolName, arguments: args }]);
}

// ---------------------------------------------------------------------------
// Long-lived MCP stdio session (one spawn, many `tools/call` sequences)
// ---------------------------------------------------------------------------

/**
 * One open MCP server connection that can run several `tools/call` sequences
 * without respawning. Once the server exits, errors, or times out, the session
 * is permanently unusable and every further call re-raises the first HopError.
 */
export interface McpSession {
  call(calls: McpCallSpec[], timeoutMs?: number): Promise<McpSequenceResult>;
  close(): Promise<void>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

class McpClientSession implements McpSession {
  private readonly child: ChildProcess;
  private readonly command: string;
  private readonly maxOutputBytes: number;
  private readonly defaultTimeoutMs: number;
  private readonly clock: Clock;
  private stdoutBuf = Buffer.alloc(0);
  private stdoutBytes = 0;
  private stderrText = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private dead: HopError | null = null;
  private closed = false;

  private constructor(
    child: ChildProcess,
    command: string,
    maxOutputBytes: number,
    defaultTimeoutMs: number,
    clock: Clock,
  ) {
    this.child = child;
    this.clock = clock;
    this.command = command;
    this.maxOutputBytes = maxOutputBytes;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  static async open(options: McpSequenceOptions): Promise<McpClientSession> {
    const child = spawn(options.command, options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(options.env ?? {}) },
      detached: true,
    });
    const session = new McpClientSession(
      child,
      options.command,
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options.clock ?? systemClock,
    );
    session.wire();
    await session.initialize();
    return session;
  }

  private wire(): void {
    this.child.on("error", (err) => {
      this.die(new HopError("SPAWN_ERROR", `failed to spawn '${this.command}': ${err.message}`, err));
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      if (this.stderrText.length < 8192) this.stderrText += chunk.toString("utf8");
    });
    this.child.on("exit", (code, signal) => {
      if (this.closed) return;
      const tail = this.stderrText.trim();
      this.die(
        new HopError(
          "SPAWN_ERROR",
          `MCP server exited before responding (code=${String(code)} signal=${String(signal)})${tail ? `: ${tail}` : ""}`,
        ),
      );
    });
    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutBytes += chunk.length;
      if (this.stdoutBytes > this.maxOutputBytes) {
        this.die(new HopError("OUTPUT_LIMIT", `MCP output exceeded ${this.maxOutputBytes} bytes`));
        return;
      }
      this.stdoutBuf = Buffer.concat([this.stdoutBuf, chunk]);
      let idx: number;
      while ((idx = this.stdoutBuf.indexOf(0x0a)) !== -1) {
        const line = this.stdoutBuf.subarray(0, idx).toString("utf8").trim();
        this.stdoutBuf = this.stdoutBuf.subarray(idx + 1);
        if (line) this.handleLine(line);
      }
    });
  }

  private die(err: HopError): void {
    if (this.dead === null) this.dead = err;
    killTree(this.child);
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
  }

  private write(obj: unknown): void {
    if (!this.child.stdin || this.child.stdin.destroyed) return;
    try {
      this.child.stdin.write(JSON.stringify(obj) + "\n");
    } catch (err) {
      this.die(new HopError("SPAWN_ERROR", `cannot write to MCP server: ${String(err)}`, err));
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.dead !== null) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(msg) || msg.id === undefined || msg.id === null) return;
    const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (isRecord(msg.error)) {
      const message = typeof msg.error.message === "string" ? msg.error.message : "JSON-RPC error";
      entry.reject(new HopError("RPC_ERROR", message, msg.error));
    } else {
      entry.resolve(msg.result);
    }
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "junior-tools", version: "0.1.0" },
    });
    this.write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  call(calls: McpCallSpec[], timeoutMs: number = this.defaultTimeoutMs): Promise<McpSequenceResult> {
    if (this.dead !== null) return Promise.reject(this.dead);
    if (this.closed) return Promise.reject(new HopError("SPAWN_ERROR", "MCP session is closed"));
    return new Promise<McpSequenceResult>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        this.die(new HopError("TIMEOUT", `MCP call exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      void (async () => {
        let last: unknown;
        for (const call of calls) {
          last = await this.request("tools/call", { name: call.name, arguments: call.arguments ?? {} });
        }
        const isError = isRecord(last) && last.isError === true;
        resolve({ value: extractStructured(last), isError, stderr: this.stderrText });
      })().then(
        () => this.clock.clearTimeout(timer),
        (err) => {
          this.clock.clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    killTree(this.child);
    return Promise.resolve();
  }
}

/** Spawn one MCP server process, run the initialize handshake, and keep it alive. */
export function openMcpSession(options: McpSequenceOptions): Promise<McpSession> {
  return McpClientSession.open(options);
}
