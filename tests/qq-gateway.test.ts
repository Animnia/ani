/**
 * QQ channel against a hand-rolled mock gateway — zero deps, so the test
 * implements just enough of a WebSocket *server* (upgrade handshake + frame
 * codec; client frames are masked per RFC 6455) to drive the real flows:
 *
 *   hello(op10) → identify(op2) → READY → C2C message dispatch →
 *   server close(4009) → client reconnects and re-identifies (session cleared)
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_TYPES = join(mkdtempSync(join(tmpdir(), "ani-qqgw-")), "types.json");
import { QQChannel } from "../src/channels/qq.ts";
import type { InboundEvent } from "../src/core/types.ts";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** decode one WS frame from `buf`; returns [frame, rest] or null if incomplete */
function decodeFrame(buf: Buffer): [{ fin: boolean; op: number; payload: Buffer } , Buffer] | null {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const op = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  let payload = buf.subarray(off + maskLen, off + maskLen + len);
  if (masked) {
    const key = buf.subarray(off, off + 4);
    payload = Buffer.from(payload.map((b, i) => b ^ key[i % 4]));
  }
  return [{ fin, op, payload }, buf.subarray(off + maskLen + len)];
}

function closeFrame(code: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(code);
  return encodeFrame(8, b);
}

function encodeFrame(op: number, payload: Buffer): Buffer {
  const len = payload.length;
  let head: Buffer;
  if (len < 126) {
    head = Buffer.from([0x80 | op, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | op;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | op;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

class MockGateway {
  server: http.Server;
  port = 0;
  sockets = new Set<net.Socket>();
  /** received client payloads per connection, in order */
  received: any[][] = [[]];
  private conns = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/token") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "mock-token", expires_in: "7200" }));
      } else if (req.method === "GET" && req.url === "/gateway") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ url: `ws://127.0.0.1:${this.port}/ws` }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.server.on("upgrade", (req, sock) => this.onUpgrade(req, sock as net.Socket));
  }

  private onUpgrade(req: http.IncomingMessage, sock: net.Socket): void {
    const key = req.headers["sec-websocket-key"]!;
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    sock.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    this.sockets.add(sock);
    const connIdx = this.conns++;
    this.received[connIdx] = [];
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const r = decodeFrame(buf);
        if (!r) break;
        const [frame, rest] = r;
        buf = rest;
        if (frame.op === 1) {
          this.received[connIdx].push(JSON.parse(frame.payload.toString("utf8")));
        }
        // op 8 close / op 9 ping: ignore for the test
      }
    });
    sock.on("close", () => this.sockets.delete(sock));
    sock.on("error", () => {});

    // greet: op 10 hello
    this.sendJson(sock, { op: 10, d: { heartbeat_interval: 30_000 } });
  }

  sendJson(sock: net.Socket, obj: unknown): void {
    sock.write(encodeFrame(1, Buffer.from(JSON.stringify(obj))));
  }

  lastSocket(): net.Socket {
    return [...this.sockets][this.sockets.size - 1];
  }

  async start(): Promise<void> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.server.close();
    await Promise.race([once(this.server, "close"), new Promise((r) => setTimeout(r, 2000))]);
  }
}

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const gateways: MockGateway[] = [];
after(async () => {
  for (const g of gateways) await g.stop();
});

test("QQ full gateway lifecycle: identify → READY → dispatch → 4009 reconnect", { timeout: 30_000 }, async () => {
  const gw = new MockGateway();
  gateways.push(gw);
  await gw.start();

  const events: InboundEvent[] = [];
  const qq = new QQChannel(
    { enabled: true, appId: "a", clientSecret: "s", owners: [] },
    (e) => events.push(e),
    { tokenUrl: `http://127.0.0.1:${gw.port}/token`, apiBase: `http://127.0.0.1:${gw.port}`, typesFile: TMP_TYPES },
  );
  try {
    await qq.start();

    // client must identify (op 2) with our token and intents
    await waitFor(() => gw.received[0].some((m) => m.op === 2), "identify");
    const identify = gw.received[0].find((m) => m.op === 2);
    assert.equal(identify.d.token, "QQBot mock-token");
    assert.ok(identify.d.intents & (1 << 25), "C2C intent set");

    // server → READY, then a C2C message
    gw.sendJson(gw.lastSocket(), { op: 0, t: "READY", s: 1, d: { session_id: "sess-1" } });
    gw.sendJson(gw.lastSocket(), {
      op: 0, t: "C2C_MESSAGE_CREATE", s: 2,
      d: { id: "m1", content: "hi ani", author: { user_openid: "U1" } },
    });
    await waitFor(() => events.length === 1, "message dispatch");
    assert.equal(events[0].text, "hi ani");
    assert.equal(events[0].chatId, "U1");

    // heartbeat (op 1) should arrive within the mocked 30s*0.8 window — we
    // don't wait that long; just assert the timer exists
    assert.ok((qq as any).heartbeatTimer, "heartbeat timer running");

    // server kills the connection with 4009 (session invalid) → client must
    // reconnect and re-identify from scratch (not resume)
    const sock0 = gw.lastSocket();
    sock0.write(closeFrame(4009));
    sock0.end();
    await waitFor(() => gw.received.length > 1 && gw.received[1].some((m) => m.op === 2), "re-identify after 4009", 15_000);
    assert.equal((qq as any).sessionId, null, "session cleared on 4009");
  } finally {
    await qq.stop();
  }
});

test("QQ resume path: session kept on normal close, op 6 sent on reconnect", { timeout: 30_000 }, async () => {
  const gw = new MockGateway();
  gateways.push(gw);
  await gw.start();

  const qq = new QQChannel(
    { enabled: true, appId: "a", clientSecret: "s", owners: [] },
    () => {},
    { tokenUrl: `http://127.0.0.1:${gw.port}/token`, apiBase: `http://127.0.0.1:${gw.port}`, typesFile: TMP_TYPES },
  );
  try {
    await qq.start();
    await waitFor(() => gw.received[0].some((m) => m.op === 2), "identify");
    gw.sendJson(gw.lastSocket(), { op: 0, t: "READY", s: 7, d: { session_id: "sess-keep" } });
    await waitFor(() => (qq as any).sessionId === "sess-keep", "session stored");

    // normal close (1001 going away) → session preserved → resume (op 6)
    gw.lastSocket().write(closeFrame(1001));
    gw.lastSocket().end();
    await waitFor(() => gw.received.length > 1 && gw.received[1].some((m) => m.op === 6), "resume op 6", 15_000);
    const resume = gw.received[1].find((m) => m.op === 6);
    assert.equal(resume.d.session_id, "sess-keep");
    assert.equal(resume.d.seq, 7);
  } finally {
    await qq.stop();
  }
});
