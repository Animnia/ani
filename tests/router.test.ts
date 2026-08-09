/**
 * Router integration tests — the hub logic (pairing gate, per-chat queue,
 * abort-on-new-message, cron delivery) with a fake channel + fake model.
 * Pairing/config writes go to temp files; the real ani.json is untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../src/router.ts";
import type { Channel, InboundEvent, Msg, StreamFn, StreamResult } from "../src/core/types.ts";

class FakeChannel implements Channel {
  readonly name = "fake";
  owners: string[] = [];
  sent: { chatId: string; text: string }[] = [];
  sentFiles: { chatId: string; path: string }[] = [];
  async start() {}
  async stop() {}
  async sendText(chatId: string, text: string) {
    this.sent.push({ chatId, text });
  }
  async sendFile(chatId: string, filePath: string) {
    this.sentFiles.push({ chatId, path: filePath });
  }
  isOwner(userId: string) {
    return this.owners.includes(userId);
  }
  addOwner(userId: string) {
    if (!this.owners.includes(userId)) this.owners.push(userId);
  }
}

function tmpFiles() {
  const dir = mkdtempSync(join(tmpdir(), "ani-router-"));
  const pendingFile = join(dir, "pending.json");
  const configFile = join(dir, "ani.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      model: "m",
      deepseek: { apiKey: "sk-test", baseUrl: "https://x" },
      channels: { telegram: { enabled: false, owners: [] }, qq: { enabled: false, owners: [] } },
      mcpServers: {},
    }),
  );
  return { dir, pendingFile, configFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function makeRouter(streamFn: StreamFn, files: ReturnType<typeof tmpFiles>) {
  const router = new Router();
  await router.init({
    streamFn,
    skipChannels: true,
    pairOpts: { pendingFile: files.pendingFile, configFile: files.configFile },
  });
  const channel = new FakeChannel();
  router.registerChannel(channel);
  return { router, channel };
}

function evt(userId: string, text: string, chatId = userId): InboundEvent {
  return { channel: "fake", chatId, userId, text };
}

async function waitFor(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

test("pairing gate: stranger gets a code, approval grants access, then replies flow", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  try {
    const echo: StreamFn = async ({ messages }) => ({
      content: "REPLY: " + messages[messages.length - 1].content,
      reasoning: "",
      toolCalls: [],
      finishReason: "stop",
    });
    const { router, channel } = await makeRouter(echo, files);
    try {
      // stranger → pairing message with a code, no agent run
      await (router as any).handleInbound(evt("stranger", "hello"));
      await waitFor(() => channel.sent.length === 1, "pairing message sent");
      assert.match(channel.sent[0].text, /\/approve [A-Z0-9]{6}/);
      const code = /\/approve ([A-Z0-9]{6})/.exec(channel.sent[0].text)![1];

      // approve via router (writes temp config, not the real one)
      assert.match(router.approve(code), /approved fake:stranger/);
      assert.ok(channel.isOwner("stranger"), "channel now recognizes the owner");
      const cfgOnDisk = JSON.parse(readFileSync(files.configFile, "utf8"));
      assert.deepEqual(cfgOnDisk.channels.fake, undefined); // unknown channel key not written
      // approval greeting sent
      await waitFor(() => channel.sent.some((m) => m.text.includes("配对成功")), "greeting sent");

      // now a normal message gets an agent reply
      await (router as any).handleInbound(evt("stranger", "ping"));
      await waitFor(() => channel.sent.some((m) => m.text === "REPLY: ping"), "agent reply delivered");
    } finally {
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});

test("unknown users never trigger the agent", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  try {
    let calls = 0;
    const counting: StreamFn = async () => {
      calls++;
      return { content: "hi", reasoning: "", toolCalls: [], finishReason: "stop" } as StreamResult;
    };
    const { router, channel } = await makeRouter(counting, files);
    try {
      await (router as any).handleInbound(evt("intruder", "delete everything"));
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(calls, 0, "model never invoked for unauthorized user");
      assert.equal(channel.sent.length, 1, "only the pairing notice went out");
      assert.match(channel.sent[0].text, /配对|approve/);
    } finally {
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});

test("new message aborts the stale run; only the latest gets answered", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  try {
    let calls = 0;
    const slow: StreamFn = async ({ messages, signal }) => {
      calls++;
      const me = calls;
      // first call hangs until aborted; second answers fast
      if (me === 1) {
        await new Promise((_, rej) => {
          signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
          setTimeout(() => rej(new Error("should have been aborted")), 5000);
        });
      }
      return { content: "ANSWER-" + messages[messages.length - 1].content, reasoning: "", toolCalls: [], finishReason: "stop" };
    };
    const { router, channel } = await makeRouter(slow, files);
    channel.addOwner("boss");
    try {
      await (router as any).handleInbound(evt("boss", "first"));
      await new Promise((r) => setTimeout(r, 200)); // let run 1 start streaming
      await (router as any).handleInbound(evt("boss", "second")); // aborts run 1
      await waitFor(() => channel.sent.some((m) => m.text === "ANSWER-second"), "second answered");
      assert.ok(!channel.sent.some((m) => m.text === "ANSWER-first"), "stale run stayed silent");
    } finally {
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});

test("cron result is delivered to the target chat", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  try {
    const echo: StreamFn = async () => ({ content: "cron report body", reasoning: "", toolCalls: [], finishReason: "stop" });
    const { router, channel } = await makeRouter(echo, files);
    try {
      await (router as any).runCronTask({
        id: "t1",
        name: "morning",
        schedule: "@daily 08:00",
        prompt: "make the report",
        target: "fake:boss-chat",
        enabled: true,
      });
      assert.equal(channel.sent.length, 1);
      assert.equal(channel.sent[0].chatId, "boss-chat");
      assert.match(channel.sent[0].text, /⏰ morning/);
      assert.match(channel.sent[0].text, /cron report body/);
    } finally {
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});

test("messaging bridge: sendText/sendFile route through the right channel", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  try {
    const echo: StreamFn = async () => ({ content: "x", reasoning: "", toolCalls: [], finishReason: "stop" });
    const { router, channel } = await makeRouter(echo, files);
    try {
      await router.sendText("fake:c1", "direct hello");
      assert.deepEqual(channel.sent[0], { chatId: "c1", text: "direct hello" });
      await router.sendFile("fake:c1", "C:/x/report.pdf", "cap");
      assert.equal(channel.sentFiles[0].path, "C:/x/report.pdf");
      assert.ok(router.listChats().some((c) => c.chatKey === "fake:c1"), "chat remembered");
    } finally {
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});
