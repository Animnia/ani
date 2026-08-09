/**
 * Minimal HTTP/HTTPS client with per-request proxy support (CONNECT tunnel).
 * Node's global fetch can't do per-service proxies without undici, and we
 * carry zero dependencies — so here is ~200 lines of raw HTTP/1.1.
 *
 * Supports: JSON APIs, file download, multipart upload, SSE streaming,
 * gzip responses, redirects, timeouts, AbortSignal.
 */
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import { once } from "node:events";

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  proxy?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
  /** incremental body delivery (for SSE). Response body will be empty. */
  onBodyChunk?: (chunk: Buffer) => void;
  /** follow redirects (default true for GET) */
  followRedirects?: boolean;
  _redirects?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

function connectSocket(
  host: string,
  port: number,
  useTls: boolean,
  proxy: string | undefined,
  timeoutMs: number,
): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const fail = (e: Error) => {
      try { sock?.destroy(); } catch { /* noop */ }
      reject(e);
    };
    let sock: net.Socket | null = null;
    const onTimeout = () => fail(new Error(`connect timeout to ${proxy ? "proxy " : ""}${host}:${port}`));

    if (proxy) {
      const p = new URL(proxy);
      const proxyPort = Number(p.port || 80);
      sock = net.connect(proxyPort, p.hostname);
      sock.setTimeout(timeoutMs, onTimeout);
      sock.once("error", fail);
      sock.once("connect", () => {
        let auth = "";
        if (p.username) {
          auth = `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString("base64")}\r\n`;
        }
        sock!.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
        let head = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
          head = Buffer.concat([head, chunk]);
          const idx = head.indexOf("\r\n\r\n");
          if (idx === -1) {
            if (head.length > 16_384) fail(new Error("proxy CONNECT: oversized response"));
            return;
          }
          sock!.off("data", onData);
          const statusLine = head.subarray(0, idx).toString("latin1").split("\r\n")[0];
          const m = /^HTTP\/\d\.\d (\d+)/.exec(statusLine);
          if (!m || m[1] !== "200") {
            fail(new Error(`proxy CONNECT failed: ${statusLine}`));
            return;
          }
          // bytes after the header belong to the TLS handshake — none expected here
          finish(sock!);
        };
        sock!.on("data", onData);
      });
    } else {
      sock = net.connect(port, host);
      sock.setTimeout(timeoutMs, onTimeout);
      sock.once("error", fail);
      sock.once("connect", () => finish(sock!));
    }

    function finish(raw: net.Socket) {
      raw.setTimeout(0);
      (raw as net.Socket & { removeListener: net.Socket["removeListener"] }).removeListener("error", fail);
      if (!useTls) {
        resolve(raw);
        return;
      }
      const t = tls.connect({ socket: raw, servername: host, ALPNProtocols: ["http/1.1"] });
      t.once("secureConnect", () => resolve(t));
      t.once("error", reject);
    }
  });
}

