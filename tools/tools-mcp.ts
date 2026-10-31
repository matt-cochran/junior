/**
 * Bounded MCP stdio JSON-RPC client for junior-tools.
 * Split from tools/tools.ts per ADR 0016; the facade re-exports the public API.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import process from "node:process";
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
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let stdoutBuf = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrText = "";
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      killTree(child);
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      reject(err);
    };
    const succeed = (value: McpSequenceResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      killTree(child);
      resolve(value);
    };

    timer = setTimeout(() => {
      fail(new HopError("TIMEOUT", `MCP call exceeded ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      fail(new HopError("SPAWN_ERROR", `failed to spawn '${options.command}': ${err.message}`, err));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrText.length < 8192) stderrText += chunk.toString("utf8");
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      if (pending.size > 0) {
        const tail = stderrText.trim();
        fail(
          new HopError(
            "SPAWN_ERROR",
            `MCP server exited before responding (code=${String(code)} signal=${String(signal)})${tail ? `: ${tail}` : ""}`,
          ),
        );
      }
    });

    function write(obj: unknown): void {
      if (!child.stdin || child.stdin.destroyed) return;
      try {
        child.stdin.write(JSON.stringify(obj) + "\n");
      } catch (err) {
        fail(new HopError("SPAWN_ERROR", `cannot write to MCP server: ${String(err)}`, err));
      }
    }

    function request(method: string, params: unknown): Promise<unknown> {
      const id = nextId++;
      return new Promise<unknown>((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        write({ jsonrpc: "2.0", id, method, params });
      });
    }

    function notify(method: string, params: unknown): void {
      write({ jsonrpc: "2.0", method, params });
    }

    function handleLine(line: string): void {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(msg) || msg.id === undefined || msg.id === null) return;
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (isRecord(msg.error)) {
        const message = typeof msg.error.message === "string" ? msg.error.message : "JSON-RPC error";
        entry.reject(new HopError("RPC_ERROR", message, msg.error));
      } else {
        entry.resolve(msg.result);
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        fail(new HopError("OUTPUT_LIMIT", `MCP output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
      let idx: number;
      while ((idx = stdoutBuf.indexOf(0x0a)) !== -1) {
        const line = stdoutBuf.subarray(0, idx).toString("utf8").trim();
        stdoutBuf = stdoutBuf.subarray(idx + 1);
        if (line) handleLine(line);
      }
    });

    void (async () => {
      await request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "junior-tools", version: "0.1.0" },
      });
      notify("notifications/initialized", {});
      let last: unknown;
      for (const call of calls) {
        last = await request("tools/call", { name: call.name, arguments: call.arguments ?? {} });
      }
      const isError = isRecord(last) && last.isError === true;
      succeed({ value: extractStructured(last), isError, stderr: stderrText });
    })().catch((err) => fail(err));
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
  private stdoutBuf = Buffer.alloc(0);
  private stdoutBytes = 0;
  private stderrText = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private dead: HopError | null = null;
  private closed = false;

  private constructor(child: ChildProcess, command: string, maxOutputBytes: number, defaultTimeoutMs: number) {
    this.child = child;
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
      const timer = setTimeout(() => {
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
        () => clearTimeout(timer),
        (err) => {
          clearTimeout(timer);
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
