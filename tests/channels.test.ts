/**
 * Channel unit tests — no real network. QQ inbound dispatch is exercised with
 * synthetic gateway payloads; chunking and dedup helpers directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkText, DedupSet } from "../src/channels/base.ts";
import { QQChannel } from "../src/channels/qq.ts";
import { TelegramChannel } from "../src/channels/telegram.ts";
import type { InboundEvent } from "../src/core/types.ts";

test("chunkText splits at boundaries", { timeout: 5000 }, () => {
  assert.deepEqual(chunkText("short", 100), ["short"]);
  const long = "a".repeat(50) + "\n" + "b".repeat(50) + "\n" + "c".repeat(50);
  const chunks = chunkText(long, 80);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.length <= 80));
  assert.equal(chunks.join(""), long.replace(/\n/g, "").length === long.length ? long : chunks.join(""));
});

test("DedupSet evicts oldest", { timeout: 5000 }, () => {
  const d = new DedupSet(3);
  d.add("a"); d.add("b"); d.add("c");
  assert.ok(d.has("a"));
  d.add("a"); // no dup effect
  d.add("d"); // evicts a
  assert.ok(!d.has("a"));
  assert.ok(d.has("d"));
});

function makeQQ(onMessage: (e: InboundEvent) => void): QQChannel {
  // redirect the durable chatTypes file — tests must not touch real state
  const tmp = join(mkdtempSync(join(tmpdir(), "ani-qq-")), "types.json");
  return new QQChannel({ enabled: false, appId: "x", clientSecret: "y", owners: [] }, onMessage, { typesFile: tmp });
}

test("QQ C2C dispatch produces an InboundEvent", { timeout: 10_000 }, async () => {
  const events: InboundEvent[] = [];
  const qq = makeQQ((e) => events.push(e));
  (qq as any).onPayload({
    op: 0,
    t: "C2C_MESSAGE_CREATE",
    s: 1,
    d: { id: "msg1", content: "  hello ani  ", author: { user_openid: "USER1" } },
  });
  // dispatch is async
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, "qq");
  assert.equal(events[0].chatId, "USER1");
  assert.equal(events[0].text, "hello ani");
  assert.equal(events[0].isGroup, false);

  // duplicate msg id is dropped
  (qq as any).onPayload({ op: 0, t: "C2C_MESSAGE_CREATE", s: 2, d: { id: "msg1", content: "hello ani", author: { user_openid: "USER1" } } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(events.length, 1);

  // lastMsgId recorded for passive replies
  assert.equal((qq as any).lastMsgId.get("USER1"), "msg1");
  assert.equal((qq as any).chatTypes.get("USER1"), "c2c");
});

test("QQ group @-message maps to group chat", { timeout: 10_000 }, async () => {
  const events: InboundEvent[] = [];
  const qq = makeQQ((e) => events.push(e));
  (qq as any).onPayload({
    op: 0,
    t: "GROUP_AT_MESSAGE_CREATE",
    s: 5,
    d: { id: "g1", content: "@ani_bot /hi there", group_openid: "GROUP9", author: { member_openid: "MEMBER1" } },
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(events.length, 1);
  assert.equal(events[0].text, "/hi there", "bot mention stripped from group content");
  assert.equal(events[0].chatId, "GROUP9");
  assert.equal(events[0].userId, "MEMBER1");
  assert.equal(events[0].isGroup, true);
  assert.equal((qq as any).chatTypes.get("GROUP9"), "group");
});

test("QQ READY stores session id; hello triggers identify path", { timeout: 10_000 }, async () => {
  const qq = makeQQ(() => {});
  (qq as any).onPayload({ op: 0, t: "READY", s: 1, d: { session_id: "sess-123" } });
  assert.equal((qq as any).sessionId, "sess-123");

  // hello → heartbeat timer set (no ws connected, send is a no-op)
  (qq as any).ensureToken = async () => "tok";
  (qq as any).onPayload({ op: 10, d: { heartbeat_interval: 30000 } });
  assert.ok((qq as any).heartbeatTimer);
  clearInterval((qq as any).heartbeatTimer);

  // seq tracking
  (qq as any).onPayload({ op: 0, t: "UNKNOWN_EVENT", s: 42, d: {} });
  assert.equal((qq as any).lastSeq, 42);
});

test("QQ sendText posts chunked messages with msg_id", { timeout: 10_000 }, async () => {
  const qq = makeQQ(() => {});
  const posted: { path: string; body: any }[] = [];
  (qq as any).api = async (method: string, path: string, body: any) => {
    posted.push({ path, body });
    return {};
  };
  (qq as any).chatTypes.set("U1", "c2c");
  (qq as any).lastMsgId.set("U1", "m-1");
  await qq.sendText("U1", "x".repeat(4000)); // > MAX_MSG → 2 chunks
  assert.equal(posted.length, 2);
  assert.equal(posted[0].path, "/v2/users/U1/messages");
  assert.equal(posted[0].body.msg_id, "m-1");
  assert.equal(posted[0].body.msg_seq, 1);
  assert.equal(posted[1].body.msg_seq, 2);
  assert.equal(posted[0].body.msg_type, 0);

  // group path
  (qq as any).chatTypes.set("G1", "group");
  await qq.sendText("G1", "hi group");
  assert.equal(posted[2].path, "/v2/groups/G1/messages");
});

// ---------------------------------------------------------------- markdown

function makeTG(owners: string[] = []): InstanceType<typeof TelegramChannel> {
  return new TelegramChannel({ enabled: false, token: "x", owners }, () => {});
}

test("TG sendText renders markdown as HTML by default", { timeout: 10_000 }, async () => {
  const tg = makeTG();
  const sent: any[] = [];
  (tg as any).api = async (_m: string, body: any) => { sent.push(body); return {}; };
  await tg.sendText("c1", "**bold** and `code`");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].parse_mode, "HTML");
  assert.ok(sent[0].text.includes("<b>bold</b>"), sent[0].text);
  assert.ok(sent[0].text.includes("<code>code</code>"), sent[0].text);
});

test("TG sendText falls back to plain text when HTML is rejected", { timeout: 10_000 }, async () => {
  const tg = makeTG();
  const sent: any[] = [];
  (tg as any).api = async (_m: string, body: any) => {
    if (body.parse_mode) throw new Error("Telegram sendMessage: Bad Request: can't parse entities");
    sent.push(body);
    return {};
  };
  await tg.sendText("c1", "**bold**");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].parse_mode, undefined);
  assert.equal(sent[0].text, "**bold**");
});

test("TG sendText with markdown:false sends plain directly", { timeout: 10_000 }, async () => {
  const tg = new TelegramChannel({ enabled: false, token: "x", owners: [], markdown: false }, () => {});
  const sent: any[] = [];
  (tg as any).api = async (_m: string, body: any) => { sent.push(body); return {}; };
  await tg.sendText("c1", "**bold**");
  assert.equal(sent[0].parse_mode, undefined);
});

test("TG catch-up: stale downtime messages notify owners and get skipped", { timeout: 10_000 }, async () => {
  const tg = makeTG(["owner1"]);
  const now = Math.floor(Date.now() / 1000);
  const notices: string[] = [];
  (tg as any).offset = 100;
  (tg as any).saveOffset = () => {}; // never touch real state
  (tg as any).api = async (method: string) => {
    if (method !== "getUpdates") throw new Error("unexpected " + method);
    return [
      { update_id: 100, message: { message_id: 1, date: now - 3600, from: { id: "owner1" }, chat: { id: 55, type: "private" }, text: "old" } },
      { update_id: 101, message: { message_id: 2, date: now - 3600, from: { id: "stranger" }, chat: { id: 66, type: "private" }, text: "spam" } },
      { update_id: 102, message: { message_id: 3, date: now - 5, from: { id: "owner1" }, chat: { id: 55, type: "private" }, text: "fresh" } },
    ];
  };
  (tg as any).sendText = async (cid: string, text: string) => { notices.push(`${cid}:${text}`); };
  await (tg as any).catchUpMissed();
  // owner chat 55 notified once (stranger chat never), offset skips ONLY stale
  assert.equal(notices.length, 1);
  assert.ok(notices[0].startsWith("55:"), notices[0]);
  assert.ok(notices[0].includes("1 条"), notices[0]);
  assert.equal((tg as any).offset, 102); // 102 (fresh) stays for the poll loop
});

test("QQ markdown: opt-in sends msg_type 3, failure falls back to text", { timeout: 10_000 }, async () => {
  const tmp = join(mkdtempSync(join(tmpdir(), "ani-qq-")), "types.json");
  const qq = new QQChannel({ enabled: false, appId: "x", clientSecret: "y", owners: [], markdown: true }, () => {}, { typesFile: tmp });
  (qq as any).chatTypes.set("U1", "c2c");
  const posted: any[] = [];
  (qq as any).api = async (_m: string, _p: string, body: any) => { posted.push(body); return {}; };
  await qq.sendText("U1", "**hi**");
  assert.equal(posted[0].msg_type, 3);
  assert.equal(posted[0].markdown.content, "**hi**");

  // rejection → plain fallback for that chunk
  posted.length = 0;
  (qq as any).api = async (_m: string, _p: string, body: any) => {
    if (body.msg_type === 3) throw new Error("QQ: markdown not permitted");
    posted.push(body);
    return {};
  };
  await qq.sendText("U1", "**hi**");
  assert.equal(posted.length, 1);
  assert.equal(posted[0].msg_type, 0);
  assert.equal(posted[0].content, "**hi**");
});
