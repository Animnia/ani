/**
 * Telegram channel — Bot API long polling over HTTPS (proxy-supported).
 * No library: getUpdates / sendMessage / sendDocument / getFile via net.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { download, httpRequest, multipart } from "../core/net.ts";
import { getConfig, PATHS, type ChannelConfig } from "../core/config.ts";
import { toTelegramHtml } from "../core/markdown.ts";
import { error, log, warn } from "../core/log.ts";
import type { Channel, InboundEvent } from "../core/types.ts";
import { chunkText } from "./base.ts";

const API = "https://api.telegram.org";
const MAX_MSG = 4000;
const OFFSET_FILE = join(PATHS.data, "telegram-offset.json");

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: string; title?: string };
  text?: string;
  caption?: string;
  photo?: { file_id: string; width: number; height: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; mime_type?: string; file_size?: number };
  audio?: { file_id: string; file_name?: string; file_size?: number };
  video?: { file_id: string; file_name?: string; file_size?: number };
}

export class TelegramChannel implements Channel {
  readonly name = "telegram";
  private cfg: ChannelConfig;
  private running = false;
  private offset = 0;
  private botName = "";
  private onMessage: (evt: InboundEvent) => void;

  constructor(cfg: ChannelConfig, onMessage: (evt: InboundEvent) => void) {
    this.cfg = cfg;
    this.onMessage = onMessage;
  }

  private get proxy(): string | undefined {
    return this.cfg.useProxy ? getConfig().proxy : undefined;
  }

  private apiUrl(method: string): string {
    return `${API}/bot${this.cfg.token}/${method}`;
  }

  private async api<T = any>(method: string, body: Record<string, unknown>, timeoutMs = 35_000): Promise<T> {
    const res = await httpRequest(this.apiUrl(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      proxy: this.proxy,
      timeoutMs,
    });
    const data = JSON.parse(res.body.toString("utf8"));
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? JSON.stringify(data).slice(0, 300)}`);
    return data.result as T;
  }

  isOwner(userId: string): boolean {
    return this.cfg.owners.includes(userId);
  }

  addOwner(userId: string): void {
    if (!this.cfg.owners.includes(userId)) this.cfg.owners.push(userId);
  }

  async start(): Promise<void> {
    if (!this.cfg.token) throw new Error("telegram token missing");
    const me = await this.api<{ username: string }>("getMe", {}, 15_000);
    this.botName = me.username;
    log("telegram", `authorized as @${this.botName}`);

    // Resume from the persisted offset so a restart never reprocesses old
    // updates (Telegram keeps unacknowledged updates for 24h). On the very
    // first boot, skip the backlog entirely.
    this.offset = this.loadOffset();
    if (this.offset === 0) {
      const last = await this.api<TgUpdate[]>("getUpdates", { offset: -1, timeout: 0 }, 15_000);
      if (last.length) this.offset = last[last.length - 1].update_id + 1;
      this.saveOffset();
      log("telegram", `first boot — skipped backlog, offset=${this.offset}`);
    } else {
      await this.catchUpMissed();
    }

    this.running = true;
    void this.pollLoop();
  }

  /** Messages that arrived while ani was down would otherwise be executed
   *  late (a stale "重启电脑" firing at boot is a real hazard) or silently
   *  ignored. Instead: tell each affected owner chat what was missed, then
   *  skip the stale part of the backlog. Fresh messages (<2min, e.g. a
   *  quick daemon restart) are left for the normal poll loop. */
  private async catchUpMissed(): Promise<void> {
    let pending: TgUpdate[];
    try {
      pending = await this.api<TgUpdate[]>("getUpdates", { offset: this.offset, timeout: 0, limit: 100 }, 15_000);
    } catch (e) {
      warn("telegram", "catch-up peek failed (continuing):", e);
      return;
    }
    const nowSec = Date.now() / 1000;
    const stale = pending.filter((u) => (u.message?.date ?? nowSec) < nowSec - 120);
    if (!stale.length) return;

    const missed = new Map<string, number>();
    for (const u of stale) {
      const m = u.message;
      if (!m) continue;
      if (!this.isOwner(String(m.from?.id ?? ""))) continue;
      const cid = String(m.chat.id);
      missed.set(cid, (missed.get(cid) ?? 0) + 1);
    }
    for (const [cid, n] of missed) {
      try {
        await this.sendText(cid, `ani 刚才不在线，错过了你发的 ${n} 条消息 😥 现已恢复，请重新发送～`);
      } catch (e) {
        warn("telegram", `missed-message notice to ${cid} failed:`, e);
      }
      log("telegram", `notified ${cid} about ${n} message(s) missed while down`);
    }
    // skip exactly the stale prefix; update_ids are monotonic
    const maxStale = Math.max(...stale.map((u) => u.update_id));
    if (maxStale >= this.offset) {
      this.offset = maxStale + 1;
      this.saveOffset();
    }
  }

  private loadOffset(): number {
    try {
      if (existsSync(OFFSET_FILE)) return Number(JSON.parse(readFileSync(OFFSET_FILE, "utf8")).offset) || 0;
    } catch {
      /* fall through */
    }
    return 0;
  }

  private saveOffset(): void {
    try {
      mkdirSync(PATHS.data, { recursive: true });
      writeFileSync(OFFSET_FILE, JSON.stringify({ offset: this.offset }));
    } catch {
      /* non-fatal */
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async pollLoop(): Promise<void> {
    let backoff = 1000;
    let conflicts = 0; // consecutive 409s — another instance is polling this bot
    while (this.running) {
      try {
        const updates = await this.api<TgUpdate[]>(
          "getUpdates",
          { offset: this.offset, timeout: 25, allowed_updates: ["message"] },
          35_000,
        );
        backoff = 1000;
        if (conflicts >= 3) log("telegram", "polling healthy again (the other instance stopped)");
        conflicts = 0;
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          if (u.message) {
            try {
              await this.handleMessage(u.message);
            } catch (e) {
              warn("telegram", "message handling failed:", e);
            }
          }
        }
        if (updates.length) this.saveOffset();
      } catch (e) {
        if (!this.running) break;
        const msg = e instanceof Error ? e.message : String(e);
        if (/Conflict/.test(msg)) {
          conflicts++;
          if (conflicts === 3) {
            warn(
              "telegram",
              "repeated 409 Conflicts: ANOTHER ani instance is polling this bot. " +
                "One bot token = one running ani — stop the other instance (ani status / ani.lock) " +
                "or they will keep kicking each other off. Polling continues quietly.",
            );
          }
          if (conflicts < 3) warn("telegram", `poll conflict (another getUpdates active) — retry in ${backoff / 1000}s`);
        } else {
          warn("telegram", `poll error: ${msg} — retry in ${backoff / 1000}s`);
        }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  private async downloadFile(fileId: string, hintName: string, chatKey: string): Promise<{ path: string; name: string; size: number }> {
    const f = await this.api<{ file_path: string; file_size?: number }>("getFile", { file_id: fileId }, 15_000);
    const buf = await download(`${API}/file/bot${this.cfg.token}/${f.file_path}`, { proxy: this.proxy, timeoutMs: 120_000 });
    const dir = join(PATHS.inbox, chatKey.replace(/[^A-Za-z0-9_.-]/g, "_"));
    mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${basename(hintName || f.file_path)}`;
    const p = join(dir, name);
    writeFileSync(p, buf);
    return { path: p, name: hintName || basename(f.file_path), size: buf.length };
  }

  private async handleMessage(msg: TgMessage): Promise<void> {
    const chatId = String(msg.chat.id);
    const userId = String(msg.from?.id ?? chatId);
    const userName = msg.from?.username ?? msg.from?.first_name;
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    let text = (msg.text ?? msg.caption ?? "").trim();
    if (isGroup && this.botName) {
      text = text.replace(new RegExp(`@${this.botName}\\b`, "gi"), "").trim();
    }

    const files: { path: string; name: string; size: number }[] = [];
    const fileId =
      msg.document?.file_id ??
      msg.voice?.file_id ??
      msg.audio?.file_id ??
      msg.video?.file_id ??
      (msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : undefined);
    if (fileId) {
      const hint =
        msg.document?.file_name ?? msg.audio?.file_name ?? msg.video?.file_name ??
        (msg.photo ? "photo.jpg" : msg.voice ? "voice.ogg" : "file.bin");
      try {
        files.push(await this.downloadFile(fileId, hint, `telegram:${chatId}`));
      } catch (e) {
        warn("telegram", "file download failed:", e);
        text += `\n[附件下载失败: ${e instanceof Error ? e.message : e}]`;
      }
    }

    if (!text && !files.length) return;
    // typing indicator — best-effort, covers the agent's thinking time
    this.api("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    this.onMessage({
      channel: this.name,
      chatId,
      userId,
      userName,
      text,
      messageId: String(msg.message_id),
      files: files.length ? files : undefined,
      isGroup,
    });
  }

  async sendText(chatId: string, text: string): Promise<void> {
    // markdown rendering is on by default (parse_mode HTML); any send that
    // the API rejects falls back to plain text for that chunk
    const useMd = this.cfg.markdown !== false;
    for (const chunk of chunkText(text, MAX_MSG)) {
      if (useMd) {
        try {
          await this.api("sendMessage", {
            chat_id: chatId,
            text: toTelegramHtml(chunk),
            parse_mode: "HTML",
            disable_web_page_preview: true,
          });
          continue;
        } catch (e) {
          warn("telegram", `markdown send failed, retrying as plain text: ${e instanceof Error ? e.message : e}`);
        }
      }
      await this.api("sendMessage", { chat_id: chatId, text: chunk, disable_web_page_preview: true });
    }
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    const { readFileSync } = await import("node:fs");
    const data = readFileSync(filePath);
    const name = basename(filePath);
    const isImage = /\.(png|jpe?g|gif|webp)$/i.test(name);
    const method = isImage ? "sendPhoto" : "sendDocument";
    const { body, contentType } = multipart(
      { chat_id: chatId, ...(caption ? { caption: caption.slice(0, 1024) } : {}) },
      { field: isImage ? "photo" : "document", filename: name, contentType: "application/octet-stream", data },
    );
    const res = await httpRequest(this.apiUrl(method), {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
      proxy: this.proxy,
      timeoutMs: 120_000,
    });
    const parsed = JSON.parse(res.body.toString("utf8"));
    if (!parsed.ok) throw new Error(`Telegram ${method}: ${parsed.description ?? res.status}`);
  }
}
