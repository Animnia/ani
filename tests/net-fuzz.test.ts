/**
 * Byte-level fuzz for the hand-rolled HTTP client: a raw-socket server sends
 * valid responses fragmented into RANDOM TCP segments — including splits in
 * the middle of chunk-size lines, headers, and the terminating chunk. The
 * client must always reassemble the exact body. Deterministic PRNG.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type AddressType } from "node:net";
import type { Socket } from "node:net";
import { httpRequest } from "../src/core/net.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Write `data` to sock in random-sized pieces with tiny delays. */
async function fragmentWrite(sock: Socket, data: Buffer, rand: () => number, maxFrag: number): Promise<void> {
  let off = 0;
  while (off < data.length) {
    const n = 1 + Math.floor(rand() * Math.min(maxFrag, data.length - off));
    const piece = data.subarray(off, off + n);
    off += n;
    await new Promise<void>((res, rej) => {
      sock.write(piece, (e) => (e ? rej(e) : res()));
    });
    if (maxFrag > 8) await new Promise((r) => setTimeout(r, Math.floor(rand() * 2)));
  }
}

function chunkedBody(body: Buffer, rand: () => number): Buffer {
  // split the body into random chunks, encode each with CRLF framing
  const parts: Buffer[] = [];
  let off = 0;
  while (off < body.length) {
    const n = 1 + Math.floor(rand() * Math.min(97, body.length - off));
    parts.push(Buffer.from(n.toString(16) + "\r\n"), body.subarray(off, off + n), Buffer.from("\r\n"));
    off += n;
  }
  parts.push(Buffer.from("0\r\n\r\n"));
  return Buffer.concat(parts);
}

test("fuzz: HTTP client reassembles randomly fragmented responses", { timeout: 120_000 }, async () => {
  const rand = mulberry32(1337);
  let handler: (sock: Socket) => void = () => {};
  const srv = createServer((sock) => handler(sock));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;

  try {
    for (let iter = 0; iter < 40; iter++) {
      const maxFrag = 1 + Math.floor(rand() * 64); // sometimes 1-byte drips
      // keep total write volume bounded: tiny fragments => small bodies
      const bodyLen = 1 + Math.floor(rand() * Math.min(4096, maxFrag * 30));
      const body = Buffer.alloc(bodyLen);
      for (let i = 0; i < bodyLen; i++) body[i] = 32 + Math.floor(rand() * 95);
      const chunked = iter % 2 === 1;

      handler = (sock) => {
        void (async () => {
          try {
            // read the request headers (drain until \r\n\r\n)
            let buf = Buffer.alloc(0);
            await new Promise<void>((res) => {
              sock.on("data", (d) => {
                buf = Buffer.concat([buf, d]);
                if (buf.includes("\r\n\r\n")) res();
              });
            });
            const head = chunked
              ? "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
              : `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${bodyLen}\r\nConnection: close\r\n\r\n`;
            const payload = chunked ? Buffer.concat([Buffer.from(head), chunkedBody(body, rand)]) : Buffer.concat([Buffer.from(head), body]);
            await fragmentWrite(sock, payload, rand, maxFrag);
            sock.end();
          } catch {
            sock.destroy();
          }
        })();
      };

      const res = await httpRequest(`http://127.0.0.1:${port}/fuzz`, { timeoutMs: 20_000 });
      assert.equal(res.status, 200, `iter ${iter}`);
      assert.deepEqual(res.body, body, `iter ${iter} (${chunked ? "chunked" : "clen"}, len ${bodyLen}, maxFrag ${maxFrag})`);
    }
  } finally {
    srv.close();
  }
});
