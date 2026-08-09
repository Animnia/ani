/**
 * File tools: read_file, write_file, edit_file, list_dir, grep_files.
 * Same shape pi agents use; grep leans on Windows-native findstr so there is
 * nothing to install.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { ToolDef } from "../core/types.ts";

const MAX_READ_CHARS = 60_000;

function needStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v) throw new Error(`missing argument: ${key}`);
  return v;
}

export const readFileTool: ToolDef = {
  name: "read_file",
  description: "Read a text file (utf8). Returns content with a truncation note if very long. Use offset/limit for large files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "number", description: "Start line (1-based)" },
      limit: { type: "number", description: "Max lines to return" },
    },
    required: ["path"],
  },
  async execute(args) {
    const p = needStr(args, "path");
    if (!existsSync(p)) return `Error: file not found: ${p}`;
    const st = statSync(p);
    if (st.isDirectory()) return `Error: ${p} is a directory — use list_dir`;
    if (st.size > 8 * 1024 * 1024) return `Error: file too large (${st.size} bytes) — read parts with the shell tool`;
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch (e) {
      return `Error: cannot read ${p}: ${e instanceof Error ? e.message : e} (binary file? try the shell tool)`;
    }
    let lines = text.split("\n");
    const totalLines = lines.length;
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.max(1, Number(args.limit) || 2000);
    lines = lines.slice(offset - 1, offset - 1 + limit);
    let body = lines.join("\n");
    let note = "";
    if (body.length > MAX_READ_CHARS) {
      body = body.slice(0, MAX_READ_CHARS);
      note = `\n[truncated at ${MAX_READ_CHARS} chars — use offset/limit]`;
    }
    return `${body}${note}\n[file: ${p} — ${totalLines} lines${offset > 1 || limit < totalLines ? `, showing from line ${offset}` : ""}]`;
  },
};

export const writeFileTool: ToolDef = {
  name: "write_file",
  description: "Write content to a file (creates parent dirs, overwrites). For small targeted changes to existing files prefer edit_file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  async execute(args) {
    const p = needStr(args, "path");
    const content = String(args.content ?? "");
    if (existsSync(p) && statSync(p).isDirectory()) return `Error: ${p} is a directory`;
    mkdirSync(dirname(resolve(p)), { recursive: true });
    writeFileSync(p, content, "utf8");
    return `Wrote ${content.length} chars to ${p}`;
  },
};

export const editFileTool: ToolDef = {
  name: "edit_file",
  description:
    "Replace an exact text span in a file. oldText must match exactly one location (include enough context to be unique). Fails if 0 or 2+ matches.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      oldText: { type: "string", description: "Exact text to replace" },
      newText: { type: "string", description: "Replacement text" },
    },
    required: ["path", "oldText", "newText"],
  },
  async execute(args) {
    const p = needStr(args, "path");
    const oldText = String(args.oldText ?? "");
    const newText = String(args.newText ?? "");
    if (!oldText) return "Error: oldText is empty";
    if (!existsSync(p)) return `Error: file not found: ${p}`;
    const text = readFileSync(p, "utf8");
    const count = text.split(oldText).length - 1;
    if (count === 0) return `Error: oldText not found in ${p} (check exact whitespace/newlines)`;
    if (count > 1) return `Error: oldText matches ${count} locations in ${p} — add more context to make it unique`;
    writeFileSync(p, text.replace(oldText, newText), "utf8");
    return `Edited ${p} (replaced ${oldText.length} chars with ${newText.length} chars)`;
  },
};

export const listDirTool: ToolDef = {
  name: "list_dir",
  description: "List directory contents with sizes. Non-recursive; add pattern like *.ts to filter names.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      pattern: { type: "string", description: "Optional wildcard filter, e.g. *.ts" },
    },
    required: ["path"],
  },
  async execute(args) {
    const p = needStr(args, "path");
    if (!existsSync(p)) return `Error: not found: ${p}`;
    if (!statSync(p).isDirectory()) return `Error: not a directory: ${p}`;
    const pattern = typeof args.pattern === "string" && args.pattern ? args.pattern.toLowerCase() : null;
    const rx = pattern ? new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$") : null;
    const entries = readdirSync(p)
      .filter((n) => !rx || rx.test(n.toLowerCase()))
      .slice(0, 500)
      .map((n) => {
        try {
          const st = statSync(join(p, n));
          return `${st.isDirectory() ? "d" : "-"} ${st.isDirectory() ? "<dir>" : String(st.size).padStart(10)}  ${n}`;
        } catch {
          return `?          ?  ${n}`;
        }
      });
    return entries.length ? entries.join("\n") : "(empty)";
  },
};

export const grepTool: ToolDef = {
  name: "grep_files",
  description: "Search file contents for a regex (Windows findstr under the hood). Returns matching lines with file:line prefix.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex or literal text to search for" },
      path: { type: "string", description: "Directory to search (recursive)" },
      include: { type: "string", description: "File mask, e.g. *.ts (default: all files)" },
      ignoreCase: { type: "boolean", description: "Default true" },
      literal: { type: "boolean", description: "Treat pattern as literal text, not regex (default false)" },
    },
    required: ["pattern", "path"],
  },
  async execute(args) {
    const pattern = needStr(args, "pattern");
    const p = needStr(args, "path");
    if (!existsSync(p)) return `Error: not found: ${p}`;
    const include = typeof args.include === "string" && args.include ? args.include : "*";
    const icase = args.ignoreCase !== false;
    const literal = args.literal === true;
    // findstr: /S recursive, /N line numbers, /I ignore case, /R regex (or /L literal), /M files-with-matches is too coarse — use /N for lines
    const fa = ["/S", "/N", ...(icase ? ["/I"] : []), literal ? "/L" : "/R", `/C:${pattern}`, join(p, include)];
    try {
      const out = execFileSync("findstr", fa, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
      const lines = out.split(/\r?\n/).filter(Boolean);
      const capped = lines.slice(0, 200);
      return capped.join("\n") + (lines.length > capped.length ? `\n[...${lines.length - capped.length} more matches]` : "");
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string };
      if (err.status === 1) return "(no matches)";
      return `Error: grep failed: ${err.stdout ?? String(e)}`.slice(0, 2000);
    }
  },
};
