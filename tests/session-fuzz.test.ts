/**
 * Property fuzz for session compaction: no matter how the history looks or
 * where the cut lands, the compacted history must never contain a dangling
 * tool chain (assistant with tool_calls not followed by all its tool results,
 * or tool results without their preceding assistant call). DeepSeek 400s on
 * those, so this invariant is load-bearing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/core/session.ts";
import type { Msg } from "../src/core/types.ts";
import type { StreamFn } from "../src/core/types.ts";

// deterministic PRNG so failures are reproducible
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const okSummary: StreamFn = async () => ({ content: "摘要： fuzz", reasoning: "", toolCalls: [], finishReason: "stop" });

function randomHistory(rand: () => number, len: number): Msg[] {
  const msgs: Msg[] = [];
  let i = 0;
  while (msgs.length < len) {
    const r = rand();
    if (r < 0.45) {
      msgs.push({ role: "user", content: `u${i++} ` + "x".repeat(Math.floor(rand() * 200)) });
    } else if (r < 0.7) {
      msgs.push({ role: "assistant", content: `a${i++} ` + "y".repeat(Math.floor(rand() * 300)) });
    } else {
      // a tool chain: assistant with 1-3 calls, each followed by its result
      const n = 1 + Math.floor(rand() * 3);
      const calls = Array.from({ length: n }, (_, k) => ({
        id: `c${i}_${k}`, type: "function" as const, function: { name: "shell", arguments: "{}" },
      }));
      msgs.push({ role: "assistant", content: "", reasoning: "think", tool_calls: calls });
      for (const c of calls) msgs.push({ role: "tool", tool_call_id: c.id, content: "result " + "z".repeat(Math.floor(rand() * 400)) });
      i++;
    }
  }
  return msgs;
}

function assertNoDangling(msgs: Msg[], ctx: string): void {
  for (let k = 0; k < msgs.length; k++) {
    const m = msgs[k];
    if (m.role === "assistant" && m.tool_calls?.length) {
      const need = new Set(m.tool_calls.map((c) => c.id));
      for (let j = k + 1; j < msgs.length && msgs[j].role === "tool"; j++) need.delete(msgs[j].tool_call_id!);
      assert.equal(need.size, 0, `${ctx}: assistant tool_calls at index ${k} dangling`);
    }
    if (m.role === "tool") {
      // must be preceded (walking back over tool msgs) by an assistant w/ the call
      let j = k - 1;
      while (j >= 0 && msgs[j].role === "tool") j--;
      const prev = msgs[j];
      assert.ok(
        prev?.role === "assistant" && prev.tool_calls?.some((c) => c.id === m.tool_call_id),
        `${ctx}: tool result at index ${k} has no matching call`,
      );
    }
  }
}

test("fuzz: compaction never dangles tool chains across 400 random histories", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ani-fuzz-"));
  try {
    const rand = mulberry32(20260810);
    for (let iter = 0; iter < 400; iter++) {
      const store = new SessionStore(join(dir, `s${iter}.jsonl`), 500 + Math.floor(rand() * 2000));
      const hist = randomHistory(rand, 3 + Math.floor(rand() * 30));
      for (const m of hist) store.append("c", m);
      await store.maybeCompact("c", okSummary, "m");
      assertNoDangling(store.get("c"), `iter ${iter} (history ${hist.length} msgs)`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
