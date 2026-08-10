/**
 * `ani config` — inspect and edit ani.json safely.
 *
 *   ani config                 interactive wizard (TTY only)
 *   ani config show            print the config with secrets masked
 *   ani config set <key> <v>   type-safe update of an EXISTING key
 *
 * Safety rules: unknown keys are refused (typos must not silently create
 * dead config), values are coerced to the type of the current value, keys
 * we don't know about (e.g. "_note" documentation keys) are preserved
 * untouched, and the file stays 0600.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { PATHS } from "./core/config.ts";
import { bold, cyan, dim, gray, green, red, yellow } from "./core/ansi.ts";
import { daemonPid } from "./daemon.ts";

type Json = Record<string, unknown>;

const SECRET = /apiKey|clientSecret|token/i;

function mask(key: string, value: unknown): string {
  const s = Array.isArray(value) ? JSON.stringify(value) : String(value);
  if (!SECRET.test(key) || s.length <= 10) return s;
  return `${s.slice(0, 6)}…${s.slice(-2)}`;
}

/** Recursively list editable leaves as [path, value] pairs. */
function leaves(obj: Json, prefix = ""): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_")) continue; // documentation keys
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...leaves(v as Json, path));
    else out.push([path, v]);
  }
  return out;
}

function readRaw(): Json {
  return JSON.parse(readFileSync(PATHS.configFile, "utf8")) as Json;
}

function writeRaw(obj: Json): void {
  writeFileSync(PATHS.configFile, JSON.stringify(obj, null, 2) + "\n");
  try {
    chmodSync(PATHS.configFile, 0o600); // no-op on Windows, enforced elsewhere
  } catch {
    /* best effort */
  }
}

/** Coerce `raw` to the type of the existing value; throws on mismatch. */
function coerce(raw: string, current: unknown): unknown {
  if (typeof current === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`需要数字，得到 "${raw}"`);
    return n;
  }
  if (typeof current === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error(`需要 true/false，得到 "${raw}"`);
  }
  if (Array.isArray(current)) {
    const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return typeof current[0] === "number" ? items.map(Number) : items;
  }
  return raw;
}

/** Set an existing dotted key. Returns an error string, or null on success. */
export function setConfigValue(path: string, raw: string): string | null {
  const obj = readRaw();
  const parts = path.split(".");
  let node: Json = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = node[parts[i]];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      return `unknown key "${path}"（"${parts.slice(0, i + 1).join(".")}" 不是配置节）`;
    }
    node = next as Json;
  }
  const leaf = parts[parts.length - 1];
  if (!(leaf in node)) {
    const sibs = Object.keys(node).filter((k) => !k.startsWith("_"));
    return `unknown key "${path}"${sibs.length ? ` — 可用: ${sibs.join(", ")}` : ""}`;
  }
  try {
    node[leaf] = coerce(raw, node[leaf]);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  writeRaw(obj);
  return null;
}

export function showConfig(): string {
  const obj = readRaw();
  const rows = leaves(obj).map(([path, v]) => {
    const key = path.split(".").pop() ?? path;
    return `  ${cyan(path.padEnd(28))} ${mask(key, v)}`;
  });
  return `${bold("ani.json")} ${dim(PATHS.configFile)}\n${rows.join("\n")}`;
}

function restartHint(): string {
  return daemonPid()
    ? yellow("\n⚠️  daemon 正在运行旧配置 —— `ani daemon restart` 后生效")
    : dim("\n（正在运行的 ani 会热加载部分配置；完整生效请重启）");
}

async function wizard(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
  try {
    for (;;) {
      const obj = readRaw();
      const items = leaves(obj);
      console.log(`\n${bold("ani 配置")} ${dim("— 输入编号修改（即时保存），回车退出")}`);
      items.forEach(([path, v], i) => {
        const key = path.split(".").pop() ?? path;
        console.log(`  ${cyan(String(i + 1).padStart(2))}. ${path.padEnd(30)} ${gray(mask(key, v))}`);
      });
      const pick = await ask("\n> ");
      if (pick === "" || pick.toLowerCase() === "q") {
        console.log(dim("已退出。") + restartHint());
        return;
      }
      const idx = Number(pick) - 1;
      if (!Number.isInteger(idx) || !items[idx]) {
        console.log(red("无效编号"));
        continue;
      }
      const [path, current] = items[idx];
      const key = path.split(".").pop() ?? path;
      const hint = Array.isArray(current) ? "（逗号分隔）" : typeof current === "boolean" ? "（true/false）" : "";
      const val = await ask(`${path} ${hint}\n当前: ${mask(key, current)}\n新值（回车保持不变）: `);
      if (val === "") continue;
      const err = setConfigValue(path, val);
      console.log(err ? red(`✗ ${err}`) : green(`✓ ${path} 已更新`));
    }
  } finally {
    rl.close();
  }
}

export async function runConfig(args: string[]): Promise<void> {
  const sub = args[0] ?? "";
  if (sub === "show") {
    console.log(showConfig());
    return;
  }
  if (sub === "set") {
    const [, path, ...rest] = args;
    if (!path || !rest.length) {
      console.error("usage: ani config set <key> <value>   — 例: ani config set model deepseek-v4-pro");
      process.exit(1);
    }
    const err = setConfigValue(path, rest.join(" "));
    if (err) {
      console.error(`✗ ${err}`);
      process.exit(1);
    }
    console.log(`✓ ${path} 已更新` + restartHint());
    return;
  }
  if (sub === "" || sub === "edit") {
    if (!process.stdout.isTTY) {
      console.log("非交互终端：请用 `ani config show` 或 `ani config set <key> <value>`");
      return;
    }
    await wizard();
    return;
  }
  console.error(`unknown: ani config ${sub}\n用法: ani config [show] | ani config set <key> <value>`);
  process.exit(1);
}
