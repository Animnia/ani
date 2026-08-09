/**
 * MCP client test against a local mock stdio server. Strict timeouts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { McpManager } from "../src/tools/mcp.ts";

const ctx = { chatKey: "t:t", channel: "t", chatId: "t", cwd: process.cwd() };
const FIXTURE = new URL("./fixtures/mock-mcp-server.cjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("MCP stdio: connect, list tools, call", { timeout: 30_000 }, async () => {
  const mgr = new McpManager();
  try {
    const tools = await mgr.init({
      mock: { command: process.execPath, args: [FIXTURE], timeoutSec: 10 },
    });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "mcp_mock_add");
    assert.match(tools[0].description, /Add two numbers/);

    const out = await tools[0].execute({ a: 2, b: 40 }, ctx);
    assert.equal(out, "42");

    const err = await tools[0].execute({ a: "x", b: 1 }, ctx);
    assert.equal(err, "NaN"); // server computes NaN — client passes it through
  } finally {
    mgr.close();
  }
});

test("MCP stdio: dead server fails cleanly, not fatally", { timeout: 30_000 }, async () => {
  const mgr = new McpManager();
  try {
    const tools = await mgr.init({
      bad: { command: process.execPath, args: ["-e", "process.exit(1)"], timeoutSec: 5 },
    });
    assert.equal(tools.length, 0, "no tools from a dead server");
  } finally {
    mgr.close();
  }
});
