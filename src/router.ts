/**
 * Router — the hub. Channels push inbound events here; the router owns
 * sessions, runs the agent loop per chat (aborting a stale run when the user
 * sends a new message), and delivers replies back. Also: owner pairing,
 * cron delivery, MCP tool wiring, the messaging bridge.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getConfig, loadConfig, PATHS, watchConfig, type Config } from "./core/config.ts";
import { approveCode, loadPending, PAIR_RENOTIFY, savePending, upsertPending } from "./core/pairing.ts";
import { createDeepSeekStream } from "./core/deepseek.ts";
import { runAgent } from "./core/agent.ts";
import { SessionStore } from "./core/session.ts";
import { buildSystemPrompt } from "./core/persona.ts";
import { Queue } from "./core/net.ts";
import { log, warn } from "./core/log.ts";
import type { Channel, InboundEvent, Msg, StreamFn, ToolDef } from "./core/types.ts";
import { TelegramChannel } from "./channels/telegram.ts";
import { QQChannel } from "./channels/qq.ts";
import { shellTool } from "./tools/shell.ts";
import { editFileTool, grepTool, listDirTool, readFileTool, writeFileTool } from "./tools/files.ts";
import { memoryReadTool, memorySearchTool, memoryWriteTool } from "./tools/memory.ts";
import { fetchUrlTool, webSearchTool } from "./tools/web.ts";
import { browserTool } from "./tools/browser.ts";
import { CronService, makeCronTool, type CronTask } from "./tools/cron.ts";
import { makeMessagingTools, type MessagingBridge } from "./tools/messaging.ts";
import { McpManager } from "./tools/mcp.ts";

interface ChatEntry {
  chatKey: string;
  channel: string;
  chatId: string;
  hint?: string;
}

export class Router implements MessagingBridge {
  private cfg: Config;
  private streamFn: StreamFn;
  private sessions: SessionStore;
  private channels = new Map<string, Channel>();
  private queues = new Map<string, Queue>();
  private running = new Map<string, AbortController>();
  private cron!: CronService;
  private mcp = new McpManager();
  private tools: ToolDef[] = [];
  private chats = new Map<string, ChatEntry>();
  private chatsFile = joinData("chats.json");

  async init(): Promise<void> {
    this.cfg = loadConfig();
    mkdirSync(PATHS.data, { recursive: true });
    if (!this.cfg.deepseek.apiKey) throw new Error("deepseek.apiKey not set in ani.json");
    this.streamFn = createDeepSeekStream({
      apiKey: this.cfg.deepseek.apiKey,
      baseUrl: this.cfg.deepseek.baseUrl,
      thinking: this.cfg.thinking,
    });
    this.sessions = new SessionStore(PATHS.sessions, this.cfg.maxContextChars);
    this.loadChats();

    // tools: static set + cron + messaging + MCP
    this.cron = new CronService((task) => this.runCronTask(task));
    this.tools = [
      shellTool,
      readFileTool, writeFileTool, editFileTool, listDirTool, grepTool,
      memoryWriteTool, memorySearchTool, memoryReadTool,
      webSearchTool, fetchUrlTool,
      browserTool,
      makeCronTool(this.cron),
      ...makeMessagingTools(this),
    ];
    const mcpTools = await this.mcp.init(this.cfg.mcpServers, this.cfg.proxy);
    this.tools.push(...mcpTools);

    // channels
    if (this.cfg.channels.telegram?.enabled) {
      const tg = new TelegramChannel(this.cfg.channels.telegram, (e) => void this.handleInbound(e));
      this.channels.set("telegram", tg);
    }
    if (this.cfg.channels.qq?.enabled) {
      const qq = new QQChannel(this.cfg.channels.qq, (e) => void this.handleInbound(e));
      this.channels.set("qq", qq);
    }
    for (const ch of this.channels.values()) {
      try {
        await ch.start();
      } catch (e) {
        warn("router", `${ch.name} failed to start: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.cron.start();

    // reload owners when ani.json changes (e.g. `node ani.ts approve ...`)
    watchConfig((cfg) => {
      this.cfg = cfg;
      for (const [name, ch] of this.channels) {
        const fresh = name === "telegram" ? cfg.channels.telegram : cfg.channels.qq;
        if (fresh && ch instanceof TelegramChannel) (ch as any).cfg.owners = fresh.owners;
        if (fresh && ch instanceof QQChannel) (ch as any).cfg.owners = fresh.owners;
      }
    });
  }

  async shutdown(): Promise<void> {
    this.cron.stop();
    this.mcp.close();
    for (const ch of this.channels.values()) await ch.stop().catch(() => {});
  }

  model(): string {
    return this.cfg.model;
  }

  channelNames(): string[] {
    return [...this.channels.keys()];
  }

  // -------------------------------------------------------------- inbound

  private queueFor(chatKey: string): Queue {
    let q = this.queues.get(chatKey);
    if (!q) {
      q = new Queue();
      this.queues.set(chatKey, q);
    }
    return q;
  }

  private async handleInbound(evt: InboundEvent): Promise<void> {
    const channel = this.channels.get(evt.channel);
    if (!channel) return;
    const chatKey = `${evt.channel}:${evt.chatId}`;

    if (!channel.isOwner(evt.userId)) {
      await this.handlePairing(channel, evt);
      return;
    }

    this.rememberChat(chatKey, evt.channel, evt.chatId, evt.userName ?? evt.userId);

    let text = evt.text;
    if (evt.files?.length) {
      const lines = evt.files.map((f) => `[收到文件] ${f.name} (${f.size} bytes) 已保存到 ${f.path}`);
      text = text ? `${text}\n\n${lines.join("\n")}` : lines.join("\n");
    }
    if (evt.isGroup && evt.userName) text = `${evt.userName}: ${text}`;
    if (!text.trim()) return;

    // abort any stale run for this chat — newest message wins
    this.running.get(chatKey)?.abort();
    void this.queueFor(chatKey).push(() => this.runChat(chatKey, text));
  }

  private async handlePairing(channel: Channel, evt: InboundEvent): Promise<void> {
    const p = upsertPending({ channel: evt.channel, userId: evt.userId, chatId: evt.chatId, userName: evt.userName });
    log("router", `unauthorized ${evt.channel} user ${evt.userId} (${evt.userName ?? "?"}) — pairing code ${p.code}`);
    const now = Date.now();
    if (now - p.lastNotifiedAt > PAIR_RENOTIFY) {
      p.lastNotifiedAt = now;
      const pending = loadPending();
      const rec = pending.find((x) => x.code === p.code);
      if (rec) {
        rec.lastNotifiedAt = now;
        savePending(pending);
      }
      try {
        await channel.sendText(
          evt.chatId,
          `我是 Ani，主人的私人 Agent。你还不是我的主人。\n如果这是主人的账号，让主人在 ani 终端输入:\n/approve ${p.code}`,
        );
      } catch (e) {
        warn("router", "pairing reply failed:", e);
      }
    }
  }

  /** Approve a pairing code. Works in-process (CLI slash command). */
  approve(code: string): string {
    const p = approveCode(code);
    if (!p) return `no pending pairing with code ${code}`;
    this.cfg = loadConfig();
    const ch = this.channels.get(p.channel);
    ch?.addOwner(p.userId);
    void ch?.sendText(p.chatId, "配对成功！你现在是我的主人了。有什么吩咐？").catch(() => {});
    log("router", `approved ${p.channel} user ${p.userId}`);
    return `approved ${p.channel}:${p.userId}${p.userName ? ` (${p.userName})` : ""}`;
  }

  // ------------------------------------------------------------ agent run

  private async runChat(chatKey: string, userText: string): Promise<void> {
    const controller = new AbortController();
    this.running.set(chatKey, controller);
    const [channelName, chatId] = splitChatKey(chatKey);
    try {
      this.sessions.append(chatKey, { role: "user", content: userText, _meta: { ts: Date.now() } });
      await this.sessions.maybeCompact(chatKey, this.streamFn, this.cfg.model);

      const system: Msg = { role: "system", content: buildSystemPrompt() };
      const history = this.sessions.get(chatKey);
      const wire: Msg[] = [system, ...history];
      const before = wire.length;

      const result = await runAgent({
        messages: wire,
        tools: this.tools,
        streamFn: this.streamFn,
        model: this.cfg.model,
        signal: controller.signal,
        ctx: {
          chatKey,
          channel: channelName,
          chatId,
          cwd: PATHS.root,
          signal: controller.signal,
        },
      });

      for (const m of wire.slice(before)) this.sessions.append(chatKey, m);

      const reply = result.text.trim();
      if (!reply) return;
      if (result.aborted) return; // superseded by a newer message — stay silent
      await this.deliver(chatKey, reply);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn("router", `runChat ${chatKey} failed: ${msg}`);
      if (!controller.signal.aborted) {
        await this.deliver(chatKey, `出错了: ${msg.slice(0, 300)}`).catch(() => {});
      }
    } finally {
      this.running.delete(chatKey);
    }
  }

  private async deliver(chatKey: string, text: string): Promise<void> {
    const [channelName, chatId] = splitChatKey(chatKey);
    if (channelName === "cli") {
      process.stdout.write(`\nani> ${text}\n\n`);
      return;
    }
    const ch = this.channels.get(channelName);
    if (!ch) throw new Error(`channel ${channelName} not connected`);
    await ch.sendText(chatId, text);
  }

  // ------------------------------------------------------------------ cron

  private async runCronTask(task: CronTask): Promise<void> {
    const chatKey = `cron:${task.id}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
    try {
      this.sessions.append(chatKey, {
        role: "user",
        content: `[定时任务触发] ${task.prompt}`,
        _meta: { ts: Date.now(), internal: true },
      });
      await this.sessions.maybeCompact(chatKey, this.streamFn, this.cfg.model);
      const wire: Msg[] = [{ role: "system", content: buildSystemPrompt() }, ...this.sessions.get(chatKey)];
      const before = wire.length;
      const [targetChannel] = splitChatKey(task.target);
      const result = await runAgent({
        messages: wire,
        tools: this.tools,
        streamFn: this.streamFn,
        model: this.cfg.model,
        signal: controller.signal,
        ctx: { chatKey, channel: "cron", chatId: task.id, cwd: PATHS.root, signal: controller.signal },
      });
      for (const m of wire.slice(before)) this.sessions.append(chatKey, m);
      const text = result.text.trim() || "(任务完成，无输出)";
      task.lastResult = text.slice(0, 200);
      if (task.target && this.channels.has(targetChannel)) {
        await this.deliver(task.target, `⏰ ${task.name}\n\n${text}`);
      } else {
        process.stdout.write(`\n[cron ${task.name}]\n${text}\n\n`);
      }
    } catch (e) {
      warn("cron", `task ${task.name} error: ${e instanceof Error ? e.message : e}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  // ------------------------------------------------------ MessagingBridge

  listChats(): ChatEntry[] {
    const out = [...this.chats.values()];
    if (!out.some((c) => c.chatKey === "cli:local")) {
      out.push({ chatKey: "cli:local", channel: "cli", chatId: "local", hint: "terminal" });
    }
    return out;
  }

  async sendText(chatKey: string, text: string): Promise<void> {
    this.rememberChat(chatKey, ...splitChatKey(chatKey));
    await this.deliver(chatKey, text);
  }

  async sendFile(chatKey: string, filePath: string, caption?: string): Promise<void> {
    const [channelName, chatId] = splitChatKey(chatKey);
    if (channelName === "cli") {
      process.stdout.write(`[file for you] ${filePath}${caption ? ` — ${caption}` : ""}\n`);
      return;
    }
    const ch = this.channels.get(channelName);
    if (!ch) throw new Error(`channel ${channelName} not connected`);
    await ch.sendFile(chatId, filePath, caption);
  }

  /** Used by the CLI to run a local turn (streaming to stdout). */
  async runCliTurn(text: string, onDelta: (d: string) => void, onTool: (name: string, ok: boolean, preview: string) => void): Promise<string> {
    const chatKey = "cli:local";
    this.sessions.append(chatKey, { role: "user", content: text, _meta: { ts: Date.now() } });
    await this.sessions.maybeCompact(chatKey, this.streamFn, this.cfg.model);
    const wire: Msg[] = [{ role: "system", content: buildSystemPrompt() }, ...this.sessions.get(chatKey)];
    const before = wire.length;
    const result = await runAgent({
      messages: wire,
      tools: this.tools,
      streamFn: this.streamFn,
      model: this.cfg.model,
      ctx: { chatKey, channel: "cli", chatId: "local", cwd: PATHS.root },
      events: {
        onTextDelta: onDelta,
        onToolStart: (name) => process.stdout.write(`\n\x1b[90m⚙ ${name}...\x1b[0m`),
        onToolEnd: (name, ok, preview) => onTool(name, ok, preview),
      },
    });
    for (const m of wire.slice(before)) this.sessions.append(chatKey, m);
    return result.text;
  }

  resetSession(chatKey: string): void {
    this.sessions.reset(chatKey);
  }

  // ------------------------------------------------------------- registry

  private rememberChat(chatKey: string, channel: string, chatId: string, hint?: string): void {
    if (this.chats.has(chatKey)) return;
    this.chats.set(chatKey, { chatKey, channel, chatId, hint });
    try {
      writeFileSync(this.chatsFile, JSON.stringify([...this.chats.values()], null, 2));
    } catch {
      /* non-fatal */
    }
  }

  private loadChats(): void {
    try {
      if (existsSync(this.chatsFile)) {
        for (const c of JSON.parse(readFileSync(this.chatsFile, "utf8")) as ChatEntry[]) {
          this.chats.set(c.chatKey, c);
        }
      }
    } catch {
      /* start empty */
    }
  }
}

function splitChatKey(chatKey: string): [string, string] {
  const i = chatKey.indexOf(":");
  return i === -1 ? [chatKey, ""] : [chatKey.slice(0, i), chatKey.slice(i + 1)];
}

function joinData(name: string): string {
  return `${PATHS.data}/${name}`;
}
