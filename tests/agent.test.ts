/**
 * Agent loop tests with a mocked StreamFn — no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../src/core/agent.ts";
import type { Msg, StreamFn, ToolDef } from "../src/core/types.ts";

const ctx = { chatKey: "t:t", channel: "t", chatId: "t", cwd: process.cwd() };

const echoTool: ToolDef = {
  name: "echo",
  description: "echo back",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  async execute(args) {
    return `echo: ${args.text}`;
  },
};

const boomTool: ToolDef = {
  name: "boom",
  description: "always throws",
  parameters: { type: "object", properties: {} },
  async execute() {
    throw new Error("kaput");
  },
};

test("plain answer, no tools", { timeout: 5000 }, async () => {
  const streamFn: StreamFn = async () => ({ content: "hello human", reasoning: "r", toolCalls: [], finishReason: "stop" });
  const messages: Msg[] = [{ role: "user", content: "hi" }];
  const res = await runAgent({ messages, tools: [], streamFn, model: "m", ctx });
  assert.equal(res.text, "hello human");
  assert.equal(messages.length, 2);
  assert.equal(messages[1].reasoning_content, "r");
});

test("tool call loop completes and chains stay consistent", { timeout: 5000 }, async () => {
  let call = 0;
  const streamFn: StreamFn = async ({ messages }) => {
    call++;
    if (call === 1) {
      return {
        content: "",
        reasoning: "need to echo",
        toolCalls: [{ id: "c1", type: "function", function: { name: "echo", arguments: '{"text":"ping"}' } }],
        finishReason: "tool_calls",
      };
    }
    // verify the tool result arrived
    const toolMsg = messages[messages.length - 1];
    assert.equal(toolMsg.role, "tool");
    assert.equal(toolMsg.content, "echo: ping");
    return { content: "done: ping", reasoning: "", toolCalls: [], finishReason: "stop" };
  };
  const messages: Msg[] = [{ role: "user", content: "echo ping" }];
  const res = await runAgent({ messages, tools: [echoTool], streamFn, model: "m", ctx });
  assert.equal(res.text, "done: ping");
  assert.equal(res.rounds, 2);
  // user, assistant(tc), tool, assistant
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
});

test("tool errors are reported, not thrown", { timeout: 5000 }, async () => {
  let call = 0;
  const streamFn: StreamFn = async () => {
    call++;
    if (call === 1) {
      return { content: "", reasoning: "", toolCalls: [{ id: "b1", type: "function", function: { name: "boom", arguments: "{}" } }], finishReason: "tool_calls" };
    }
    return { content: "recovered", reasoning: "", toolCalls: [], finishReason: "stop" };
  };
  const messages: Msg[] = [{ role: "user", content: "go" }];
  await runAgent({ messages, tools: [boomTool], streamFn, model: "m", ctx });
  const toolMsg = messages.find((m) => m.role === "tool");
  assert.match(toolMsg!.content, /Error: kaput/);
});

test("unknown tool gets an error result", { timeout: 5000 }, async () => {
  let call = 0;
  const streamFn: StreamFn = async () => {
    call++;
    if (call === 1) {
      return { content: "", reasoning: "", toolCalls: [{ id: "x1", type: "function", function: { name: "nope", arguments: "{}" } }], finishReason: "tool_calls" };
    }
    return { content: "ok", reasoning: "", toolCalls: [], finishReason: "stop" };
  };
  const messages: Msg[] = [{ role: "user", content: "go" }];
  await runAgent({ messages, tools: [], streamFn, model: "m", ctx });
  assert.match(messages.find((m) => m.role === "tool")!.content, /unknown tool/);
});

test("tool arguments are validated before execution", { timeout: 5000 }, async () => {
  for (const [argumentsJson, expected] of [
    ["not-json", /not valid JSON/],
    ['{"text":42}', /must be string/],
    ['["ping"]', /must be a JSON object/],
  ] as const) {
    let executed = 0;
    let round = 0;
    const guarded: ToolDef = { ...echoTool, async execute(args, context) { executed++; return echoTool.execute(args, context); } };
    const streamFn: StreamFn = async () => {
      if (round++ === 0) {
        return {
          content: "",
          reasoning: "",
          toolCalls: [{ id: "v1", type: "function", function: { name: "echo", arguments: argumentsJson } }],
          finishReason: "tool_calls",
        };
      }
      return { content: "handled", reasoning: "", toolCalls: [], finishReason: "stop" };
    };
    const messages: Msg[] = [{ role: "user", content: "go" }];
    await runAgent({ messages, tools: [guarded], streamFn, model: "m", ctx });
    assert.equal(executed, 0);
    assert.match(messages.find((m) => m.role === "tool")!.content, expected);
  }
});

test("tool authorization is enforced before execution", { timeout: 5000 }, async () => {
  let executed = 0;
  let round = 0;
  const guarded: ToolDef = { ...echoTool, async execute() { executed++; return "unsafe"; } };
  const streamFn: StreamFn = async () =>
    round++ === 0
      ? {
          content: "",
          reasoning: "",
          toolCalls: [{ id: "p1", type: "function", function: { name: "echo", arguments: '{"text":"ping"}' } }],
          finishReason: "tool_calls",
        }
      : { content: "denied safely", reasoning: "", toolCalls: [], finishReason: "stop" };
  const messages: Msg[] = [{ role: "user", content: "go" }];
  await runAgent({
    messages,
    tools: [guarded],
    streamFn,
    model: "m",
    ctx: { ...ctx, authorizeTool: () => ({ allowed: false, reason: "blocked by policy" }) },
  });
  assert.equal(executed, 0);
  assert.match(messages.find((m) => m.role === "tool")!.content, /blocked by policy/);
});

test("abort stops the loop and completes the chain", { timeout: 5000 }, async () => {
  const controller = new AbortController();
  let call = 0;
  const streamFn: StreamFn = async () => {
    call++;
    if (call === 1) {
      controller.abort();
      return {
        content: "",
        reasoning: "",
        toolCalls: [
          { id: "a1", type: "function", function: { name: "echo", arguments: '{"text":"1"}' } },
          { id: "a2", type: "function", function: { name: "echo", arguments: '{"text":"2"}' } },
        ],
        finishReason: "tool_calls",
      };
    }
    return { content: "never", reasoning: "", toolCalls: [], finishReason: "stop" };
  };
  const messages: Msg[] = [{ role: "user", content: "go" }];
  const res = await runAgent({ messages, tools: [echoTool], streamFn, model: "m", ctx, signal: controller.signal });
  assert.equal(res.aborted, true);
  assert.equal(call, 1, "no second API call after abort");
  // both tool calls got results (aborted markers) — chain is valid for the API
  const tools = messages.filter((m) => m.role === "tool");
  assert.equal(tools.length, 2);
  assert.match(tools[0].content, /aborted/);
});

test("round limit produces a final answer", { timeout: 10_000 }, async () => {
  let call = 0;
  const streamFn: StreamFn = async ({ tools }) => {
    call++;
    if (tools.length === 0) return { content: "final after limit", reasoning: "", toolCalls: [], finishReason: "stop" };
    return { content: "", reasoning: "", toolCalls: [{ id: `c${call}`, type: "function", function: { name: "echo", arguments: "{}" } }], finishReason: "tool_calls" };
  };
  const messages: Msg[] = [{ role: "user", content: "loop forever" }];
  const res = await runAgent({ messages, tools: [echoTool], streamFn, model: "m", ctx, maxRounds: 3 });
  assert.equal(res.text, "final after limit");
  assert.equal(res.rounds, 3);
});
