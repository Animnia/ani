/**
 * Per-chat sessions, persisted as JSONL. Compaction pi-style: when the
 * conversation grows past the budget, older turns are summarized by the LLM
 * and replaced with one summary message. Cuts happen only at user-message
 * boundaries so tool_call chains never dangle (DeepSeek rejects those).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Msg, StreamFn } from "./types.ts";
import { log, warn } from "./log.ts";

export class SessionStore {
  private dir: string;
  private maxChars: number;
  private sessions = new Map<string, Msg[]>();
  private compacting = new Set<string>();

  constructor(dir: string, maxChars = 600_000) {
    this.dir = dir;
    this.maxChars = maxChars;
    mkdirSync(dir, { recursive: true });
  }

  private fileFor(chatKey: string): string {
    return join(this.dir, chatKey.replace(/[^A-Za-z0-9_.-]/g, "_") + ".jsonl");
  }

  get(chatKey: string): Msg[] {
    let s = this.sessions.get(chatKey);
    if (s) return s;
    s = [];
    const f = this.fileFor(chatKey);
    if (existsSync(f)) {
      try {
        for (const line of readFileSync(f, "utf8").split("\n")) {
          if (!line.trim()) continue;
          const m = JSON.parse(line) as Msg;
          if (m.role && typeof m.content === "string") s.push(m);
        }
      } catch (e) {
        warn("session", `corrupt session ${f}, starting fresh:`, e);
        s = [];
      }
    }
    this.sessions.set(chatKey, s);
    return s;
  }

  append(chatKey: string, msg: Msg): void {
    this.get(chatKey).push(msg);
    try {
      appendFileSync(this.fileFor(chatKey), JSON.stringify(msg) + "\n");
    } catch (e) {
      warn("session", "append failed:", e);
    }
  }

  /** Immutable turn snapshot used by the router's per-chat transaction. */
  snapshot(chatKey: string): Msg[] {
    return structuredClone(this.get(chatKey));
  }

  /** Atomically replace a transcript with a previously captured snapshot. */
  restore(chatKey: string, messages: Msg[]): void {
    const next = structuredClone(messages);
    const f = this.fileFor(chatKey);
    const tmp = f + ".restore.tmp";
    try {
      writeFileSync(tmp, next.length ? next.map((m) => JSON.stringify(m)).join("\n") + "\n" : "");
      renameSync(tmp, f);
      this.sessions.set(chatKey, next);
    } catch (e) {
      // Keep this process safe even if persistence failed; the next turn must
      // not inherit a cancelled instruction from the in-memory transcript.
      this.sessions.set(chatKey, next);
      warn("session", `restore failed for ${f}:`, e);
      throw e;
    }
  }

  reset(chatKey: string, opts?: { archive?: boolean }): void {
    const f = this.fileFor(chatKey);
    // Load before deciding whether there is anything to archive. A freshly
    // constructed store has an empty cache even when a transcript exists.
    const messages = this.get(chatKey);
    // /new archives instead of wiping: the transcript is often the only
    // record of what was decided — keep it as <key>.<ts>.archive.jsonl
    if (opts?.archive && existsSync(f) && messages.length > 0) {
      try {
        renameSync(f, f.replace(/\.jsonl$/, `.${Date.now()}.archive.jsonl`));
      } catch (e) {
        // Archiving is the safety contract of /new. Never turn an archive
        // failure into a destructive truncate: keep both memory and disk on
        // the old transcript and let the caller report/retry the reset.
        warn("session", `archive failed for ${f}; reset cancelled:`, e);
        throw e;
      }
    }
    this.sessions.set(chatKey, []);
    try {
      writeFileSync(f, "");
    } catch {
      /* ignore */
    }
  }

  /** Current context size in chars (what compaction budgets against). */
  size(chatKey: string): number {
    return this.sizeOf(this.get(chatKey));
  }

  /** How many compactions this session has survived (persisted via _meta). */
  compactions(chatKey: string): number {
    return this.get(chatKey).filter((m) => (m._meta as Record<string, unknown> | undefined)?.compacted).length;
  }

  private sizeOf(messages: Msg[]): number {
    let n = 0;
    for (const m of messages) {
      n += m.content.length;
      if (m.reasoning_content) n += m.reasoning_content.length;
      if (m.tool_calls) for (const tc of m.tool_calls) n += tc.function.arguments.length + tc.function.name.length;
    }
    return n;
  }

  /** Compact if over budget. Called by the router before each run. */
  async maybeCompact(chatKey: string, streamFn: StreamFn, model: string): Promise<void> {
    const messages = this.get(chatKey);
    const total = this.sizeOf(messages);
    if (total < this.maxChars || this.compacting.has(chatKey)) return;
    this.compacting.add(chatKey);
    try {
      // Find a cut point: keep the newest ~30% of the budget intact,
      // cut only at a user-message boundary (never mid tool-chain).
      const keepBudget = Math.floor(this.maxChars * 0.3);
      let tail = 0;
      let cut = messages.length;
      while (cut > 0) {
        const m = messages[cut - 1];
        tail += m.content.length + (m.reasoning_content?.length ?? 0);
        if (tail > keepBudget) break;
        cut--;
      }
      if (cut >= messages.length) return; // recent tail alone nearly fills the budget — nothing old to summarize
      while (cut > 1 && messages[cut].role !== "user") cut--;
      if (cut <= 1) return; // nothing worth summarizing

      const old = messages.slice(0, cut);
      const transcript = old
        .map((m) => {
          if (m.role === "tool") return `[tool result] ${m.content.slice(0, 300)}`;
          if (m.role === "assistant") return `[assistant] ${m.content.slice(0, 800)}`;
          return `[user] ${m.content.slice(0, 800)}`;
        })
        .join("\n")
        .slice(0, 60_000);

      log("session", `compacting ${chatKey}: ${messages.length} msgs, ${total} chars`);
      const res = await streamFn({
        model,
        messages: [
          {
            role: "user",
            content:
              "Summarize this conversation transcript for future reference. Keep: user requests, decisions made, important facts/file paths/IDs, pending tasks. Be terse (under 400 words). Output plain text, no preamble.\n\n" +
              transcript,
          },
        ],
        tools: [],
      });

      const summary: Msg = {
        role: "user",
        content: `[earlier conversation summary]\n${res.content}\n[end of summary — the conversation continues below]`,
        _meta: {
          ts: Date.now(),
          internal: true,
          compacted: old.length,
          // Group transcripts are already public-only. Preserve that proof on
          // their summary so Router does not mistake a safe compaction for
          // legacy private history on the next group turn.
          ...(old.every((m) => m._meta?.groupSafe === true) ? { groupSafe: true } : {}),
        },
      };
      const next = [summary, ...messages.slice(cut)];
      this.sessions.set(chatKey, next);
      const f = this.fileFor(chatKey);
      const tmp = f + ".tmp";
      writeFileSync(tmp, next.map((m) => JSON.stringify(m)).join("\n") + "\n");
      renameSync(tmp, f);
      log("session", `compacted ${chatKey}: ${old.length} msgs → summary (${res.content.length} chars)`);
    } catch (e) {
      warn("session", "compaction failed (continuing without):", e);
    } finally {
      this.compacting.delete(chatKey);
    }
  }
}
