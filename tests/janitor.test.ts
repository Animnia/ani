/**
 * Janitor: old scratch files removed, fresh files and structure kept.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepDataDirs } from "../src/core/janitor.ts";

test("sweeps only files older than 30 days, keeps fresh and non-scratch", { timeout: 10_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ani-janitor-"));
  try {
    const now = Date.now();
    const old = new Date(now - 31 * 86_400_000);
    const fresh = new Date(now - 2 * 86_400_000);

    // layout: inbox/<chat>/old+fresh files, screenshots/old file, a fresh top-level file
    const chat = join(dir, "inbox", "telegram_123");
    mkdirSync(chat, { recursive: true });
    const shots = join(dir, "screenshots");
    mkdirSync(shots, { recursive: true });

    const oldInbox = join(chat, "old-photo.jpg");
    const freshInbox = join(chat, "new-doc.pdf");
    const oldShot = join(shots, "shot-old.png");
    const freshShot = join(shots, "shot-new.png");
    for (const f of [oldInbox, freshInbox, oldShot, freshShot]) writeFileSync(f, "x");
    utimesSync(oldInbox, old, old);
    utimesSync(freshInbox, fresh, fresh);
    utimesSync(oldShot, old, old);
    utimesSync(freshShot, fresh, fresh);

    const res = sweepDataDirs(now, [join(dir, "inbox"), shots]);
    assert.equal(res.removed, 2);
    assert.ok(!existsSync(oldInbox), "old inbox file gone");
    assert.ok(existsSync(freshInbox), "fresh inbox file kept");
    assert.ok(!existsSync(oldShot), "old screenshot gone");
    assert.ok(existsSync(freshShot), "fresh screenshot kept");
    assert.ok(existsSync(chat), "non-empty chat dir kept");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty chat dirs are pruned, missing dirs are fine", { timeout: 10_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ani-janitor-"));
  try {
    const chat = join(dir, "inbox", "qq_old");
    mkdirSync(chat, { recursive: true });
    const oldFile = join(chat, "f.bin");
    writeFileSync(oldFile, "x");
    const old = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(oldFile, old, old);

    const res = sweepDataDirs(Date.now(), [join(dir, "inbox"), join(dir, "does-not-exist")]);
    assert.equal(res.removed, 1);
    assert.equal(readdirSync(join(dir, "inbox")).length, 0, "emptied chat dir pruned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
