import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolPolicy } from "../src/core/tool-policy.ts";

test("group mode exposes only explicitly public tools", () => {
  const policy = new ToolPolicy();
  const tools = [{ name: "web_search" }, { name: "read_file" }, { name: "shell" }, { name: "mcp_x_y" }];
  assert.deepEqual(policy.toolsForMode(tools, "group").map((tool) => tool.name), ["web_search"]);
  assert.equal(policy.authorize("qq:g", "group", "read_file", { path: "secret" }).allowed, false);
  assert.equal(policy.authorize("qq:g", "group", "web_search", { query: "public news" }).allowed, true);
});

test("privileged approval is exact, chat-bound, expiring and one-shot", () => {
  const policy = new ToolPolicy();
  const args = { command: "echo safe" };
  const denied = policy.authorize("qq:owner", "private", "shell", args, "attempt-1");
  assert.equal(denied.allowed, false);
  const token = /\/confirm ([A-F0-9]{8})/.exec(denied.reason ?? "")?.[1];
  assert.ok(token);
  const repeated = policy.authorize("qq:owner", "private", "shell", args, "attempt-1");
  assert.match(repeated.reason ?? "", new RegExp(`/confirm ${token}`), "same frozen call reuses its pending code");
  assert.equal(policy.confirm("qq:other", token!, "attempt-2"), null, "another chat cannot approve it");
  const approval = policy.confirm("qq:owner", token!, "attempt-2");
  assert.equal(approval?.toolName, "shell");
  assert.match(approval?.argsPreview ?? "", /echo safe/);
  assert.equal(policy.authorize("qq:owner", "private", "shell", { command: "echo changed" }, "attempt-2").allowed, false);
  assert.equal(policy.authorize("qq:owner", "private", "shell", args, "attempt-2").allowed, true);
  assert.equal(policy.authorize("qq:owner", "private", "shell", args, "attempt-2").allowed, false, "grant was consumed");
});

test("read-only private actions work without approval; cross-chat actions do not", () => {
  const policy = new ToolPolicy();
  assert.equal(policy.authorize("qq:owner", "private", "read_file", { path: "x" }).allowed, true);
  assert.equal(policy.authorize("qq:owner", "private", "browser", { action: "text" }).allowed, true);
  assert.equal(policy.authorize("qq:owner", "private", "browser", { action: "open", url: "https://example.com" }).allowed, false);
  assert.equal(policy.authorize("qq:owner", "private", "browser", { action: "click", selector: "#buy" }).allowed, false);
  assert.equal(policy.authorize("qq:owner", "private", "fetch_url", { url: "https://example.com" }).allowed, false);
  assert.equal(policy.authorize("qq:owner", "private", "web_search", { query: "private context" }).allowed, false);
  assert.equal(policy.authorize("qq:owner", "private", "send_message", { text: "hi" }).allowed, true);
  assert.equal(
    policy.authorize("qq:owner", "private", "send_message", { chatKey: "telegram:third-party", text: "hi" }).allowed,
    false,
  );
});

test("cron is public-data-only and cannot bypass its tool allowlist", () => {
  const policy = new ToolPolicy();
  assert.deepEqual(
    policy.toolsForMode([{ name: "web_search" }, { name: "send_message" }, { name: "read_file" }, { name: "shell" }], "cron"),
    [{ name: "web_search" }, { name: "send_message" }],
  );
  assert.equal(policy.authorize("qq:target", "cron", "web_search", { query: "public news" }).allowed, true);
  const result = policy.authorize("cron:1", "cron", "write_file", { path: "x", content: "y" });
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /disabled in public cron mode/);
});

test("a newer intent or reset invalidates pending codes and generation-bound grants", () => {
  const policy = new ToolPolicy();
  const args = { command: "danger" };

  const first = policy.authorize("qq:owner", "private", "shell", args, "1");
  const firstToken = /\/confirm ([A-F0-9]{8})/.exec(first.reason ?? "")![1];
  policy.invalidate("qq:owner");
  assert.equal(policy.canConfirm("qq:owner", firstToken), false, "pending code was revoked");

  const second = policy.authorize("qq:owner", "private", "shell", args, "2");
  const secondToken = /\/confirm ([A-F0-9]{8})/.exec(second.reason ?? "")![1];
  policy.invalidate("qq:owner", secondToken);
  assert.ok(policy.confirm("qq:owner", secondToken, "3"));
  policy.invalidate("qq:owner");
  assert.equal(policy.authorize("qq:owner", "private", "shell", args, "4").allowed, false, "grant was revoked");
});

test("pending confirmations really expire", () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const policy = new ToolPolicy();
    const denied = policy.authorize("qq:owner", "private", "shell", { command: "danger" }, "1");
    const token = /\/confirm ([A-F0-9]{8})/.exec(denied.reason ?? "")![1];
    now += 10 * 60_000 + 1;
    assert.equal(policy.canConfirm("qq:owner", token), false);
  } finally {
    Date.now = originalNow;
  }
});
