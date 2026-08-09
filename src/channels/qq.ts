/**
 * QQ channel — QQ Bot API v2 (https://bot.q.qq.com/wiki/develop/api-v2/).
 * Inbound: WebSocket gateway (hello → identify → heartbeat → dispatch).
 * Outbound: REST at api.sgroup.qq.com with a token refreshed every ~2h.
 * Reconnect with resume (op 6), fall back to re-identify (op 2).
 *
 * Intents: C2C private messages (1<<25), group @-messages (1<<30),
 * direct messages (1<<12).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { download, httpRequest } from "../core/net.ts";
import { PATHS, type ChannelConfig } from "../core/config.ts";
import { error, log, warn } from "../core/log.ts";
import type { Channel, InboundEvent } from "../core/types.ts";
import { chunkText, DedupSet } from "./base.ts";

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const API_BASE = "https://api.sgroup.qq.com";
const MAX_MSG = 3800;
const QQ_TYPES_FILE = join(PATHS.data, "qq-chat-types.json");

const INTENTS = (1 << 25) | (1 << 30) | (1 << 12);

type ChatType = "c2c" | "group" | "dm";

export class QQChannel implements Channel {
  readonly name = "qq";
  private cfg: ChannelConfig;
  private onMessage: (evt: InboundEvent) => void;

  private token = "";
  private tokenExpiresAt = 0;
  private ws: WebSocket | null = null;
  private running = false;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  private dedup = new DedupSet(500);
  /** last inbound msg id per chat — QQ wants msg_id for passive replies */
  private lastMsgId = new Map<string, string>();
  private msgSeq = new Map<string, number>();
  private chatTypes = new Map<string, ChatType>();

  /** endpoint overrides — tests inject a local mock gateway here */
  private endpoints: { tokenUrl: string; apiBase: string };

  constructor(cfg: ChannelConfig, onMessage: (evt: InboundEvent) => void, endpoints?: { tokenUrl?: string; apiBase?: string }) {
    this.cfg = cfg;
    this.onMessage = onMessage;
    this.endpoints = {
      tokenUrl: endpoints?.tokenUrl ?? TOKEN_URL,
      apiBase: endpoints?.apiBase ?? API_BASE,
    };
    // chatTypes are durable knowledge (which openid is a group vs a user) —
    // persist them so cron pushes after a restart hit the right endpoint.
    try {
      if (existsSync(QQ_TYPES_FILE)) {
        for (const [k, v] of Object.entries(JSON.parse(readFileSync(QQ_TYPES_FILE, "utf8")))) {
          if (v === "c2c" || v === "group" || v === "dm") this.chatTypes.set(k, v);
        }
      }
    } catch {
      /* start empty */
    }
  }

  private persistChatTypes(): void {
    try {
      mkdirSync(PATHS.data, { recursive: true });
      writeFileSync(QQ_TYPES_FILE, JSON.stringify(Object.fromEntries(this.chatTypes)));
    } catch {
      /* non-fatal */
    }
  }

  isOwner(userId: string): boolean {
    return this.cfg.owners.includes(userId);
  }

  addOwner(userId: string): void {
    if (!this.cfg.owners.includes(userId)) this.cfg.owners.push(userId);
  }

  // ---------------------------------------------------------------- token

  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const res = await httpRequest(this.endpoints.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.cfg.appId, clientSecret: this.cfg.clientSecret }),
      timeoutMs: 15_000,
    });
    const data = JSON.parse(res.body.toString("utf8"));
    if (!data.access_token) throw new Error(`QQ token failed: ${res.body.toString("utf8").slice(0, 300)}`);
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + Number(data.expires_in ?? 7200) * 1000;
    log("qq", "access token refreshed");
    return this.token;
  }

  private async api<T = any>(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    const token = await this.ensureToken();
    const res = await httpRequest(`${this.endpoints.apiBase}${path}`, {
      method,
      headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json", "User-Agent": "ani/0.1" },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
    });
    const text = res.body.toString("utf8");
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* empty body */
    }
    if (res.status >= 400) {
      throw new Error(`QQ API ${res.status} ${path}: ${data.message ?? text.slice(0, 300)}`);
    }
    return data as T;
  }

  // ------------------------------------------------------------ websocket

  async start(): Promise<void> {
    if (!this.cfg.appId || !this.cfg.clientSecret) throw new Error("qq appId/clientSecret missing");
    this.running = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
  }

  private async connect(): Promise<void> {
    const { url } = await this.api<{ url: string }>("GET", "/gateway");
    log("qq", `gateway: ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("message", (ev) => {
      let payload: any;
      try {
        payload = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.onPayload(payload);
    });
    ws.addEventListener("close", async (ev) => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (!this.running) return;
      const code = ev.code;
      warn("qq", `websocket closed (code ${code})`);
      if (code === 4004) {
        // invalid token — force refresh
        this.token = "";
        try {
          await this.ensureToken();
        } catch (e) {
          error("qq", "token refresh failed:", e);
        }
      }
      if (code === 4013 || code === 4014) {
        error("qq", `intent error ${code} — check bot permissions in the QQ open platform; retrying in 5min`);
        setTimeout(() => this.running && void this.reconnect(), 300_000);
        return;
      }
      if (code === 4006 || code === 4007 || code === 4009) {
        this.sessionId = null;
        this.lastSeq = null;
      }
      void this.reconnect();
    });
    ws.addEventListener("error", () => {
      /* close event follows */
    });
  }

  private async reconnect(): Promise<void> {
    if (!this.running) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
    log("qq", `reconnecting in ${delay / 1000}s`);
    await new Promise((r) => setTimeout(r, delay));
    if (!this.running) return;
    try {
      await this.connect();
      this.reconnectDelay = 1000;
    } catch (e) {
      warn("qq", `reconnect failed: ${e instanceof Error ? e.message : e}`);
      void this.reconnect();
    }
  }

  private send(payload: unknown): void {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
    } catch (e) {
      warn("qq", "ws send failed:", e);
    }
  }

  private onPayload(p: any): void {
    const { op, t, s, d } = p;
    if (typeof s === "number" && (this.lastSeq === null || s > this.lastSeq)) this.lastSeq = s;

    if (op === 10) {
      // hello → heartbeat + auth
      const interval = (d?.heartbeat_interval ?? 30_000) * 0.8;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => this.send({ op: 1, d: this.lastSeq }), interval);
      if (this.sessionId && this.lastSeq !== null) {
        void this.ensureToken().then((token) =>
          this.send({ op: 6, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq } }),
        );
      } else {
        void this.ensureToken().then((token) =>
          this.send({
            op: 2,
            d: {
              token: `QQBot ${token}`,
              intents: INTENTS,
              shard: [0, 1],
              properties: { $os: "windows", $browser: "ani", $device: "ani" },
            },
          }),
        );
      }
      return;
    }

    if (op === 0) {
      if (t === "READY") {
        this.sessionId = d?.session_id ?? null;
        log("qq", `READY (session ${this.sessionId})`);
      } else if (t === "RESUMED") {
        log("qq", "session resumed");
      } else if (t === "C2C_MESSAGE_CREATE" || t === "GROUP_AT_MESSAGE_CREATE" || t === "DIRECT_MESSAGE_CREATE") {
        this.handleInbound(t, d).catch((e) => warn("qq", "inbound handling failed:", e));
      }
      return;
    }

    if (op === 7) {
      // server asks us to reconnect
      try {
        this.ws?.close();
      } catch {
        /* noop */
      }
      return;
    }
    if (op === 9) {
      this.sessionId = null;
      this.lastSeq = null;
    }
    // op 11 = heartbeat ack
  }

  // ------------------------------------------------------------- inbound

  private async handleInbound(t: string, d: any): Promise<void> {
    const msgId = String(d?.id ?? "");
    if (!msgId || this.dedup.has(msgId)) return;
    this.dedup.add(msgId);

    let chatId: string;
    let userId: string;
    let chatType: ChatType;
    let isGroup = false;
    if (t === "C2C_MESSAGE_CREATE") {
      chatId = String(d.author?.user_openid ?? "");
      userId = chatId;
      chatType = "c2c";
    } else if (t === "GROUP_AT_MESSAGE_CREATE") {
      chatId = String(d.group_openid ?? "");
      userId = String(d.author?.member_openid ?? "");
      chatType = "group";
      isGroup = true;
    } else {
      // DIRECT_MESSAGE_CREATE (频道私信)
      chatId = String(d.channel_id ?? d.guild_id ?? "");
      userId = String(d.author?.id ?? "");
      chatType = "dm";
    }
    if (!chatId || !userId) return;

    let text = String(d.content ?? "").trim();
    if (chatType === "group") {
      // group @-messages carry the bot mention as a text prefix — strip it
      text = text.replace(/^@\S+\s*/, "").trim();
    }
    if (this.chatTypes.get(chatId) !== chatType) {
      this.chatTypes.set(chatId, chatType);
      this.persistChatTypes();
    }
    this.lastMsgId.set(chatId, msgId);

    const files: { path: string; name: string; size: number }[] = [];
    const atts = Array.isArray(d.attachments) ? d.attachments : [];
    for (const att of atts) {
      let url = String(att?.url ?? "");
      if (!url) continue;
      if (url.startsWith("//")) url = "https:" + url;
      if (url.startsWith("http://")) url = "https://" + url.slice(7);
      const name = String(att.filename ?? basename(new URL(url).pathname) ?? "file.bin");
      try {
        const buf = await download(url, { timeoutMs: 120_000 });
        const dir = join(PATHS.inbox, `qq_${chatId.replace(/[^A-Za-z0-9_.-]/g, "_")}`);
        mkdirSync(dir, { recursive: true });
        const p = join(dir, `${Date.now()}-${name}`);
        writeFileSync(p, buf);
        files.push({ path: p, name, size: buf.length });
      } catch (e) {
        warn("qq", `attachment download failed: ${e instanceof Error ? e.message : e}`);
        text += `\n[附件 ${name} 下载失败]`;
      }
    }

    if (!text && !files.length) return;
    this.onMessage({
      channel: this.name,
      chatId,
      userId,
      text,
      messageId: msgId,
      files: files.length ? files : undefined,
      isGroup,
    });
  }

  // ------------------------------------------------------------ outbound

  private nextSeq(chatId: string): number {
    const n = (this.msgSeq.get(chatId) ?? 0) + 1;
    this.msgSeq.set(chatId, n);
    return n;
  }

  private messagesPath(chatId: string, type: ChatType): string {
    if (type === "group") return `/v2/groups/${chatId}/messages`;
    if (type === "dm") return `/dms/${chatId}/messages`;
    return `/v2/users/${chatId}/messages`;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const type = this.chatTypes.get(chatId) ?? "c2c";
    for (const chunk of chunkText(text, MAX_MSG)) {
      const msgId = this.lastMsgId.get(chatId);
      const body: Record<string, unknown> = { content: chunk, msg_type: 0 };
      if (msgId) {
        body.msg_id = msgId;
        body.msg_seq = this.nextSeq(chatId);
      }
      await this.api("POST", this.messagesPath(chatId, type), body);
    }
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    const type = this.chatTypes.get(chatId) ?? "c2c";
    const name = basename(filePath);
    const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
    const fileType = isImage ? 1 : 4; // 1=image, 4=file (file may be restricted by platform)
    const base64 = readFileSync(filePath).toString("base64");
    const path = type === "group" ? `/v2/groups/${chatId}/files` : `/v2/users/${chatId}/files`;
    const body: Record<string, unknown> = {
      file_type: fileType,
      srv_send_msg: true, // server delivers the media message directly
      file_data: base64,
    };
    if (!isImage) body.file_name = name;
    await this.api("POST", path, body, 120_000);
    if (caption) await this.sendText(chatId, caption);
  }
}
