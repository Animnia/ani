/**
 * Web tools, zero-dependency edition.
 * - web_search: Bing first (reachable directly in CN), DuckDuckGo HTML as
 *   fallback (via proxy). HTML scraping rots over time; errors are explicit
 *   so the agent can fall back to the browser tool.
 * - fetch_url: GET a page, HTML→plain text extraction, direct-then-proxy.
 */
import { httpGet } from "../core/net.ts";
import { getConfig } from "../core/config.ts";
import type { ToolDef } from "../core/types.ts";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_SEARCH_LEN = 12_000;
const MAX_FETCH_LEN = 30_000;

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre)>/gi, "\n\n")
    .replace(/<(br|hr)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

async function searchBing(q: string, proxy?: string): Promise<SearchHit[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=10&setlang=zh-hans`;
  const res = await httpGet(url, { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" }, proxy, timeoutMs: 20_000 });
  if (res.status !== 200) throw new Error(`Bing HTTP ${res.status}`);
  const html = res.body.toString("utf8");
  const hits: SearchHit[] = [];
  const blocks = html.split(/<li class="b_algo"/).slice(1);
  for (const b of blocks) {
    const m = /<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!m) continue;
    const pm = /<p[^>]*>([\s\S]*?)<\/p>/.exec(b);
    hits.push({ title: stripTags(m[2]).slice(0, 200), url: m[1], snippet: pm ? stripTags(pm[1]).slice(0, 400) : "" });
    if (hits.length >= 8) break;
  }
  return hits;
}

async function searchDDG(q: string, proxy?: string): Promise<SearchHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const res = await httpGet(url, { headers: { "User-Agent": UA }, proxy, timeoutMs: 20_000 });
  if (res.status !== 200) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = res.body.toString("utf8");
  const hits: SearchHit[] = [];
  const rx = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipBlocks = html.split(/<a[^>]*class="result__snippet"/);
  let m;
  let i = 0;
  while ((m = rx.exec(html)) && hits.length < 8) {
    let u = m[1].replace(/&amp;/g, "&");
    const ud = /[?&]uddg=([^&]+)/.exec(u);
    if (ud) u = decodeURIComponent(ud[1]);
    const snipPart = snipBlocks[i + 1];
    const sm = snipPart ? />([\s\S]*?)<\/a>/.exec(snipPart) : null;
    hits.push({ title: stripTags(m[2]).slice(0, 200), url: u, snippet: sm ? stripTags(sm[1]).slice(0, 400) : "" });
    i++;
  }
  return hits;
}

export const webSearchTool: ToolDef = {
  name: "web_search",
  description: "Search the web. Returns titles, URLs and snippets. For reading a page use fetch_url (or the browser tool for JS-heavy/login-walled sites).",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
  },
  async execute(args) {
    const q = String(args.query ?? "").trim();
    if (!q) return "Error: empty query";
    const proxy = getConfig().proxy;
    const errors: string[] = [];
    for (const [name, fn, useProxy] of [
      ["bing", searchBing, false],
      ["bing+proxy", searchBing, true],
      ["duckduckgo", searchDDG, true],
    ] as const) {
      try {
        const hits = await fn(q, useProxy ? proxy : undefined);
        if (!hits.length) {
          errors.push(`${name}: 0 results (markup may have changed)`);
          continue;
        }
        const text = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n\n");
        return `[via ${name}]\n` + text.slice(0, MAX_SEARCH_LEN);
      } catch (e) {
        errors.push(`${name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return "Error: all search backends failed:\n" + errors.join("\n") + "\nConsider the browser tool instead.";
  },
};

export const fetchUrlTool: ToolDef = {
  name: "fetch_url",
  description:
    "Fetch a URL and return readable text (HTML is converted to plain text). Tries direct connection first, then the configured proxy. raw=true returns unprocessed source. For pages requiring JS or login, use the browser tool instead.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string" },
      raw: { type: "boolean", description: "Return raw body without HTML→text conversion" },
      maxChars: { type: "number", description: `Cap response length (default ${MAX_FETCH_LEN})` },
    },
    required: ["url"],
  },
  async execute(args) {
    const url = String(args.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) return "Error: url must start with http:// or https://";
    const maxChars = Math.min(Number(args.maxChars) || MAX_FETCH_LEN, 120_000);
    const raw = args.raw === true;
    const proxy = getConfig().proxy;

    let res;
    let lastErr: unknown = null;
    for (const p of [undefined, proxy]) {
      try {
        res = await httpGet(url, { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" }, proxy: p, timeoutMs: 25_000, maxBytes: 16 * 1024 * 1024 });
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!res) return `Error: fetch failed (direct and proxy): ${lastErr instanceof Error ? lastErr.message : lastErr}`;
    if (res.status >= 400) return `Error: HTTP ${res.status} for ${url}\n${res.body.toString("utf8").slice(0, 500)}`;

    const ctype = (res.headers["content-type"] ?? "").toLowerCase();
    const body = res.body.toString("utf8");
    if (raw || !ctype.includes("html")) {
      return `[${res.status} ${ctype || "unknown type"}]\n` + body.slice(0, maxChars);
    }
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() ?? "";
    const text = stripTags(body);
    return `[${res.status}] ${title}\n${text}`.slice(0, maxChars) + (text.length > maxChars ? "\n[truncated]" : "");
  },
};
