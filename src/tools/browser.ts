/**
 * Browser control via Chrome DevTools Protocol — zero deps: native WebSocket
 * to a real Chrome/Edge instance launched with a *persistent* profile.
 *
 * Why this avoids captchas: we drive the same real browser binary a human
 * uses, headed (not headless), with automation flags stripped, and a profile
 * that keeps cookies/logins between runs. First login may still need the
 * owner's hand once; after that the site sees a returning human browser.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../core/config.ts";
import { httpRequest } from "../core/net.ts";
import { log } from "../core/log.ts";
import type { ToolDef } from "../core/types.ts";

/** CDP port is discovered, not fixed: Chrome launches with port=0 and writes
 *  <profile>/DevToolsActivePort. A hardcoded 9222 would attach ani to ANY
 *  Chrome answering there — including other tools' instances (wrong profile,
 *  no login state, cross-tool interference). */
let cdpPort: number | null = null;

function cdpBase(): string {
  if (!cdpPort) throw new Error("CDP port unknown — browser not started");
  return `http://127.0.0.1:${cdpPort}`;
}

function readDevToolsPort(): number | null {
  try {
    const first = readFileSync(join(PATHS.browserProfile, "DevToolsActivePort"), "utf8").split("\n")[0].trim();
    const n = Number(first);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

let browserProc: ChildProcess | null = null;
const tabConns = new Map<string, CdpConn>();
let lastTabId: string | null = null;

function findBrowserExe(): string | null {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    candidates.push(
      process.env["PROGRAMFILES"] + "\\Google\\Chrome\\Application\\chrome.exe",
      process.env["PROGRAMFILES(X86)"] + "\\Google\\Chrome\\Application\\chrome.exe",
      process.env["LOCALAPPDATA"] + "\\Google\\Chrome\\Application\\chrome.exe",
      process.env["PROGRAMFILES"] + "\\Microsoft\\Edge\\Application\\msedge.exe",
      process.env["PROGRAMFILES(X86)"] + "\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    // linux: search PATH for common binary names
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
      for (const dir of (process.env.PATH ?? "").split(":")) {
        if (dir) candidates.push(join(dir, name));
      }
    }
  }
  for (const c of candidates) {
    try {
      if (c && existsSync(c)) return c;
    } catch {
      /* next */
    }
  }
  return null;
}

async function cdpAlive(port: number): Promise<boolean> {
  try {
    const res = await httpRequest(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 2000 });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function ensureBrowser(): Promise<void> {
  // reuse: in-memory port, then the profile's DevToolsActivePort file
  if (cdpPort && (await cdpAlive(cdpPort))) return;
  const fromFile = readDevToolsPort();
  if (fromFile && (await cdpAlive(fromFile))) {
    cdpPort = fromFile;
    return;
  }
  const exe = findBrowserExe();
  if (!exe) throw new Error("no Chrome/Edge found on this machine");
  mkdirSync(PATHS.browserProfile, { recursive: true });
  log("browser", `launching ${exe}`);
  browserProc = spawn(
    exe,
    [
      "--remote-debugging-port=0", // OS-assigned; read back via DevToolsActivePort
      `--user-data-dir=${PATHS.browserProfile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--disable-session-crashed-bubble",
      "--start-maximized",
      // headless servers (no X display) need this to run at all;
      // on desktops we stay headed — real windows look human to anti-bot
      ...(process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
        ? ["--headless=new", "--no-sandbox", "--disable-gpu"]
        : []),
    ],
    { detached: true, stdio: "ignore", windowsHide: process.platform !== "win32" },
  );
  browserProc.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const p = readDevToolsPort();
    if (p && (await cdpAlive(p))) {
      cdpPort = p;
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("browser did not open its CDP port within 15s");
}

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

async function listTargets(): Promise<CdpTarget[]> {
  const res = await httpRequest(`${cdpBase()}/json`, { timeoutMs: 5000 });
  return JSON.parse(res.body.toString("utf8")) as CdpTarget[];
}

async function newTab(url: string): Promise<CdpTarget> {
  // Chrome ≥111 requires PUT for /json/new
  let res = await httpRequest(`${cdpBase()}/json/new?${encodeURIComponent(url)}`, { method: "PUT", timeoutMs: 8000 });
  if (res.status >= 400) {
    res = await httpRequest(`${cdpBase()}/json/new?${encodeURIComponent(url)}`, { timeoutMs: 8000 });
  }
  if (res.status >= 400) throw new Error(`cannot open tab: HTTP ${res.status}`);
  return JSON.parse(res.body.toString("utf8")) as CdpTarget;
}

class CdpConn {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Map<string, Set<(params: any) => void>>();
  ready: Promise<void>;

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP websocket connect timeout")), 10_000);
      this.ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      this.ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("CDP websocket error"));
      });
    });
    this.ws.addEventListener("message", (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const cb of this.listeners.get(msg.method) ?? []) cb(msg.params);
      }
    });
    this.ws.addEventListener("close", () => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("CDP websocket closed"));
      }
      this.pending.clear();
      // evict from the connection cache so the next call re-attaches cleanly
      for (const [tabId, c] of tabConns) {
        if (c === this) {
          tabConns.delete(tabId);
          break;
        }
      }
    });
  }

  async send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<any> {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, cb: (params: any) => void): void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(cb);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}

async function connFor(tabId?: string): Promise<{ conn: CdpConn; target: CdpTarget }> {
  await ensureBrowser();
  const targets = (await listTargets()).filter((t) => t.type === "page");
  if (!targets.length) throw new Error("no open tabs — use browser action=open first");
  const target = (tabId && targets.find((t) => t.id === tabId)) || targets.find((t) => t.id === lastTabId) || targets[0];
  lastTabId = target.id;
  let conn = tabConns.get(target.id);
  if (!conn) {
    if (!target.webSocketDebuggerUrl) throw new Error("target has no debugger URL");
    conn = new CdpConn(target.webSocketDebuggerUrl);
    await conn.ready;
    await conn.send("Page.enable");
    await conn.send("Runtime.enable");
    tabConns.set(target.id, conn);
  }
  return { conn, target };
}

function jsString(s: string): string {
  return JSON.stringify(s);
}

export const browserTool: ToolDef = {
  name: "browser",
  description: `Control the real Chrome/Edge browser (persistent profile keeps logins → sites see a returning human, which avoids most captchas). Actions:
- open {url}: open a new tab and wait for load; returns title + visible text preview
- eval {expression, tabId?}: run JavaScript in the page, returns the value (await promises OK)
- text {tabId?}: page visible text (truncated)
- click {selector, tabId?} / type {selector, text, tabId?}: interact with elements
- screenshot {tabId?, path?}: save a PNG screenshot, returns the file path
- tabs: list open tabs; close {tabId?}: close a tab
Use tabId from tabs/open results to address a specific tab; default is the most recent.`,
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["open", "eval", "text", "click", "type", "screenshot", "tabs", "close"] },
      url: { type: "string" },
      expression: { type: "string" },
      selector: { type: "string" },
      text: { type: "string" },
      tabId: { type: "string" },
      path: { type: "string" },
    },
    required: ["action"],
  },
  async execute(args) {
    const action = String(args.action);
    const tabId = typeof args.tabId === "string" && args.tabId ? args.tabId : undefined;
    try {
      if (action === "open") {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) return "Error: open needs an http(s) url";
        await ensureBrowser();
        const target = await newTab(url);
        lastTabId = target.id;
        const { conn } = await connFor(target.id);
        const loaded = new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 20_000); // don't hard-fail on slow pages
          conn.on("Page.loadEventFired", () => {
            clearTimeout(t);
            resolve();
          });
        });
        await loaded;
        await new Promise((r) => setTimeout(r, 500)); // let SPA paint a bit
        const r = await conn.send("Runtime.evaluate", {
          expression: `JSON.stringify({title: document.title, url: location.href, text: (document.body?.innerText || "").slice(0, 4000)})`,
          returnByValue: true,
        });
        const info = JSON.parse(r?.result?.value ?? "{}");
        return `tabId: ${target.id}\ntitle: ${info.title ?? ""}\nurl: ${info.url ?? url}\n\n${info.text ?? "(no visible text)"}`;
      }

      if (action === "tabs") {
        await ensureBrowser();
        const targets = (await listTargets()).filter((t) => t.type === "page");
        if (!targets.length) return "(no tabs open)";
        return targets.map((t) => `${t.id === lastTabId ? "*" : " "} ${t.id}  ${t.title}\n    ${t.url}`).join("\n");
      }

      const { conn, target } = await connFor(tabId);

      if (action === "eval") {
        const expression = String(args.expression ?? "");
        if (!expression.trim()) return "Error: empty expression";
        const r = await conn.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, 60_000);
        if (r?.exceptionDetails) {
          const ex = r.exceptionDetails;
          return `Error: page exception: ${ex.exception?.description ?? ex.text ?? JSON.stringify(ex).slice(0, 500)}`;
        }
        const v = r?.result;
        const out = v?.value !== undefined ? (typeof v.value === "string" ? v.value : JSON.stringify(v.value, null, 2)) : v?.description ?? String(v?.type);
        return String(out).slice(0, 30_000);
      }

      if (action === "text") {
        const r = await conn.send("Runtime.evaluate", {
          expression: `(document.body?.innerText || "")`,
          returnByValue: true,
        });
        return String(r?.result?.value ?? "").slice(0, 30_000);
      }

      if (action === "click") {
        const selector = String(args.selector ?? "");
        const r = await conn.send("Runtime.evaluate", {
          expression: `(() => { const el = document.querySelector(${jsString(selector)}); if (!el) return "Error: no element matches ${selector.replace(/"/g, '\\"')}"; el.scrollIntoView({block:"center"}); el.click(); return "clicked"; })()`,
          returnByValue: true,
        });
        return String(r?.result?.value ?? "(no result)");
      }

      if (action === "type") {
        const selector = String(args.selector ?? "");
        const text = String(args.text ?? "");
        const r = await conn.send("Runtime.evaluate", {
          expression: `(() => { const el = document.querySelector(${jsString(selector)}); if (!el) return "Error: no element matches selector"; el.focus(); el.value = ${jsString(text)}; el.dispatchEvent(new Event("input", {bubbles:true})); el.dispatchEvent(new Event("change", {bubbles:true})); return "typed ${text.length} chars"; })()`,
          returnByValue: true,
        });
        return String(r?.result?.value ?? "(no result)");
      }

      if (action === "screenshot") {
        const r = await conn.send("Page.captureScreenshot", { format: "png" }, 30_000);
        const dir = join(PATHS.data, "screenshots");
        mkdirSync(dir, { recursive: true });
        const out = typeof args.path === "string" && args.path ? args.path : join(dir, `shot-${Date.now()}.png`);
        writeFileSync(out, Buffer.from(r.data, "base64"));
        return `Screenshot saved: ${out} (tab: ${target.title})`;
      }

      if (action === "close") {
        await httpRequest(`${cdpBase()}/json/close/${target.id}`, { timeoutMs: 5000 });
        tabConns.get(target.id)?.close();
        tabConns.delete(target.id);
        if (lastTabId === target.id) lastTabId = null;
        return `Closed tab ${target.id} (${target.title})`;
      }

      return `Error: unknown action "${action}"`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : e}`;
    }
  },
};
