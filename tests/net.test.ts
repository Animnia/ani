/**
 * net.ts tests — all against LOCAL servers, all with strict timeouts.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import { once } from "node:events";
import { httpGet, httpRequest, multipart, postSSE, Queue, withTimeout } from "../src/core/net.ts";

let server: http.Server;
let port: number;

before(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/hello") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hi there");
    } else if (url === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: 1 }));
    } else if (url === "/gzip") {
      res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" });
      res.end(zlib.gzipSync("gzipped content"));
    } else if (url === "/chunked") {
      res.writeHead(200, { "transfer-encoding": "chunked", "content-type": "text/plain" });
      res.write("chunk1-");
      setTimeout(() => {
        res.write("chunk2");
        res.end();
      }, 50);
    } else if (url === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"a":1}\n\n');
      setTimeout(() => {
        res.write("data: [DONE]\n\n");
        res.end();
      }, 50);
    } else if (url === "/hang") {
      // never responds — for deterministic client-timeout testing
    } else if (url === "/redirect") {
      res.writeHead(302, { location: "/hello" });
      res.end();
    } else if (url === "/echo") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(JSON.stringify({ method: req.method, ct: req.headers["content-type"], bodyLen: Buffer.concat(chunks).length }));
      });
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as net.AddressInfo).port;
});

after(() => server.close());

test("basic GET", { timeout: 10_000 }, async () => {
  const res = await httpGet(`http://127.0.0.1:${port}/hello`);
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), "hi there");
});

test("json + gzip + chunked", { timeout: 10_000 }, async () => {
  const j = await httpGet(`http://127.0.0.1:${port}/json`);
  assert.deepEqual(JSON.parse(j.body.toString()), { ok: 1 });

  const g = await httpGet(`http://127.0.0.1:${port}/gzip`);
  assert.equal(g.body.toString(), "gzipped content");

  const c = await httpGet(`http://127.0.0.1:${port}/chunked`);
  assert.equal(c.body.toString(), "chunk1-chunk2");
});

test("redirect following", { timeout: 10_000 }, async () => {
  const res = await httpGet(`http://127.0.0.1:${port}/redirect`);
  assert.equal(res.body.toString(), "hi there");
});

test("SSE streaming", { timeout: 10_000 }, async () => {
  const events: string[] = [];
  await postSSE(`http://127.0.0.1:${port}/sse`, {}, (d) => events.push(d));
  assert.deepEqual(events, ['{"a":1}', "[DONE]"]);
});

test("multipart echo", { timeout: 10_000 }, async () => {
  const { body, contentType } = multipart(
    { chat_id: "42" },
    { field: "document", filename: "a.txt", contentType: "text/plain", data: Buffer.from("file-content") },
  );
  const res = await httpRequest(`http://127.0.0.1:${port}/echo`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
  const parsed = JSON.parse(res.body.toString());
  assert.equal(parsed.bodyLen, body.length);
  assert.match(parsed.ct, /multipart\/form-data/);
  assert.match(body.toString(), /name="chat_id"\r\n\r\n42/);
  assert.match(body.toString(), /filename="a\.txt"/);
});

test("CONNECT proxy tunneling", { timeout: 15_000 }, async () => {
  // tiny CONNECT proxy that forwards to our local http server
  const proxy = net.createServer((sock) => {
    sock.once("data", (head) => {
      const m = /^CONNECT 127\.0\.0\.1:(\d+) HTTP/.exec(head.toString("latin1"));
      if (!m) {
        sock.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const upstream = net.connect(Number(m[1]), "127.0.0.1", () => {
        sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(sock);
        sock.pipe(upstream);
      });
      upstream.on("error", () => sock.destroy());
    });
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyPort = (proxy.address() as net.AddressInfo).port;
  try {
    // our client tunnels everything (http and https) through CONNECT
    const res = await httpGet(`http://127.0.0.1:${port}/hello`, {
      proxy: `http://127.0.0.1:${proxyPort}`,
      timeoutMs: 5000,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), "hi there");
  } finally {
    proxy.close();
  }
});

test("withTimeout", { timeout: 10_000 }, async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 200, "never"), /timeout: never/);
  assert.equal(await withTimeout(Promise.resolve(7), 1000, "fast"), 7);
});

test("Queue serializes", { timeout: 10_000 }, async () => {
  const q = new Queue();
  const order: number[] = [];
  await Promise.all([
    q.push(async () => { await new Promise((r) => setTimeout(r, 50)); order.push(1); }),
    q.push(async () => { order.push(2); }),
    q.push(async () => { order.push(3); }),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("request timeout fires", { timeout: 10_000 }, async () => {
  // deterministic: the server accepts but never answers, so the client's
  // inactivity timeout must fire regardless of machine speed
  await assert.rejects(httpGet(`http://127.0.0.1:${port}/hang`, { timeoutMs: 300 }), /timeout/);
});
