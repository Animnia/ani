/**
 * Mock MCP server over stdio (newline-delimited JSON-RPC 2.0).
 * Implements initialize / tools/list / tools/call with one "add" tool.
 */
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "initialize") {
      reply(msg.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0" } });
    } else if (msg.method === "notifications/initialized") {
      // no reply
    } else if (msg.method === "tools/list") {
      reply(msg.id, {
        tools: [
          {
            name: "add",
            description: "Add two numbers",
            inputSchema: {
              type: "object",
              properties: { a: { type: "number" }, b: { type: "number" } },
              required: ["a", "b"],
            },
          },
        ],
      });
    } else if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params ?? {};
      if (name === "add") {
        reply(msg.id, { content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }] });
      } else {
        reply(msg.id, { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true });
      }
    }
  }
});

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
