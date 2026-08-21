/**
 * Owner pairing, as pure file-based functions so both the daemon (router)
 * and the standalone `node ani.ts approve` command share one store.
 * data/pending-pairs.json holds pending codes; approve moves the user into
 * ani.json owners[]. A running daemon picks it up via the config watcher.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PATHS, loadConfig } from "./config.ts";

export interface PendingPair {
  code: string;
  channel: string;
  userId: string;
  chatId: string;
  userName?: string;
  createdAt: number;
  lastNotifiedAt: number;
}

export const PAIR_TTL = 30 * 60_000;
export const PAIR_RENOTIFY = 60 * 60_000;

export function loadPending(file = PATHS.pendingFile): PendingPair[] {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* ignore */
  }
  return [];
}

export function savePending(list: PendingPair[], file = PATHS.pendingFile): void {
  try {
    writeFileSync(file, JSON.stringify(list, null, 2));
  } catch {
    /* ignore */
  }
}

/** Find-or-create a pending pairing for this user. Expired records are
 *  replaced (never duplicated). Returns the live record. */
export function upsertPending(
  input: { channel: string; userId: string; chatId: string; userName?: string },
  file = PATHS.pendingFile,
): PendingPair {
  const list = loadPending(file);
  const now = Date.now();
  const existing = list.find((x) => x.channel === input.channel && x.userId === input.userId);
  if (existing && now - existing.createdAt <= PAIR_TTL) return existing;
  const p: PendingPair = {
    code: randomUUID().slice(0, 6).toUpperCase(),
    ...input,
    createdAt: now,
    lastNotifiedAt: 0,
  };
  savePending([...list.filter((x) => !(x.channel === input.channel && x.userId === input.userId)), p], file);
  return p;
}

/**
 * Approve a pairing code: remove it from pending and add the user to
 * ani.json owners. Returns the approved pair, or null if code unknown.
 * Paths are injectable for tests.
 */
export function approveCode(
  code: string,
  opts: { pendingFile?: string; configFile?: string } = {},
): PendingPair | null {
  const pendingFile = opts.pendingFile ?? PATHS.pendingFile;
  const configFile = opts.configFile ?? PATHS.configFile;
  const pending = loadPending(pendingFile);
  const idx = pending.findIndex((x) => x.code.toUpperCase() === code.toUpperCase());
  if (idx === -1) return null;
  const p = pending[idx];
  const now = Date.now();
  if (!Number.isFinite(p.createdAt) || p.createdAt > now || now - p.createdAt > PAIR_TTL) return null;

  const cfg = opts.configFile ? JSON.parse(readFileSync(configFile, "utf8")) : loadConfig();
  const channels = cfg.channels as unknown as Record<string, { owners?: unknown }> | undefined;
  if (!channels || !Object.hasOwn(channels, p.channel)) return null;
  const chCfg = channels[p.channel];
  if (!chCfg || !Array.isArray(chCfg.owners)) return null;

  if (!chCfg.owners.includes(p.userId)) chCfg.owners.push(p.userId);
  writeFileSync(configFile, JSON.stringify(cfg, null, 2));
  // Consume the code only after every validation passed and the owner update
  // reached disk. A malformed/expired record must not destroy a usable code.
  pending.splice(idx, 1);
  savePending(pending, pendingFile);
  return p;
}
