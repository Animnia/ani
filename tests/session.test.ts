/**
 * Session persistence + compaction boundary integrity.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/core/session.ts";
import type { Msg, StreamFn } from "../src/core/types.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ani-session-"));
}

test("append + reload roundtrip", { timeout: 5000 }, () => {
  const dir = tmp();
  try {
    const s1 = new SessionStore(dir);
    s1.append("cli:local", { role: "user", content: "hello", _meta: { ts: 1 } });
    s1.append("cli:local", { role: "assistant", content: "hi", _meta: { ts: 2 } });
    s1.append("qq:ABC", { role: "user", content: "other chat", _meta: { ts: 3 } });

    const s2 = new SessionStore(dir);
    const msgs = s2.get("cli:local");
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].content, "hello");
    assert.equal(s2.get("qq:ABC").length, 1);
    assert.equal(s2.get("nobody").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot restore replaces both cached and persisted transcript", { timeout: 5000 }, () => {
  const dir = tmp();
  try {
    const store = new SessionStore(dir);
    store.append("fake:boss", { role: "user", content: "committed", _meta: { ts: 1 } });
    const snapshot = store.snapshot("fake:boss");
    store.append("fake:boss", { role: "user", content: "cancelled", _meta: { ts: 2 } });
    store.restore("fake:boss", snapshot);

    assert.deepEqual(store.get("fake:boss").map((m) => m.content), ["committed"]);
    assert.deepEqual(new SessionStore(dir).get("fake:boss").map((m) => m.content), ["committed"]);
    assert.ok(!readdirSync(dir).some((f) => f.endsWith(".restore.tmp")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compaction summarizes and keeps tool chains intact", { timeout: 15_000 }, async () => {
  const dir = tmp();
  try {
    const store = new SessionStore(dir, 3000); // tiny budget to force compaction
    const key = "cli:test";
    // 20 turns, some with tool chains
    for (let i = 0; i < 20; i++) {
      store.append(key, { role: "user", content: `question ${i} ${"x".repeat(100)}`, _meta: { ts: i } });
      store.append(key, {
        role: "assistant",
        content: "",
        reasoning_content: "thinking " + i,
        tool_calls: [{ id: `c${i}`, type: "function", function: { name: "shell", arguments: `{"command":"echo ${i}"}` } }],
        _meta: { ts: i },
      });
      store.append(key, { role: "tool", tool_call_id: `c${i}`, content: `output ${i} ${"y".repeat(100)}`, _meta: { ts: i } });
      store.append(key, { role: "assistant", content: `answer ${i} ${"z".repeat(100)}`, _meta: { ts: i } });
    }

    const fakeSummarize: StreamFn = async ({ messages }) => {
      assert.equal(messages.length, 1);
      assert.match(messages[0].content, /Summarize/);
      return { content: "SUMMARY: user asked questions 0-13", reasoning: "", toolCalls: [], finishReason: "stop" };
    };

    await store.maybeCompact(key, fakeSummarize, "test-model");

    const msgs = store.get(key);
    // first message is the summary
    assert.match(msgs[0].content, /earlier conversation summary/);
    assert.match(msgs[0].content, /SUMMARY/);
    assert.ok(msgs.length < 80, "history shrank");

    // integrity: every assistant tool_calls must be followed by matching tool results,
    // and every tool message must have a preceding assistant with that tool_call id
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === "assistant" && m.tool_calls?.length) {
        const need = m.tool_calls.map((t) => t.id).sort();
        const got: string[] = [];
        let j = i + 1;
        while (j < msgs.length && msgs[j].role === "tool") {
          got.push(msgs[j].tool_call_id!);
          j++;
        }
        assert.deepEqual(got.sort(), need, `tool chain broken at msg ${i}`);
      }
      if (m.role === "tool") {
        const prevAssistant = msgs.slice(0, i).reverse().find((x) => x.role === "assistant");
        assert.ok(prevAssistant?.tool_calls?.some((t) => t.id === m.tool_call_id), `orphan tool message at ${i}`);
      }
    }

    // persistence: reload and verify the compacted file is valid JSONL
    const store2 = new SessionStore(dir, 3000);
    assert.match(store2.get(key)[0].content, /SUMMARY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compaction preserves the hard-isolation marker for public group history", async () => {
  const dir = tmp();
  try {
    const store = new SessionStore(dir, 300);
    for (let i = 0; i < 6; i++) {
      store.append("qq:group", {
        role: i % 2 ? "assistant" : "user",
        content: `${i}:${"public ".repeat(20)}`,
        _meta: { ts: i, groupSafe: true },
      });
    }
    const summarize: StreamFn = async () => ({ content: "PUBLIC SUMMARY", toolCalls: [], finishReason: "stop" });

    await store.maybeCompact("qq:group", summarize, "m");

    assert.equal(store.get("qq:group")[0]._meta?.groupSafe, true);
    assert.equal(new SessionStore(dir, 300).get("qq:group")[0]._meta?.groupSafe, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reset clears session", { timeout: 5000 }, () => {
  const dir = tmp();
  try {
    const s = new SessionStore(dir);
    s.append("a", { role: "user", content: "hi" });
    s.reset("a");
    assert.equal(s.get("a").length, 0);
    assert.equal(new SessionStore(dir).get("a").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reset with archive keeps the old transcript as .archive.jsonl", { timeout: 5000 }, () => {
  const dir = tmp();
  try {
    const s = new SessionStore(dir);
    s.append("cli:local", { role: "user", content: "old stuff", _meta: { ts: 1 } });
    s.reset("cli:local", { archive: true });
    assert.equal(s.get("cli:local").length, 0);
    const files = readdirSync(dir);
    assert.equal(files.filter((f) => f.endsWith(".archive.jsonl")).length, 1, files.join(","));
    assert.ok(files.includes("cli_local.jsonl"), files.join(",")); // fresh empty file
    // plain reset still truncates without archiving
    s.append("cli:local", { role: "user", content: "new", _meta: { ts: 2 } });
    s.reset("cli:local");
    assert.equal(readdirSync(dir).filter((f) => f.endsWith(".archive.jsonl")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cold reset with archive loads and preserves the on-disk transcript", { timeout: 5000 }, () => {
  const dir = tmp();
  try {
    const writer = new SessionStore(dir);
    writer.append("cli:local", { role: "user", content: "survive restart", _meta: { ts: 1 } });

    const fresh = new SessionStore(dir);
    fresh.reset("cli:local", { archive: true });

    assert.equal(fresh.get("cli:local").length, 0);
    const archives = readdirSync(dir).filter((f) => f.endsWith(".archive.jsonl"));
    assert.equal(archives.length, 1, readdirSync(dir).join(","));
    assert.match(readFileSync(join(dir, archives[0]), "utf8"), /survive restart/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archive failure cancels reset instead of truncating the transcript", { timeout: 5000 }, () => {
  const dir = tmp();
  const realNow = Date.now;
  try {
    const store = new SessionStore(dir);
    store.append("cli:local", { role: "user", content: "must not be lost", _meta: { ts: 1 } });
    Date.now = () => 123456;
    // A directory at the archive destination deterministically makes the
    // file rename fail on every supported platform.
    mkdirSync(join(dir, "cli_local.123456.archive.jsonl"));

    assert.throws(() => store.reset("cli:local", { archive: true }));
    assert.deepEqual(store.get("cli:local").map((m) => m.content), ["must not be lost"]);
    assert.match(readFileSync(join(dir, "cli_local.jsonl"), "utf8"), /must not be lost/);
  } finally {
    Date.now = realNow;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("size + compactions reflect session state", { timeout: 10_000 }, async () => {
  const dir = tmp();
  try {
    const s = new SessionStore(dir, 500); // tiny budget to force compaction
    assert.equal(s.size("a"), 0);
    assert.equal(s.compactions("a"), 0);
    for (let i = 0; i < 6; i++) {
      s.append("a", { role: "user", content: "x".repeat(120) + i, _meta: { ts: i } });
      s.append("a", { role: "assistant", content: "y".repeat(120), _meta: { ts: i } });
    }
    assert.ok(s.size("a") > 500);
    const summarizer: StreamFn = async () => ({ content: "SUMMARY", toolCalls: [], finishReason: "stop" });
    await s.maybeCompact("a", summarizer, "m");
    assert.ok(s.size("a") < 1500, `size after compact: ${s.size("a")}`);
    assert.equal(s.compactions("a"), 1);
    // survives reload (the marker is persisted in _meta)
    assert.equal(new SessionStore(dir, 500).compactions("a"), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
