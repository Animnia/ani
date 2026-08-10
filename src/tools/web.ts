/**
 * Web tools, zero-dependency edition.
 * - web_search: Tavily API (real search API — no HTML scraping to rot).
 *   Key from ani.json tavily.apiKey or TAVILY_API_KEY; direct first, then proxy.
 * - fetch_url: GET a page, HTML→plain text extraction, direct-then-proxy.
 */
import { httpGet, httpRequest } from "../core/net.ts";
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

interface TavilyResult {
  answer?: string;
  hits: SearchHit[];
}

async function searchTavily(q: string, proxy?: string): Promise<TavilyResult> {
  const key = getConfig().tavily?.apiKey;
  if (!key) throw new Error("no tavily apiKey");
  const res = await httpRequest("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      query: q,
      max_results: 8,
      include_answer: "basic", // one-paragraph synthesized answer when available
      search_depth: "basic",
    }),
    proxy,
    timeoutMs: 25_000,
  });
  if (res.status !== 200) throw new Error(`Tavily HTTP ${res.status}: ${res.body.toString("utf8").slice(0, 200)}`);
  const data = JSON.parse(res.body.toString("utf8")) as {
    answer?: string | null;
    results?: { title?: string; url?: string; content?: string }[];
  };
  const hits = (data.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({ title: (r.title ?? "").slice(0, 200), url: String(r.url), snippet: (r.content ?? "").slice(0, 500) }));
  return { answer: data.answer ?? undefined, hits };
}

/** Exported for tests: render the model-facing text block. */
export function formatSearch(q: string, r: TavilyResult): string {
  const parts: string[] = [];
  if (r.answer) parts.push(`答案速览: ${r.answer}`);
  parts.push(r.hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n\n"));
  return `[tavily: ${q}]\n` + parts.join("\n\n").slice(0, MAX_SEARCH_LEN);
}

export const webSearchTool: ToolDef = {
  name: "web_search",
  description: "Search the web (Tavily). Returns a synthesized answer plus titles, URLs and snippets. For reading a page use fetch_url (or the browser tool for JS-heavy/login-walled sites).",
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
    if (!getConfig().tavily?.apiKey) {
      return "Error: web_search needs a Tavily API key — set tavily.apiKey in ani.json (ani config set tavily.apiKey tvly-...) or env TAVILY_API_KEY";
    }
    const proxy = getConfig().proxy;
    const errors: string[] = [];
    for (const [label, p] of [["direct", undefined], ["proxy", proxy]] as const) {
      try {
        const r = await searchTavily(q, p);
        if (!r.hits.length) {
          errors.push(`${label}: 0 results`);
          continue;
        }
        return formatSearch(q, r);
      } catch (e) {
        errors.push(`${label}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return "Error: tavily search failed:\n" + errors.join("\n") + "\nConsider the browser tool instead.";
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
