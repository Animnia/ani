/**
 * `node ani.ts doctor` — self-diagnosis for fresh installs and broken setups.
 * Runtime → config → data dir → DeepSeek → proxy → channels → browser.
 * Every check has a timeout. Exit code 1 if anything FAILs.
 */
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, PATHS, type Config } from "./core/config.ts";
import { httpRequest } from "./core/net.ts";

type Verdict = "ok" | "warn" | "fail";

function line(v: Verdict, name: string, detail: string): Verdict {
  const icon = v === "ok" ? "\x1b[32m✓\x1b[0m" : v === "warn" ? "\x1b[33m!\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(` ${icon} ${name.padEnd(14)} ${detail}`);
  return v;
}

async function check(name: string, fn: () => Promise<string>): Promise<Verdict> {
  try {
    const detail = await withTimeout(fn(), 20_000);
    return line("ok", name, detail);
  } catch (e) {
    return line("fail", name, e instanceof Error ? e.message : String(e));
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout (${ms}ms)`)), ms))]);
}

export async function runDoctor(): Promise<number> {
  console.log("ani doctor\n");
  let worst: Verdict = "ok";
  const bump = (v: Verdict) => {
    if (v === "fail") worst = "fail";
    else if (v === "warn" && worst === "ok") worst = "warn";
  };

  // runtime
  const major = Number(process.versions.node.split(".")[0]);
  bump(major >= 24 ? line("ok", "node", `v${process.versions.node}`) : line("fail", "node", `v${process.versions.node} — ani needs >= 24`));

  // config
  let cfg: Config;
  try {
    cfg = loadConfig();
    bump(line("ok", "config", PATHS.configFile));
  } catch (e) {
    bump(line("fail", "config", e instanceof Error ? e.message : String(e)));
    console.log("\nconfig unreadable — stopping here.");
    return 1;
  }

  // data dir writable
  try {
    mkdirSync(PATHS.data, { recursive: true });
    const probe = join(PATHS.data, ".doctor-probe");
    writeFileSync(probe, "x");
    rmSync(probe);
    bump(line("ok", "data dir", PATHS.data));
  } catch (e) {
    bump(line("fail", "data dir", String(e instanceof Error ? e.message : e)));
  }

  // deepseek
  if (!cfg.deepseek.apiKey || cfg.deepseek.apiKey.includes("xxxx")) {
    bump(line("fail", "deepseek", "apiKey missing/placeholder — edit ani.json"));
  } else {
    bump(
      await check("deepseek", async () => {
        const res = await httpRequest(`${cfg.deepseek.baseUrl}/models`, {
          headers: { Authorization: `Bearer ${cfg.deepseek.apiKey}` },
          timeoutMs: 15_000,
        });
        if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.body.toString("utf8").slice(0, 120)}`);
        const models = (JSON.parse(res.body.toString("utf8")).data ?? []).map((m: any) => m.id).join(", ");
        return `reachable; models: ${models}; using ${cfg.model}`;
      }),
    );
  }

  // proxy
  if (cfg.proxy) {
    bump(
      await check("proxy", async () => {
        // tunnel to telegram's API host as the reference proxied service
        const res = await httpRequest("https://api.telegram.org", { proxy: cfg.proxy, timeoutMs: 12_000 });
        return `CONNECT via ${cfg.proxy} works (HTTP ${res.status})`;
      }),
    );
  } else {
    bump(line("warn", "proxy", "no proxy configured (fine outside CN / if direct works)"));
  }

  // telegram
  const tg = cfg.channels.telegram;
  if (!tg?.enabled) {
    bump(line("warn", "telegram", "disabled in ani.json"));
  } else if (!tg.token) {
    bump(line("fail", "telegram", "enabled but token missing"));
  } else {
    bump(
      await check("telegram", async () => {
        const res = await httpRequest(`https://api.telegram.org/bot${tg.token}/getMe`, {
          proxy: tg.useProxy ? cfg.proxy : undefined,
          timeoutMs: 15_000,
        });
        const data = JSON.parse(res.body.toString("utf8"));
        if (!data.ok) throw new Error(data.description ?? `HTTP ${res.status}`);
        return `@${data.result.username} (${tg.owners.length} owner(s) configured)`;
      }),
    );
  }

  // qq
  const qq = cfg.channels.qq;
  if (!qq?.enabled) {
    bump(line("warn", "qq", "disabled in ani.json"));
  } else if (!qq.appId || !qq.clientSecret) {
    bump(line("fail", "qq", "enabled but appId/clientSecret missing"));
  } else {
    bump(
      await check("qq", async () => {
        const res = await httpRequest("https://bots.qq.com/app/getAppAccessToken", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appId: qq.appId, clientSecret: qq.clientSecret }),
          timeoutMs: 15_000,
        });
        const data = JSON.parse(res.body.toString("utf8"));
        if (!data.access_token) throw new Error(res.body.toString("utf8").slice(0, 150));
        return `token OK (${qq.owners.length} owner(s) configured)`;
      }),
    );
  }

  // browser (best-effort — absence only matters if the agent needs it)
  try {
    const candidates: string[] =
      process.platform === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          ]
        : process.platform === "darwin"
          ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
          : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
    const found = candidates.find((c) => existsSync(c));
    bump(found ? line("ok", "browser", found) : line("warn", "browser", "no Chrome/Edge found — browser tool unavailable (rest of ani unaffected)"));
  } catch {
    bump(line("warn", "browser", "detection failed"));
  }

  // persona
  bump(existsSync(PATHS.personaFile) ? line("ok", "persona", PATHS.personaFile) : line("warn", "persona", "PERSONA.md missing — using built-in default"));

  console.log(
    worst === "fail"
      ? "\n❌ some checks FAILED — fix the ✗ items above"
      : worst === "warn"
        ? "\n⚠️  usable, with warnings"
        : "\n✅ all good — run: node ani.ts",
  );
  return worst === "fail" ? 1 : 0;
}
