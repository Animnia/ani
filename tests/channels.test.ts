/**
 * Channel unit tests — no real network. QQ inbound dispatch is exercised with
 * synthetic gateway payloads; chunking and dedup helpers directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, DedupSet } from "../src/channels/base.ts";
import { QQChannel } from "../src/channels/qq.ts";
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
  return new QQChannel({ enabled: false, appId: "x", clientSecret: "y", owners: [] }, onMessage);
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
    d: { id: "g1", content: "/hi there", group_openid: "GROUP9", author: { member_openid: "MEMBER1" } },
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(events.length, 1);
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
