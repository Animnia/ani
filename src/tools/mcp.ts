/**
 * Minimal MCP client — zero deps, speaks just enough of the Model Context
 * Protocol to list and call tools. stdio (newline-delimited JSON-RPC 2.0)
 * and streamable-HTTP transports. Servers are configured in ani.json:
 *
 *   "mcpServers": {
 *     "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/"] },
 *     "remote": { "url": "https://example.com/mcp" }
 *   }
 *
 * Each server tool becomes an agent tool named mcp_<server>_<tool>.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { McpServerConfig } from "../core/config.ts";
import { httpRequest } from "../core/net.ts";
import { log, warn } from "../core/log.ts";
import type { ToolDef } from "../core/types.ts";

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "ani", version: "0.1.0" };

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpCallResult {
  content?: { type: string; text?: string; [k: string]: unknown }[];
  isError?: boolean;
}

abstract class McpTransport {
  abstract request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  abstract notify(method: string): void;
  abstract close(): void;
}

class StdioTransport extends McpTransport {
  private child: ChildProcess;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;

  constructor(cfg: McpServerConfig) {
    super();
    if (!cfg.command) throw new Error("stdio MCP server needs a command");
    // shell needed only for .cmd/.bat shims (npx etc.) on Windows; a direct
    // .exe with spaces in its path breaks under shell quoting
    const needsShell = process.platform === "win32" && !/\.exe$/i.test(cfg.command);
    this.child = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
      shell: needsShell,
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.onData(chunk));
    this.child.on("exit", (code) => {
      this.closed = true;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server exited (code ${code})`));
        this.pending.delete(id);
      }
    });
    this.child.on("error", () => {});
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      // server→client REQUEST (has method + id, e.g. roots/list, sampling):
      // answer with MethodNotFound instead of leaving the server hanging
      if ((msg as any).method && msg.id !== undefined) {
        try {
          this.child.stdin!.write(
            JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "ani does not serve client requests" } }) + "\n",
          );
        } catch {
          /* dying */
        }
        continue;
      }
      if (msg.id === undefined) continue; // notification — ignore
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("MCP server process is dead"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timeout (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string): void {
    if (this.closed) return;
    try {
      this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
    } catch {
      /* dying */
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.child.kill();
    } catch {
      /* already dead */
    }
  }
}

class HttpTransport extends McpTransport {
  private nextId = 1;
  private sessionId: string | null = null;
  private cfg: McpServerConfig;
  private proxy?: string;

  constructor(cfg: McpServerConfig, proxy?: string) {
    super();
    this.cfg = cfg;
    this.proxy = proxy;
    if (!cfg.url) throw new Error("http MCP server needs a url");
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await httpRequest(this.cfg.url!, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      proxy: this.proxy,
      timeoutMs,
    });
    if (res.headers["mcp-session-id"]) this.sessionId = res.headers["mcp-session-id"];
    if (res.status >= 400) throw new Error(`MCP HTTP ${res.status}: ${res.body.toString("utf8").slice(0, 300)}`);
    const text = res.body.toString("utf8");
    // streamable HTTP may answer with SSE frames
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    const payload: JsonRpcResponse = JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
    if (payload.error) throw new Error(`MCP error ${payload.error.code}: ${payload.error.message}`);
    return payload.result;
  }

  notify(method: string): void {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    void httpRequest(this.cfg.url!, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method }),
      proxy: this.proxy,
      timeoutMs: 10_000,
    }).catch(() => {});
  }

  close(): void {
    /* stateless */
  }
}

class McpClient {
  tools: McpTool[] = [];
  private name: string;
  private transport: McpTransport;
  constructor(name: string, transport: McpTransport) {
    this.name = name;
    this.transport = transport;
  }

  static async connect(name: string, cfg: McpServerConfig, proxy?: string): Promise<McpClient> {
    const transport = cfg.url ? new HttpTransport(cfg, proxy) : new StdioTransport(cfg);
    const timeoutMs = (cfg.timeoutSec ?? 30) * 1000;
    try {
      await transport.request(
        "initialize",
        { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
        timeoutMs,
      );
      transport.notify("notifications/initialized");
      const result = (await transport.request("tools/list", {}, timeoutMs)) as { tools?: McpTool[] };
      const client = new McpClient(name, transport);
      client.tools = result.tools ?? [];
      return client;
    } catch (e) {
      transport.close();
      throw e;
    }
  }

  async call(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const result = (await this.transport.request("tools/call", { name: tool, arguments: args }, timeoutMs)) as McpCallResult;
    const parts = (result.content ?? []).map((c) => {
      if (c.type === "text") return c.text ?? "";
      return `[${c.type}] ${JSON.stringify(c).slice(0, 500)}`;
    });
    const text = parts.join("\n").slice(0, 50_000);
    return result.isError ? `Error: ${text}` : text || "(empty result)";
  }

  close(): void {
    this.transport.close();
  }
}

export class McpManager {
  private clients: McpClient[] = [];

  /** Connect to all configured servers. Failures are logged, never fatal. */
  async init(servers: Record<string, McpServerConfig>, proxy?: string): Promise<ToolDef[]> {
    const out: ToolDef[] = [];
    for (const [name, cfg] of Object.entries(servers)) {
      try {
        const client = await McpClient.connect(name, cfg, proxy);
        this.clients.push(client);
        log("mcp", `${name}: connected, ${client.tools.length} tools`);
        for (const t of client.tools) {
          const safeName = `mcp_${name}_${t.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
          out.push({
            name: safeName,
            description: `[MCP ${name}] ${t.description ?? t.name}`.slice(0, 500),
            parameters: t.inputSchema ?? { type: "object", properties: {} },
            execute: (args) => client.call(t.name, args, (cfg.timeoutSec ?? 60) * 1000),
          });
        }
      } catch (e) {
        warn("mcp", `${name}: connect failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return out;
  }

  close(): void {
    for (const c of this.clients) c.close();
    this.clients = [];
  }
}
