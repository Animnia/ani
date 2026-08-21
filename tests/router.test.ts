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
import { DEEPSEEK_VISION_MODEL, toWire } from "../src/core/deepseek.ts";
import type { Channel, InboundEvent, Msg, StreamFn, StreamResult, ToolDef } from "../src/core/types.ts";

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
      channels: {
        telegram: { enabled: false, owners: [] },
        qq: { enabled: false, owners: [] },
        fake: { enabled: true, owners: [] },
      },
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
    stateDir: files.dir, // never write sessions/chats into the real data dir
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
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
      assert.deepEqual(cfgOnDisk.channels.fake.owners, ["stranger"]);
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

test("synchronous messages are newest-wins before the first queued turn starts", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  try {
    const seen: string[] = [];
    const echo: StreamFn = async ({ messages }) => {
      const text = messages[messages.length - 1].content;
      seen.push(text);
      return { content: `ANSWER-${text}`, reasoning: "", toolCalls: [], finishReason: "stop" };
    };
    const { router, channel } = await makeRouter(echo, files);
    channel.addOwner("boss");
    try {
      // Both calls finish their synchronous inbound work before Queue's first
      // microtask runs. The first generation must be skipped entirely.
      const first = (router as any).handleInbound(evt("boss", "first"));
      const second = (router as any).handleInbound(evt("boss", "second"));
      await Promise.all([first, second]);
      await waitFor(() => channel.sent.some((m) => m.text === "ANSWER-second"), "newest reply");
      assert.deepEqual(seen, ["second"]);
      assert.deepEqual(channel.sent.map((m) => m.text), ["ANSWER-second"]);
    } finally {
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});

test("m1/m2/m3 burst drops queued m2 and stale m1 even when provider ignores abort", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  try {
    const seen: string[] = [];
    const stubborn: StreamFn = async ({ messages }) => {
      const text = messages[messages.length - 1].content;
      seen.push(text);
      if (text === "m1") {
        firstStarted.resolve();
        await releaseFirst.promise; // intentionally ignores AbortSignal
      }
      return { content: `ANSWER-${text}`, reasoning: "", toolCalls: [], finishReason: "stop" };
    };
    const { router, channel } = await makeRouter(stubborn, files);
    channel.addOwner("boss");
    try {
      await (router as any).handleInbound(evt("boss", "m1"));
      await firstStarted.promise;
      await (router as any).handleInbound(evt("boss", "m2"));
      await (router as any).handleInbound(evt("boss", "m3"));
      releaseFirst.resolve();

      await waitFor(() => channel.sent.some((m) => m.text === "ANSWER-m3"), "m3 reply");
      assert.deepEqual(seen, ["m1", "m3"], "queued m2 never reached the provider");
      assert.deepEqual(channel.sent.map((m) => m.text), ["ANSWER-m3"], "stale m1 stayed silent");
      const history = (router as any).sessions.get("fake:boss") as Msg[];
      assert.deepEqual(history.map((m) => [m.role, m.content]), [
        ["user", "m3"],
        ["assistant", "ANSWER-m3"],
      ], "stale m1 user and assistant messages were both rolled back");
      assert.doesNotMatch(
        readFileSync(join(files.dir, "sessions", "fake_boss.jsonl"), "utf8"),
        /m1|m2/,
        "rollback also reached the persisted transcript",
      );
    } finally {
      releaseFirst.resolve();
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});

test("/new is a queued barrier: old generation cannot write or deliver after reset", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  const oldStarted = deferred();
  const releaseOld = deferred();
  try {
    const stubborn: StreamFn = async ({ messages }) => {
      const text = messages[messages.length - 1].content;
      if (text === "old") {
        oldStarted.resolve();
        await releaseOld.promise; // intentionally ignores AbortSignal
      }
      return { content: `ANSWER-${text}`, reasoning: "", toolCalls: [], finishReason: "stop" };
    };
    const { router, channel } = await makeRouter(stubborn, files);
    channel.addOwner("boss");
    try {
      await (router as any).handleInbound(evt("boss", "old"));
      await oldStarted.promise;

      // Do not await /new: a real channel can receive the next event while the
      // cancelled provider is still unwinding.
      const reset = (router as any).handleInbound(evt("boss", "/new"));
      await (router as any).handleInbound(evt("boss", "after"));
      releaseOld.resolve();
      await reset;

      await waitFor(() => channel.sent.some((m) => m.text === "ANSWER-after"), "post-reset reply");
      assert.deepEqual(channel.sent.map((m) => m.text), [
        "新会话已开始（旧会话已归档）🌱",
        "ANSWER-after",
      ]);
      const history = (router as any).sessions.get("fake:boss") as Msg[];
      assert.deepEqual(
        history.map((m) => [m.role, m.content]),
        [["user", "after"], ["assistant", "ANSWER-after"]],
        "nothing from the old generation survived the reset",
      );
    } finally {
      releaseOld.resolve();
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});

test("CLI reset shares the actor and suppresses late deltas from a stubborn provider", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  const oldStarted = deferred();
  const releaseOld = deferred();
  try {
    const stubborn: StreamFn = async ({ messages, onTextDelta }) => {
      const text = messages[messages.length - 1].content;
      if (text === "old") {
        oldStarted.resolve();
        await releaseOld.promise; // intentionally ignores AbortSignal
      }
      onTextDelta?.(`DELTA-${text}`);
      return { content: `ANSWER-${text}`, reasoning: "", toolCalls: [], finishReason: "stop" };
    };
    const { router } = await makeRouter(stubborn, files);
    try {
      const deltas: string[] = [];
      const old = router.runCliTurn("old", (d) => deltas.push(d), () => {});
      await oldStarted.promise;
      const reset = router.resetSession("cli:local");
      const after = router.runCliTurn("after", (d) => deltas.push(d), () => {});
      releaseOld.resolve();

      assert.equal(await old, "");
      await reset;
      assert.equal(await after, "ANSWER-after");
      assert.deepEqual(deltas, ["DELTA-after"]);
      const history = (router as any).sessions.get("cli:local") as Msg[];
      assert.deepEqual(history.map((m) => [m.role, m.content]), [
        ["user", "after"],
        ["assistant", "ANSWER-after"],
      ]);
    } finally {
      releaseOld.resolve();
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});

test("pairing never leaks into group chats", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  try {
    let calls = 0;
    const counting: StreamFn = async () => {
      calls++;
      return { content: "hi", reasoning: "", toolCalls: [], finishReason: "stop" };
    };
    const { router, channel } = await makeRouter(counting, files);
    try {
      // stranger @-mentions the bot in a group
      await (router as any).handleInbound({ channel: "fake", chatId: "GROUP1", userId: "rando", text: "@ani hi", isGroup: true });
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(channel.sent.length, 0, "no pairing reply in groups");
      assert.equal(calls, 0, "model not invoked");
    } finally {
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});

test("group chats receive no private prompt data or private tools", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  try {
    let systemPrompt = "";
    let toolNames: string[] = [];
    let calls = 0;
    const probe: StreamFn = async ({ messages, tools }) => {
      calls++;
      systemPrompt = messages[0].content;
      toolNames = tools.map((tool) => tool.function.name);
      return { content: "public answer", reasoning: "", toolCalls: [], finishReason: "stop" };
    };
    const { router, channel } = await makeRouter(probe, files);
    channel.addOwner("boss");
    try {
      (router as any).sessions.append("fake:group-1", {
        role: "assistant",
        content: "LEGACY_PRIVATE_SECRET",
        _meta: { ts: 1 },
      });
      await (router as any).handleInbound({
        channel: "fake",
        chatId: "group-1",
        userId: "boss",
        userName: "Boss",
        text: "hello group",
        isGroup: true,
      });
      await waitFor(() => channel.sent.some((message) => message.text === "public answer"), "group answer");
      assert.deepEqual(toolNames, ["web_search"]);
      assert.doesNotMatch(systemPrompt, /<owner_profile|<long_term_memory|<available_skills|Project dir/i);
      assert.match(systemPrompt, /public group conversation/i);
      const safeHistory = (router as any).sessions.get("fake:group-1") as Msg[];
      assert.ok(!safeHistory.some((message) => message.content.includes("LEGACY_PRIVATE_SECRET")));

      await (router as any).handleInbound({
        channel: "fake",
        chatId: "group-1",
        userId: "boss",
        text: "/show persona",
        isGroup: true,
      });
      await waitFor(() => channel.sent.some((message) => message.text.includes("群聊中已禁用 /show")), "group show denied");
      assert.equal(calls, 1, "private command never reached the model");
    } finally {
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});

test("group failures return a fixed public error without leaking exception details", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  try {
    const fail: StreamFn = async () => {
      throw new Error("PRIVATE_TOKEN at C:\\Users\\owner\\secret.txt");
    };
    const { router, channel } = await makeRouter(fail, files);
    channel.addOwner("boss");
    try {
      await (router as any).handleInbound({
        channel: "fake",
        chatId: "public-room",
        userId: "boss",
        text: "trigger error",
        isGroup: true,
      });
      await waitFor(() => channel.sent.length > 0, "fixed public error");
      assert.equal(channel.sent.at(-1)?.text, "处理这条群聊消息时发生错误，请稍后重试，或在私聊中继续。");
      assert.doesNotMatch(channel.sent.map((message) => message.text).join("\n"), /PRIVATE_TOKEN|Users|secret\.txt/);
    } finally {
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});

test("privileged tool calls require an exact /confirm before execution", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  try {
    let executed = 0;
    const dangerous: ToolDef = {
      name: "dangerous_test_tool",
      description: "test-only privileged action",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      async execute(args) {
        executed++;
        return `executed:${args.value}`;
      },
    };
    const model: StreamFn = async ({ messages }) => {
      const last = messages[messages.length - 1];
      if (last.role === "tool") {
        if (last.content.startsWith("Error:")) {
          const token = /\/confirm ([A-F0-9]{8})/.exec(last.content)?.[1];
          return { content: `请发送 /confirm ${token}`, reasoning: "", toolCalls: [], finishReason: "stop" };
        }
        return { content: "dangerous action completed", reasoning: "", toolCalls: [], finishReason: "stop" };
      }
      return {
        content: "",
        reasoning: "",
        toolCalls: [{
          id: "danger-1",
          type: "function",
          function: { name: dangerous.name, arguments: '{"value":"same"}' },
        }],
        finishReason: "tool_calls",
      };
    };
    const { router, channel } = await makeRouter(model, files);
    (router as any).tools.push(dangerous);
    channel.addOwner("boss");
    try {
      await (router as any).handleInbound(evt("boss", "do it"));
      await waitFor(() => channel.sent.some((message) => /\/confirm [A-F0-9]{8}/.test(message.text)), "confirmation request");
      assert.equal(executed, 0);
      const confirmationText = channel.sent.at(-1)!.text;
      assert.match(confirmationText, /ANI 代码级安全确认/);
      assert.match(confirmationText, /参数：\{"value":"same"\}/);
      assert.match(confirmationText, /校验：sha256:[a-f0-9]{16}/);
      const token = /\/confirm ([A-F0-9]{8})/.exec(confirmationText)![1];

      await (router as any).handleInbound(evt("boss", `/confirm ${token}`));
      await waitFor(() => channel.sent.some((message) => message.text === "dangerous action completed"), "confirmed execution");
      assert.equal(executed, 1);
    } finally {
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});

test("a cancelled confirmation generation cannot be replayed by the next turn", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  try {
    let executed = 0;
    const dangerous: ToolDef = {
      name: "dangerous_cancel_test",
      description: "test-only privileged action",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      async execute() {
        executed++;
        return "executed";
      },
    };
    const model: StreamFn = async ({ messages }) => {
      const last = messages.at(-1)!;
      if (last.role === "tool") {
        const token = /\/confirm ([A-F0-9]{8})/.exec(last.content)?.[1];
        return { content: token ? `需要确认 ${token}` : "done", toolCalls: [], finishReason: "stop" };
      }
      return {
        content: "",
        toolCalls: [{
          id: `danger-${messages.length}`,
          type: "function",
          function: { name: dangerous.name, arguments: '{"command":"fixed-danger"}' },
        }],
        finishReason: "tool_calls",
      };
    };
    const { router, channel } = await makeRouter(model, files);
    (router as any).tools.push(dangerous);
    channel.addOwner("boss");
    try {
      await (router as any).handleInbound(evt("boss", "prepare"));
      await waitFor(() => channel.sent.some((message) => /\/confirm [A-F0-9]{8}/.test(message.text)), "first code");
      const firstText = channel.sent.at(-1)!.text;
      const token = /\/confirm ([A-F0-9]{8})/.exec(firstText)![1];
      const baseline = channel.sent.length;

      // Same synchronous burst: the newer intent invalidates the grant before
      // the queued confirmation turn can start.
      const confirming = (router as any).handleInbound(evt("boss", `/confirm ${token}`));
      const cancelling = (router as any).handleInbound(evt("boss", "取消"));
      await Promise.all([confirming, cancelling]);
      await waitFor(() => channel.sent.length > baseline, "cancel turn completed");

      assert.equal(executed, 0);
      const nextRequest = channel.sent.slice(baseline).find((message) => /\/confirm [A-F0-9]{8}/.test(message.text));
      assert.ok(nextRequest);
      const nextToken = /\/confirm ([A-F0-9]{8})/.exec(nextRequest!.text)![1];

      await (router as any).handleInbound(evt("boss", "/new"));
      await waitFor(() => channel.sent.some((message) => message.text.includes("新会话已开始")), "reset completed");
      const afterReset = channel.sent.length;
      await (router as any).handleInbound(evt("boss", `/confirm ${nextToken}`));
      await waitFor(() => channel.sent.length > afterReset, "old code rejected after reset");
      assert.match(channel.sent.at(-1)!.text, /确认码无效/);
      assert.equal(executed, 0);
    } finally {
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});

test("CLI /confirm retries the exact frozen call in the confirmation turn", async () => {
  const files = tmpFiles();
  try {
    let executed = 0;
    const dangerous: ToolDef = {
      name: "dangerous_cli_test",
      description: "test-only privileged action",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      async execute() {
        executed++;
        return "executed";
      },
    };
    const model: StreamFn = async ({ messages }) => {
      const last = messages.at(-1)!;
      if (last.role === "tool") {
        return { content: last.content.startsWith("Error:") ? "model explanation is not trusted" : "CLI done", toolCalls: [], finishReason: "stop" };
      }
      return {
        content: "",
        toolCalls: [{ id: `cli-${messages.length}`, type: "function", function: { name: dangerous.name, arguments: '{"value":"exact"}' } }],
        finishReason: "tool_calls",
      };
    };
    const { router } = await makeRouter(model, files);
    (router as any).tools.push(dangerous);
    try {
      const first = await router.runCliTurn("do it", () => {}, () => {});
      assert.doesNotMatch(first, /model explanation is not trusted/);
      const token = /\/confirm ([A-F0-9]{8})/.exec(first)![1];
      const second = await router.runCliTurn(`/confirm ${token}`, () => {}, () => {});
      assert.equal(second, "CLI done");
      assert.equal(executed, 1);
    } finally {
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});

test("vision model receives a QQ/Telegram local image as a multimodal user message", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  const imagePath = join(files.dir, "qq-photo.bin");
  // PNG signature; detection deliberately ignores the misleading .bin suffix.
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  try {
    let userMessage: Msg | undefined;
    const capture: StreamFn = async ({ messages }) => {
      userMessage = messages.findLast((message) => message.role === "user");
      return { content: "我看到了图片", reasoning: "", toolCalls: [], finishReason: "stop" };
    };
    const { router, channel } = await makeRouter(capture, files);
    (router as any).cfg.model = DEEPSEEK_VISION_MODEL;
    channel.addOwner("boss");
    try {
      await (router as any).handleInbound({
        channel: "fake",
        chatId: "boss",
        userId: "boss",
        text: "图里有什么？",
        files: [{ path: imagePath, name: "photo.jpg", size: 11 }],
      });
      await waitFor(() => channel.sent.some((message) => message.text === "我看到了图片"), "vision reply");
      assert.deepEqual(userMessage?.images, [{ path: imagePath, detail: "auto" }]);
      const wire = toWire(userMessage!, DEEPSEEK_VISION_MODEL);
      assert.ok(Array.isArray(wire.content));
      assert.match((wire.content as any[])[1].image_url.url, /^data:image\/png;base64,/);
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

test("cron uses public prompt and tools for group and legacy-unknown targets", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  // Simulate chats.json written by an older ani version, before visibility
  // was persisted. Unknown must never default to private capabilities.
  writeFileSync(join(files.dir, "chats.json"), JSON.stringify([
    { chatKey: "fake:legacy-room", channel: "fake", chatId: "legacy-room", hint: "legacy" },
  ]));
  try {
    const calls: { system: string; tools: string[]; transcript: string }[] = [];
    const capture: StreamFn = async ({ messages, tools }) => {
      calls.push({
        system: messages[0]?.content ?? "",
        tools: tools.map((tool) => tool.function.name),
        transcript: messages.map((message) => message.content).join("\n"),
      });
      return { content: "public report", reasoning: "", toolCalls: [], finishReason: "stop" };
    };
    const { router, channel } = await makeRouter(capture, files);
    channel.addOwner("boss");
    try {
      await (router as any).handleInbound({
        channel: "fake",
        chatId: "group-room",
        userId: "boss",
        text: "register group",
        isGroup: true,
      });
      await waitFor(() => channel.sent.some((message) => message.text === "public report"), "group registration turn");
      const persisted = JSON.parse(readFileSync(join(files.dir, "chats.json"), "utf8"));
      assert.equal(persisted.find((entry: any) => entry.chatKey === "fake:group-room")?.isGroup, true);

      (router as any).sessions.append("cron:group-task", {
        role: "assistant",
        content: "LEGACY_PRIVATE_CRON_SECRET",
        _meta: { ts: 1 },
      });
      await (router as any).runCronTask({
        id: "group-task",
        name: "group report",
        schedule: "@daily 08:00",
        prompt: "public facts only",
        target: "fake:group-room",
        enabled: true,
      });
      await (router as any).runCronTask({
        id: "legacy-task",
        name: "legacy report",
        schedule: "@daily 08:00",
        prompt: "public facts only",
        target: "fake:legacy-room",
        enabled: true,
      });

      for (const call of calls.slice(-2)) {
        assert.match(call.system, /unattended scheduled task/i);
        assert.doesNotMatch(call.system, /<owner_profile|<long_term_memory|<available_skills|Project dir/i);
        assert.ok(call.tools.includes("web_search"));
        assert.ok(
          call.tools.every((name) => name === "web_search" || name === "send_message"),
          `unexpected cron capability: ${call.tools.join(", ")}`,
        );
        assert.doesNotMatch(call.transcript, /LEGACY_PRIVATE_CRON_SECRET/);
      }
      const publicCronHistory = (router as any).sessions.get("cron:group-task") as Msg[];
      assert.ok(publicCronHistory.every((message) => message._meta?.groupSafe === true));
    } finally {
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});

test("cron agent's send_message defaults to the delivery target", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  try {
    // model calls send_message (no chatKey) on round 1, then finishes
    const toolCalling: StreamFn = async ({ messages }) => {
      const last = messages[messages.length - 1];
      if (last.role === "tool") {
        assert.equal(last.content, "Sent to fake:boss-chat", "tool resolved the cron target as default chatKey");
        return { content: "report done", reasoning: "", toolCalls: [], finishReason: "stop" };
      }
      return {
        content: "",
        reasoning: "",
        toolCalls: [{ id: "s1", type: "function", function: { name: "send_message", arguments: '{"text":"file ready"}' } }],
        finishReason: "tool_calls",
      };
    };
    const { router, channel } = await makeRouter(toolCalling, files);
    (router as any).rememberChat("fake:boss-chat", "fake", "boss-chat", "Boss", false);
    try {
      await (router as any).runCronTask({
        id: "t2",
        name: "report",
        schedule: "@daily 08:00",
        prompt: "make and send the report",
        target: "fake:boss-chat",
        enabled: true,
      });
      const texts = channel.sent.map((m) => `${m.chatId}: ${m.text}`);
      assert.ok(texts.some((t) => t === "boss-chat: file ready"), "send_message landed on the target");
      assert.ok(texts.some((t) => t.includes("⏰ report") && t.includes("report done")), "cron summary delivered too");
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

test("session status: usage ledger aggregates provider tokens across calls", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  try {
    const echo: StreamFn = async ({ messages }) => ({
      content: "ok: " + messages[messages.length - 1].content.slice(0, 10),
      toolCalls: [],
      finishReason: "stop",
      usage: { prompt_tokens: 100, completion_tokens: 7 },
    });
    const { router } = await makeRouter(echo, files);
    await router.runCliTurn("first", () => {}, () => {});
    await router.runCliTurn("second", () => {}, () => {});
    const s = router.sessionStatus("cli:local");
    assert.equal(s.messages, 4); // 2 user + 2 assistant
    assert.ok(s.chars > 0 && s.chars < s.maxChars);
    assert.deepEqual(s.usage, { prompt: 200, completion: 14, calls: 2 });
    assert.equal(s.compactions, 0);
    // /new archives + clears; usage ledger intentionally persists (process-scoped)
    await router.resetSession("cli:local");
    assert.equal(router.sessionStatus("cli:local").messages, 0);
  } finally {
    files.cleanup();
  }
});

test("in-channel slash commands: known commands intercepted, unknown pass to agent", { timeout: 30_000 }, async () => {
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
      channel.owners.push("u1");

      // /status → stats reply, agent NOT involved
      await (router as any).handleInbound(evt("u1", "/status"));
      await waitFor(() => channel.sent.some((m) => m.text.includes("会话 fake:u1")), "status reply");
      assert.ok(channel.sent[0].text.includes("消息 0 条"), channel.sent[0].text);

      // a normal message → agent reply (establishes history)
      await (router as any).handleInbound(evt("u1", "hello world"));
      await waitFor(() => channel.sent.some((m) => m.text === "REPLY: hello world"), "agent reply");

      // /new → confirmation, session cleared
      await (router as any).handleInbound(evt("u1", "/new"));
      await waitFor(() => channel.sent.some((m) => m.text.includes("新会话已开始")), "new reply");
      assert.equal(router.sessionStatus("fake:u1").messages, 0);

      // unknown slash text → flows to the agent untouched (linux paths!)
      await (router as any).handleInbound(evt("u1", "/etc/passwd 是什么"));
      await waitFor(() => channel.sent.some((m) => m.text.includes("REPLY: /etc/passwd")), "passthrough");

      // /help lists channel commands
      await (router as any).handleInbound(evt("u1", "/help"));
      await waitFor(
        () => channel.sent.some((m) => m.text.includes("/new") && m.text.includes("/status")),
        "help reply",
      );
    } finally {
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});

test("runCliTurn streams reasoning deltas to the CLI callback", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  try {
    const thinker: StreamFn = async ({ onReasoningDelta, onTextDelta }) => {
      onReasoningDelta?.("我在想");
      onReasoningDelta?.("…");
      onTextDelta?.("答案");
      return { content: "答案", reasoning: "我在想…", toolCalls: [], finishReason: "stop" };
    };
    const { router } = await makeRouter(thinker, files);
    try {
      let reasoning = "";
      let text = "";
      await router.runCliTurn("q", (d) => (text += d), () => {}, undefined, (d) => (reasoning += d));
      assert.equal(reasoning, "我在想…");
      assert.equal(text, "答案");
    } finally {
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});

test("in-channel /skills and /show commands", { timeout: 30_000 }, async () => {
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
      channel.owners.push("u1");
      await (router as any).handleInbound(evt("u1", "/skills"));
      await waitFor(() => channel.sent.some((m) => m.text.includes("daily-briefing")), "skills list");
      await (router as any).handleInbound(evt("u1", "/skills off daily-briefing"));
      await waitFor(() => channel.sent.some((m) => m.text.includes("已禁用")), "disable ack");
      await (router as any).handleInbound(evt("u1", "/skills on daily-briefing"));
      await waitFor(() => channel.sent.some((m) => m.text.includes("已启用")), "enable ack");
      await (router as any).handleInbound(evt("u1", "/show"));
      await waitFor(() => channel.sent.some((m) => m.text.includes("memory") && m.text.includes("persona")), "show usage");
      await (router as any).handleInbound(evt("u1", "/show persona"));
      await waitFor(() => channel.sent.some((m) => m.text.includes("人设 →")), "persona content");
    } finally {
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});

test("maxTokens from config reaches the stream function", { timeout: 30_000 }, async () => {
  const files = tmpFiles();
  try {
    let seen: number | undefined;
    const probe: StreamFn = async (params) => {
      seen = params.maxTokens;
      return { content: "ok", reasoning: "", toolCalls: [], finishReason: "stop" };
    };
    const { router } = await makeRouter(probe, files);
    try {
      await router.runCliTurn("hi", () => {}, () => {});
      // default 8192 unless ani.json overrides — compare against live config
      const { getConfig } = await import("../src/core/config.ts");
      assert.equal(seen, getConfig().maxTokens);
    } finally {
      await router.shutdown();
    }
  } finally {
    files.cleanup();
  }
});
