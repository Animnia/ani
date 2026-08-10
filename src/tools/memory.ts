/**
 * Long-term memory. Plain markdown files under data/memory/:
 *   MEMORY.md           — curated durable facts (the agent maintains this)
 *   notes/YYYY-MM-DD.md — append-only daily logs
 * The system prompt already injects MEMORY.md; these tools let the agent
 * update it and search older notes.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../core/config.ts";
import type { ToolDef } from "../core/types.ts";

function ensureDir(): void {
  mkdirSync(join(PATHS.memory, "notes"), { recursive: true });
}

/** Local (not UTC!) YYYY-MM-DD — toISOString would put early-morning notes
 *  into yesterday's file for users east of Greenwich (e.g. UTC+8 before 8am). */
export function localDate(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function today(): string {
  return localDate();
}

export const memoryWriteTool: ToolDef = {
  name: "memory_write",
  description:
    "Update long-term memory. action=append: add a line/section to MEMORY.md (durable facts: preferences, important IDs, project state). action=set: rewrite MEMORY.md entirely (use to reorganize). action=note: add a timestamped entry to today's daily note (ephemeral events, things done).",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["append", "set", "note"] },
      content: { type: "string" },
    },
    required: ["action", "content"],
  },
  async execute(args) {
    const action = String(args.action);
    const content = String(args.content ?? "").trim();
    if (!content) return "Error: empty content";
    ensureDir();
    if (action === "set") {
      writeFileSync(PATHS.memoryFile, content + "\n", "utf8");
      return `MEMORY.md rewritten (${content.length} chars)`;
    }
    if (action === "append") {
      appendFileSync(PATHS.memoryFile, (existsSync(PATHS.memoryFile) ? "\n" : "") + content + "\n");
      return "Appended to MEMORY.md";
    }
    if (action === "note") {
      const f = join(PATHS.memory, "notes", today() + ".md");
      const ts = new Date().toTimeString().slice(0, 5);
      appendFileSync(f, `- ${ts} ${content}\n`);
      return `Noted in ${today()}.md`;
    }
    return `Error: unknown action "${action}"`;
  },
};

export const memorySearchTool: ToolDef = {
  name: "memory_search",
  description: "Search long-term memory (MEMORY.md + all daily notes) for a keyword or regex. Returns matching lines with file names.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
  },
  async execute(args) {
    const q = String(args.query ?? "");
    if (!q.trim()) return "Error: empty query";
    ensureDir();
    let rx: RegExp;
    try {
      rx = new RegExp(q, "i");
    } catch {
      rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const files = [PATHS.memoryFile];
    try {
      for (const n of readdirSync(join(PATHS.memory, "notes")).sort().reverse()) {
        if (n.endsWith(".md")) files.push(join(PATHS.memory, "notes", n));
      }
    } catch {
      /* no notes dir */
    }
    const hits: string[] = [];
    for (const f of files) {
      if (!existsSync(f)) continue;
      const name = f.replace(PATHS.memory + "\\", "").replace(PATHS.memory + "/", "");
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (rx.test(line) && hits.length < 60) hits.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    return hits.length ? hits.join("\n") : "(no memory matches)";
  },
};

export const memoryReadTool: ToolDef = {
  name: "memory_read",
  description: "Read MEMORY.md in full, or a specific daily note (date=YYYY-MM-DD), or list available notes (date=list).",
  parameters: {
    type: "object",
    properties: {
      date: { type: "string", description: "Optional: YYYY-MM-DD or 'list'" },
    },
  },
  async execute(args) {
    ensureDir();
    const date = typeof args.date === "string" ? args.date.trim() : "";
    if (date === "list") {
      try {
        return readdirSync(join(PATHS.memory, "notes")).sort().reverse().join("\n") || "(no notes)";
      } catch {
        return "(no notes)";
      }
    }
    const f = date ? join(PATHS.memory, "notes", date + ".md") : PATHS.memoryFile;
    if (!existsSync(f)) return `(empty: ${f})`;
    return readFileSync(f, "utf8").slice(0, 40_000);
  },
};

/** The owner's living profile (USER.md). memory_* records FACTS AND EVENTS;
 *  user_profile records WHO THE OWNER IS — preferences, habits, identity.
 *  Injected into the system prompt on every turn. */
export const userProfileTool: ToolDef = {
  name: "user_profile",
  description:
    "Maintain the owner profile (USER.md) — who the owner IS: preferences, habits, identity, workflow. action=append: add a line; action=set: rewrite entirely (reorganize); action=read: show current content. Record durable traits, not conversation logs.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["append", "set", "read"] },
      content: { type: "string", description: "required for append/set" },
    },
    required: ["action"],
  },
  async execute(args) {
    const action = String(args.action);
    const content = String(args.content ?? "").trim();
    ensureDir();
    if (action === "read") {
      if (!existsSync(PATHS.userFile)) return `(empty: ${PATHS.userFile})`;
      return readFileSync(PATHS.userFile, "utf8").slice(0, 20_000);
    }
    if (!content) return "Error: empty content";
    if (action === "set") {
      writeFileSync(PATHS.userFile, content + "\n", "utf8");
      return `USER.md rewritten (${content.length} chars)`;
    }
    if (action === "append") {
      appendFileSync(PATHS.userFile, (existsSync(PATHS.userFile) ? "\n" : "") + content + "\n");
      return "Appended to USER.md";
    }
    return `Error: unknown action "${action}"`;
  },
};
