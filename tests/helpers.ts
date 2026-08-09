/**
 * Shared test helpers.
 */
import { existsSync, readFileSync } from "node:fs";
import { PATHS } from "../src/core/config.ts";

export const IS_WIN = process.platform === "win32";

/**
 * Live integration tests need real credentials in ani.json. On a fresh
 * clone of the public repo there are none (placeholder key) — those tests
 * skip instead of failing.
 */
export function hasLiveCredentials(): boolean {
  try {
    if (!existsSync(PATHS.configFile)) return false;
    const cfg = JSON.parse(readFileSync(PATHS.configFile, "utf8"));
    const key: string = cfg?.deepseek?.apiKey ?? "";
    if (!/^sk-[0-9a-z]{20,}$/.test(key)) return false;
    if (key.includes("xxxx")) return false; // the example-config placeholder
    return true;
  } catch {
    return false;
  }
}

export function hasLiveChannels(): boolean {
  try {
    if (!existsSync(PATHS.configFile)) return false;
    const cfg = JSON.parse(readFileSync(PATHS.configFile, "utf8"));
    const tg = cfg?.channels?.telegram;
    const qq = cfg?.channels?.qq;
    return Boolean((tg?.enabled && tg.token) || (qq?.enabled && qq.appId));
  } catch {
    return false;
  }
}

/** node:test options helper: skip with a reason when `cond` is false. */
export function needs(cond: boolean, what: string): { skip: string | false } {
  return { skip: cond ? false : `requires ${what} (not available on this machine)` };
}