export async function httpRequest(urlStr: string, opts: HttpOptions = {}): Promise<HttpResponse> {
  const {
    method = "GET",
    headers = {},
    body,
    proxy,
    timeoutMs = DEFAULT_TIMEOUT,
    signal,
    maxBytes = DEFAULT_MAX_BYTES,
    onBodyChunk,
  } = opts;
  const follow = opts.followRedirects ?? method === "GET";

  const u = new URL(urlStr);
  const isHttps = u.protocol === "https:";
  const port = Number(u.port || (isHttps ? 443 : 80));

  const sock = await connectSocket(u.hostname, port, isHttps, proxy, timeoutMs);
  const kill = () => sock.destroy();
  if (signal) {
    if (signal.aborted) {
      sock.destroy();
      throw new Error("aborted");
    }
    signal.addEventListener("abort", kill, { once: true });
  }

  try {
    return await new Promise<HttpResponse>((resolve, reject) => {
      let buf = Buffer.alloc(0);
      let parsed: { status: number; headers: Record<string, string> } | null = null;
      let bodyBuf = Buffer.alloc(0);
      let chunked = false;
      let gzip = false;
      let closed = false;
      let received = 0;
      let timer: NodeJS.Timeout | null = null;

      const done = (err: Error | null, res?: HttpResponse) => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        sock.destroy();
        if (signal) signal.removeEventListener("abort", kill);
        if (err) reject(err);
        else resolve(res!);
      };

      const armTimeout = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => done(new Error(`request timeout (${timeoutMs}ms) ${method} ${u.hostname}${u.pathname}`)), timeoutMs);
      };
      armTimeout();

      const finishBody = async (raw: Buffer) => {
        let out = raw;
        if (gzip && raw.length) {
          try {
            out = zlib.gunzipSync(raw);
          } catch (e) {
            return done(e as Error);
          }
        }
        done(null, { status: parsed!.status, headers: parsed!.headers, body: onBodyChunk ? Buffer.alloc(0) : out });
      };

      const tryParse = () => {
        if (!parsed) {
          const idx = buf.indexOf("\r\n\r\n");
          if (idx === -1) return;
          const headText = buf.subarray(0, idx).toString("latin1");
          const lines = headText.split("\r\n");
          const sm = /^HTTP\/\d\.\d (\d+)/.exec(lines[0]);
          if (!sm) return done(new Error(`bad HTTP response: ${lines[0]?.slice(0, 120)}`));
          const hdrs: Record<string, string> = {};
          for (const line of lines.slice(1)) {
            const c = line.indexOf(":");
            if (c > 0) hdrs[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
          }
          parsed = { status: Number(sm[1]), headers: hdrs };
          chunked = /chunked/i.test(hdrs["transfer-encoding"] ?? "");
          gzip = /gzip/i.test(hdrs["content-encoding"] ?? "");
          buf = buf.subarray(idx + 4);
          if (onBodyChunk && !chunked && hdrs["content-length"] === undefined) {
            // streaming till close (SSE)
          }
        }

        if (chunked) {
          // parse chunked framing incrementally
          for (;;) {
            const lineEnd = buf.indexOf("\r\n");
            if (lineEnd === -1) return;
            const size = parseInt(buf.subarray(0, lineEnd).toString("latin1").trim(), 16);
            if (Number.isNaN(size)) return done(new Error("bad chunk size"));
            if (buf.length < lineEnd + 2 + size + 2) return; // wait for full chunk
            const chunk = buf.subarray(lineEnd + 2, lineEnd + 2 + size);
            buf = buf.subarray(lineEnd + 2 + size + 2);
            if (size === 0) {
              void finishBody(bodyBuf);
              return;
            }
            received += chunk.length;
            if (received > maxBytes) return done(new Error(`response too large (>${maxBytes} bytes)`));
            if (onBodyChunk) onBodyChunk(chunk);
            else bodyBuf = Buffer.concat([bodyBuf, chunk]);
          }
        } else {
          const lenHeader = parsed.headers["content-length"];
          if (onBodyChunk && buf.length) {
            received += buf.length;
            if (received > maxBytes) return done(new Error(`response too large (>${maxBytes} bytes)`));
            onBodyChunk(buf);
            buf = Buffer.alloc(0);
          } else if (!onBodyChunk) {
            bodyBuf = Buffer.concat([bodyBuf, buf]);
            buf = Buffer.alloc(0);
            if (bodyBuf.length > maxBytes) return done(new Error(`response too large (>${maxBytes} bytes)`));
          }
          if (lenHeader !== undefined) {
            const want = Number(lenHeader);
            const have = onBodyChunk ? received : bodyBuf.length;
            if (have >= want) {
              void finishBody(onBodyChunk ? Buffer.alloc(0) : bodyBuf);
              return;
            }
          }
          // no content-length: wait for close
        }
      };

      sock.on("data", (chunk: Buffer) => {
        armTimeout();
        buf = Buffer.concat([buf, chunk]);
        try {
          tryParse();
        } catch (e) {
          done(e as Error);
        }
      });
      sock.on("error", (e) => done(e));
      sock.on("close", () => {
        if (closed) return;
        if (!parsed) return done(new Error("connection closed before response"));
        if (chunked) return done(new Error("connection closed mid-chunked-body"));
        // content-length absent → close delimits the body
        if (onBodyChunk) done(null, { status: parsed.status, headers: parsed.headers, body: Buffer.alloc(0) });
        else void finishBody(bodyBuf);
      });

      // send request
      const path = (u.pathname || "/") + u.search;
      const bodyBuf0 = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
      const headLines = [
        `${method} ${path} HTTP/1.1`,
        `Host: ${u.host}`,
        `Connection: close`,
        `Accept-Encoding: ${onBodyChunk ? "identity" : "gzip"}`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      if (bodyBuf0 && !Object.keys(headers).some((h) => h.toLowerCase() === "content-length")) {
        headLines.push(`Content-Length: ${bodyBuf0.length}`);
      }
      sock.write(headLines.join("\r\n") + "\r\n\r\n");
      if (bodyBuf0) sock.write(bodyBuf0);
    });
  } finally {
    // socket already destroyed in done()
  }
}

/** Follow redirects for GET-ish requests. */
export async function httpGet(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
  let res = await httpRequest(url, { ...opts, method: opts.method ?? "GET" });
  const maxR = opts._redirects ?? 5;
  let n = 0;
  while ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location && n < maxR) {
    const next = new URL(res.headers.location, url).toString();
    res = await httpRequest(next, { ...opts, method: "GET", body: undefined });
    n++;
  }
  return res;
}

/** POST and read a server-sent-events stream; calls onEvent per `data:` payload. */
export async function postSSE(
  url: string,
  opts: Omit<HttpOptions, "onBodyChunk">,
  onEvent: (data: string) => void,
): Promise<{ status: number; body: string }> {
  let pending = "";
  let nonSse = Buffer.alloc(0);
  const res = await httpRequest(url, {
    ...opts,
    method: opts.method ?? "POST",
    onBodyChunk: (chunk) => {
      nonSse = Buffer.concat([nonSse, chunk]);
      pending += chunk.toString("utf8");
      let idx: number;
      while ((idx = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, idx).replace(/\r$/, "");
        pending = pending.slice(idx + 1);
        if (line.startsWith("data:")) {
          onEvent(line.slice(5).trimStart());
        }
      }
    },
  });
  if (pending.startsWith("data:")) onEvent(pending.slice(5).trimStart());
  return { status: res.status, body: nonSse.toString("utf8") };
}

/** Build a multipart/form-data body. */
export function multipart(
  fields: Record<string, string>,
  file: { field: string; filename: string; contentType: string; data: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = "----ani" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename.replace(/"/g, "_")}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Download a URL to a Buffer (with size cap). */
export async function download(url: string, opts: HttpOptions = {}): Promise<Buffer> {
  const res = await httpGet(url, opts);
  if (res.status >= 400) throw new Error(`download failed: HTTP ${res.status} for ${url.slice(0, 120)}`);
  return res.body;
}

/** Race a promise against a timeout. For tests and defensive waits. */
export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`timeout: ${what} (${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t!);
  }
}

/** Simple promise queue: tasks run one after another per queue instance. */
export class Queue {
  private tail: Promise<unknown> = Promise.resolve();
  push<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => {});
    return p;
  }
}

export { once };
