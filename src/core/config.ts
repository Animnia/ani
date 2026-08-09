/**
 * Config loading. Single source: ani.json in the project root.
 * First run copies ani.example.json and tells the user to edit it.
 * The daemon watches the file mtime so `node ani.ts approve ...` (a separate
 * process) can add owners to a running instance.
 */
import { copyFileSync, existsSync, readFileSync, statSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log, warn } from "./log.ts";

export interface ChannelConfig {
  enabled: boolean;
  useProxy?: boolean;
  owners: string[];
  token?: string; // telegram
  appId?: string; // qq
  clientSecret?: string; // qq
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  timeoutSec?: number;
}

export interface Config {
  model: string;
  deepseek: { apiKey: string; baseUrl: string };
  /** DeepSeek thinking mode: "enabled" (default) or "disabled" (faster/cheaper) */
  thinking?: "enabled" | "disabled";
  /** proxy URL, e.g. "http://127.0.0.1:6850". Used only where useProxy=true. */
  proxy?: string;
  channels: { telegram?: ChannelConfig; qq?: ChannelConfig };
  mcpServers: Record<string, McpServerConfig>;
  maxContextChars: number;
}

export const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
/** ani version — read from package.json so releases only bump one place. */
export const ANI_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"));
    return String(pkg.version ?? "dev");
  } catch {
    return "dev";
  }
})();

export const PATHS = {
  root: ROOT,
  configFile: join(ROOT, "ani.json"),
  exampleFile: join(ROOT, "ani.example.json"),
  personaFile: join(ROOT, "PERSONA.md"),
  skillsDir: join(ROOT, "skills"),
  data: join(ROOT, "data"),
  sessions: join(ROOT, "data", "sessions"),
  memory: join(ROOT, "data", "memory"),
  memoryFile: join(ROOT, "data", "memory", "MEMORY.md"),
  inbox: join(ROOT, "data", "inbox"),
  cronFile: join(ROOT, "data", "cron.json"),
  pendingFile: join(ROOT, "data", "pending-pairs.json"),
  logFile: join(ROOT, "data", "ani.log"),
  browserProfile: join(ROOT, "data", "browser-profile"),
};

let current: Config | null = null;
let lastMtime = 0;
let reloadListeners: ((cfg: Config) => void)[] = [];

export function loadConfig(): Config {
  if (!existsSync(PATHS.configFile)) {
    copyFileSync(PATHS.exampleFile, PATHS.configFile);
    warn("config", `ani.json created from example — please edit ${PATHS.configFile}`);
  }
  const raw = JSON.parse(readFileSync(PATHS.configFile, "utf8")) as Partial<Config>;
  const cfg: Config = {
    model: raw.model ?? "deepseek-v4-flash",
    deepseek: {
      apiKey: raw.deepseek?.apiKey ?? "",
      baseUrl: (raw.deepseek?.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, ""),
    },
    thinking: raw.thinking === "disabled" ? "disabled" : "enabled",
    proxy: raw.proxy,
    channels: raw.channels ?? {},
    mcpServers: raw.mcpServers ?? {},
    maxContextChars: raw.maxContextChars ?? 600_000,
  };
  current = cfg;
  try {
    lastMtime = statSync(PATHS.configFile).mtimeMs;
  } catch {
    lastMtime = Date.now();
  }
  return cfg;
}

export function getConfig(): Config {
  return current ?? loadConfig();
}

/** Start watching ani.json for external edits (e.g. the approve command).
 *  Watches the DIRECTORY, not the file: editors that save via atomic
 *  delete+recreate kill file-level watchers after the first write. */
export function watchConfig(onReload: (cfg: Config) => void): void {
  reloadListeners.push(onReload);
  try {
    watch(PATHS.root, { persistent: false }, (_event, filename) => {
      if (filename && filename !== "ani.json") return;
      // editors often write twice; debounce crudely
      setTimeout(() => {
        try {
          const m = statSync(PATHS.configFile).mtimeMs;
          if (m !== lastMtime) {
            log("config", "ani.json changed, reloading");
            loadConfig();
            for (const fn of reloadListeners) fn(getConfig());
          }
        } catch {
          /* file momentarily missing during write */
        }
      }, 300);
    });
  } catch (e) {
    warn("config", "cannot watch config dir:", e);
  }
}
