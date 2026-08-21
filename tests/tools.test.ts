/**
 * Tool-level tests: shell, files, memory. Local only, strict timeouts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellTool } from "../src/tools/shell.ts";
import { editFileTool, grepTool, listDirTool, readFileTool, writeFileTool } from "../src/tools/files.ts";
import { localDate, memoryReadTool, memorySearchTool, memoryWriteTool } from "../src/tools/memory.ts";

test("localDate uses local calendar date, zero-padded", { timeout: 10_000 }, () => {
  // 2026-04-10 23:30 UTC is already Apr 11 for users east of UTC+0:30 —
  // localDate must agree with the LOCAL clock, whatever the host timezone
  const edge = new Date("2026-04-10T23:30:00.000Z");
  const expected = `${edge.getFullYear()}-${String(edge.getMonth() + 1).padStart(2, "0")}-${String(edge.getDate()).padStart(2, "0")}`;
  assert.equal(localDate(edge), expected);
  assert.match(localDate(new Date(0, 0, 5, 3, 4)), /^\d{4}-01-05$/, "zero-padded");
});
import { PATHS } from "../src/core/config.ts";
import { IS_WIN } from "./helpers.ts";

const ctx = { chatKey: "t:t", channel: "t", chatId: "t", cwd: process.cwd() };

test("shell runs commands and reports exit codes", { timeout: 30_000 }, async () => {
  const out = await shellTool.execute({ command: "echo ANI_SHELL_OK" }, ctx);
  assert.match(out, /ANI_SHELL_OK/);
  assert.match(out, /exit code 0/);

  const fail = await shellTool.execute({ command: "exit 3" }, ctx);
  assert.match(fail, /exit code 3/);
});

test("shell timeout kills long commands", { timeout: 30_000 }, async () => {
  const start = Date.now();
  const sleeper = IS_WIN ? "ping -n 30 127.0.0.1 >nul" : "sleep 30";
  const out = await shellTool.execute({ command: sleeper, timeout: 2 }, ctx);
  assert.ok(Date.now() - start < 15_000, "killed quickly");
  assert.match(out, /killed/);
});

test("file tools roundtrip + edit uniqueness", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ani-files-"));
  try {
    const f = join(dir, "a.txt");
    assert.match(await writeFileTool.execute({ path: f, content: "one\ntwo\nthree\none\n" }, ctx), /Wrote 18 chars/);
    assert.match(await readFileTool.execute({ path: f }, ctx), /two/);

    // ambiguous edit fails
    assert.match(await editFileTool.execute({ path: f, oldText: "one", newText: "1" }, ctx), /matches 2 locations/);
    // unique edit works
    assert.match(await editFileTool.execute({ path: f, oldText: "one\ntwo", newText: "1\n2" }, ctx), /Edited/);
    assert.equal(readFileSync(f, "utf8"), "1\n2\nthree\none\n");

    assert.match(await listDirTool.execute({ path: dir }, ctx), /a\.txt/);
    assert.match(await grepTool.execute({ pattern: "three", path: dir, include: "*.txt" }, ctx), /three/);
    assert.equal(await grepTool.execute({ pattern: "zzz-no-match", path: dir }, ctx), "(no matches)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory write/search/read", { timeout: 10_000 }, async () => {
  const marker = `TEST_MARKER_${Date.now()}`;
  assert.match(await memoryWriteTool.execute({ action: "note", content: `note with ${marker}` }, ctx), /Noted/);
  assert.match(await memorySearchTool.execute({ query: marker }, ctx), new RegExp(marker));
  const list = await memoryReadTool.execute({ date: "list" }, ctx);
  assert.match(list, /\.md/);
  assert.match(await memoryReadTool.execute({ date: "../../../PERSONA" }, ctx), /^Error: date must be/);
  // cleanup the test note
  const today = new Date().toISOString().slice(0, 10);
  const f = join(PATHS.memory, "notes", today + ".md");
  if (existsSync(f)) {
    const cleaned = readFileSync(f, "utf8").split("\n").filter((l) => !l.includes(marker)).join("\n");
    writeFileSync(f, cleaned);
  }
});

test("memory_write append/set MEMORY.md", { timeout: 10_000 }, async () => {
  const marker = `MEM_MARKER_${Date.now()}`;
  const before = existsSync(PATHS.memoryFile) ? readFileSync(PATHS.memoryFile, "utf8") : "";
  try {
    assert.match(await memoryWriteTool.execute({ action: "append", content: `- ${marker}` }, ctx), /Appended/);
    assert.match(readFileSync(PATHS.memoryFile, "utf8"), new RegExp(marker));
  } finally {
    writeFileSync(PATHS.memoryFile, before); // restore
  }
});
