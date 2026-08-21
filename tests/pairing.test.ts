/**
 * Pairing (security gate): unknown users get a code, approval adds them to
 * config owners. Uses temp files — never touches the real ani.json.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveCode, loadPending, PAIR_TTL, savePending, upsertPending } from "../src/core/pairing.ts";

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "ani-pair-"));
  return {
    dir,
    pendingFile: join(dir, "pending.json"),
    configFile: join(dir, "ani.json"),
    [Symbol.dispose]() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("upsert creates one code per user and reuses it", { timeout: 5000 }, () => {
  const t = tmp();
  try {
    const p1 = upsertPending({ channel: "telegram", userId: "111", chatId: "111" }, t.pendingFile);
    assert.equal(p1.code.length, 6);
    const p2 = upsertPending({ channel: "telegram", userId: "111", chatId: "111" }, t.pendingFile);
    assert.equal(p2.code, p1.code, "same user keeps the same code within TTL");
    const p3 = upsertPending({ channel: "qq", userId: "111", chatId: "111" }, t.pendingFile);
    assert.notEqual(p3.code, p1.code, "different channel gets a different record");
    assert.equal(loadPending(t.pendingFile).length, 2);
  } finally {
    t[Symbol.dispose]();
  }
});

test("approveCode moves user into config owners and clears pending", { timeout: 5000 }, () => {
  const t = tmp();
  try {
    writeFileSync(
      t.configFile,
      JSON.stringify({
        model: "m",
        deepseek: { apiKey: "k", baseUrl: "b" },
        channels: { telegram: { enabled: true, owners: [] }, qq: { enabled: true, owners: ["existing"] } },
        mcpServers: {},
      }),
    );
    const p = upsertPending({ channel: "telegram", userId: "999", chatId: "999" }, t.pendingFile);

    // wrong code does nothing
    assert.equal(approveCode("ZZZZZZ", { pendingFile: t.pendingFile, configFile: t.configFile }), null);

    const approved = approveCode(p.code.toLowerCase(), { pendingFile: t.pendingFile, configFile: t.configFile });
    assert.ok(approved, "case-insensitive approve works");
    assert.equal(approved!.userId, "999");
    assert.equal(loadPending(t.pendingFile).length, 0);

    const cfg = JSON.parse(readFileSync(t.configFile, "utf8"));
    assert.deepEqual(cfg.channels.telegram.owners, ["999"]);
    assert.deepEqual(cfg.channels.qq.owners, ["existing"], "other channel untouched");
  } finally {
    t[Symbol.dispose]();
  }
});

test("expired pending gets a fresh code", { timeout: 5000 }, () => {
  const t = tmp();
  try {
    upsertPending({ channel: "qq", userId: "u", chatId: "c" }, t.pendingFile);
    // age it beyond the TTL
    const aged = Date.now() - 31 * 60_000;
    const list = loadPending(t.pendingFile);
    list[0].createdAt = aged;
    savePending(list, t.pendingFile);
    const p2 = upsertPending({ channel: "qq", userId: "u", chatId: "c" }, t.pendingFile);
    assert.ok(p2.createdAt > aged, "fresh record has a fresh timestamp");
    assert.equal(loadPending(t.pendingFile).length, 1, "expired record replaced, not duplicated");
  } finally {
    t[Symbol.dispose]();
  }
});

test("approveCode rejects expired codes without mutating config or pending", { timeout: 5000 }, () => {
  const t = tmp();
  try {
    const originalConfig = JSON.stringify({ channels: { telegram: { enabled: true, owners: [] } } });
    writeFileSync(t.configFile, originalConfig);
    savePending(
      [{
        code: "OLD123",
        channel: "telegram",
        userId: "expired-user",
        chatId: "expired-user",
        createdAt: Date.now() - PAIR_TTL - 1000,
        lastNotifiedAt: 0,
      }],
      t.pendingFile,
    );

    assert.equal(approveCode("OLD123", { pendingFile: t.pendingFile, configFile: t.configFile }), null);
    assert.equal(readFileSync(t.configFile, "utf8"), originalConfig);
    assert.equal(loadPending(t.pendingFile).length, 1, "rejected code is not consumed");
  } finally {
    t[Symbol.dispose]();
  }
});

test("approveCode only accepts an explicitly configured channel with owners", { timeout: 5000 }, () => {
  const t = tmp();
  try {
    const originalConfig = JSON.stringify({
      channels: { telegram: { enabled: true, owners: [] }, broken: { enabled: true } },
    });
    writeFileSync(t.configFile, originalConfig);
    const now = Date.now();
    savePending(
      [
        { code: "NOCHAN", channel: "unknown", userId: "u1", chatId: "c1", createdAt: now, lastNotifiedAt: 0 },
        { code: "NOOWNR", channel: "broken", userId: "u2", chatId: "c2", createdAt: now, lastNotifiedAt: 0 },
      ],
      t.pendingFile,
    );

    assert.equal(approveCode("NOCHAN", { pendingFile: t.pendingFile, configFile: t.configFile }), null);
    assert.equal(approveCode("NOOWNR", { pendingFile: t.pendingFile, configFile: t.configFile }), null);
    assert.equal(readFileSync(t.configFile, "utf8"), originalConfig);
    assert.equal(loadPending(t.pendingFile).length, 2, "invalid channel records are not consumed");
  } finally {
    t[Symbol.dispose]();
  }
});
