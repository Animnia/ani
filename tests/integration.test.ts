/**
 * LIVE integration tests — DeepSeek, Telegram (via proxy), QQ gateway,
 * web search. These hit real services with the test credentials from RULE.md.
 * Strict timeouts everywhere; a network outage fails these loudly (as it
 * should — they prove real connectivity).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeepSeekStream } from "../src/core/deepseek.ts";
import { loadConfig } from "../src/core/config.ts";
import { httpRequest } from "../src/core/net.ts";
import { webSearchTool, fetchUrlTool } from "../src/tools/web.ts";
import { hasLiveCredentials, needs } from "./helpers.ts";

const cfg = loadConfig();
const ctx = { chatKey: "t:t", channel: "t", chatId: "t", cwd: process.cwd() };
const live = hasLiveCredentials();
const SKIP = needs(live, "valid deepseek.apiKey in ani.json");
const tg = cfg.channels.telegram;
const qq = cfg.channels.qq;
const SKIP_TG = needs(Boolean(tg?.enabled && tg.token), "telegram channel configured");
const SKIP_QQ = needs(Boolean(qq?.enabled && qq.appId), "qq channel configured");

test("DeepSeek: streaming chat", { timeout: 60_000, ...SKIP }, async () => {
  const stream = createDeepSeekStream({ apiKey: cfg.deepseek.apiKey, baseUrl: cfg.deepseek.baseUrl });
  let streamed = "";
  const res = await stream({
    model: cfg.model,
    messages: [{ role: "user", content: "Reply with exactly: ANI_OK" }],
    tools: [],
    onTextDelta: (d) => (streamed += d),
    maxTokens: 4096,
  });
  assert.match(res.content, /ANI_OK/);
  assert.equal(streamed, res.content, "deltas add up to the full content");
  assert.ok(res.usage && res.usage.prompt_tokens! > 0);
});

test("DeepSeek: tool call + reasoning round-trip (the 400 trap)", { timeout: 90_000, ...SKIP }, async () => {
  const stream = createDeepSeekStream({ apiKey: cfg.deepseek.apiKey, baseUrl: cfg.deepseek.baseUrl });
  const tools = [
    {
      type: "function" as const,
      function: {
        name: "get_weather",
        description: "Get weather for a city",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    },
  ];
  const r1 = await stream({
    model: cfg.model,
    messages: [{ role: "user", content: "北京天气怎么样？调用工具查" }],
    tools,
    maxTokens: 4096,
  });
  assert.ok(r1.toolCalls.length >= 1, `expected a tool call, got: ${r1.content}`);
  assert.equal(r1.toolCalls[0].function.name, "get_weather");

  // second turn: append assistant message WITH reasoning_content + tool result.
  // This must NOT 400 — that was the DeepSeek requirement.
  const r2 = await stream({
    model: cfg.model,
    messages: [
      { role: "user", content: "北京天气怎么样？调用工具查" },
      {
        role: "assistant",
        content: r1.content,
        reasoning_content: r1.reasoning,
        tool_calls: r1.toolCalls,
      },
      { role: "tool", tool_call_id: r1.toolCalls[0].id, content: '{"temp":"-2°C","cond":"晴"}' },
    ],
    tools,
    maxTokens: 4096,
  });
  assert.ok(r2.content.length > 0, "model answered after tool result");
});

test("Telegram: getMe via proxy", { timeout: 30_000, ...SKIP_TG }, async () => {
  const res = await httpRequest(`https://api.telegram.org/bot${tg!.token}/getMe`, {
    proxy: tg!.useProxy ? cfg.proxy : undefined,
    timeoutMs: 20_000,
  });
  const data = JSON.parse(res.body.toString("utf8"));
  assert.equal(data.ok, true);
  assert.equal(data.result.is_bot, true);
});

test("QQ: token + gateway url", { timeout: 30_000, ...SKIP_QQ }, async () => {
  const tokenRes = await httpRequest("https://bots.qq.com/app/getAppAccessToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: qq!.appId, clientSecret: qq!.clientSecret }),
    timeoutMs: 15_000,
  });
  const token = JSON.parse(tokenRes.body.toString("utf8")).access_token;
  assert.ok(token, "got access token");

  const gw = await httpRequest("https://api.sgroup.qq.com/gateway", {
    headers: { Authorization: `QQBot ${token}` },
    timeoutMs: 15_000,
  });
  const data = JSON.parse(gw.body.toString("utf8"));
  assert.match(data.url, /^wss:\/\//);
});

test("web_search returns results", { timeout: 45_000, ...needs(live, "network") }, async () => {
  const out = await webSearchTool.execute({ query: "DeepSeek V4 发布" }, ctx);
  assert.ok(!out.startsWith("Error"), out.slice(0, 300));
  assert.match(out, /http/);
});

test("fetch_url converts html to text", { timeout: 45_000, ...needs(live, "network") }, async () => {
  const out = await fetchUrlTool.execute({ url: "https://example.com" }, ctx);
  assert.match(out, /Example Domain/);
});
