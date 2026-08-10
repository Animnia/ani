/**
 * Router — the hub. Channels push inbound events here; the router owns
 * sessions, runs the agent loop per chat (aborting a stale run when the user
 * sends a new message), and delivers replies back. Also: owner pairing,
 * cron delivery, MCP tool wiring, the messaging bridge.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, PATHS, watchConfig, type Config } from "./core/config.ts";
import { approveCode, loadPending, PAIR_RENOTIFY, savePending, upsertPending } from "./core/pairing.ts";
import { sweepDataDirs } from "./core/janitor.ts";
import { createDeepSeekStream } from "./core/deepseek.ts";
import { runAgent } from "./core/agent.ts";
import { SessionStore } from "./core/session.ts";
import { buildSystemPrompt } from "./core/persona.ts";
import { listSkills, setSkillEnabled, skillDirs, type SkillStatus } from "./core/skills.ts";
import { Queue } from "./core/net.ts";
import { log, warn } from "./core/log.ts";
import type { Channel, InboundEvent, Msg, StreamFn, ToolDef } from "./core/types.ts";
import { TelegramChannel } from "./channels/telegram.ts";
import { QQChannel } from "./channels/qq.ts";
import { shellTool } from "./tools/shell.ts";
import { editFileTool, grepTool, listDirTool, readFileTool, writeFileTool } from "./tools/files.ts";
import { memoryReadTool, memorySearchTool, memoryWriteTool, userProfileTool } from "./tools/memory.ts";
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
  /** per-chat token usage ledger (in-memory; provider-reported, exact) */
  private usageLedger = new Map<string, { prompt: number; completion: number; calls: number }>();
  /** test hook: redirect pairing file writes away from the real ani.json */
  private pairOpts?: { pendingFile?: string; configFile?: string };

  /** opts are test hooks: inject a fake streamFn / skip real channel startup /
   *  redirect pairing files / redirect state (sessions, chats) — tests must
   *  never write into the real data/ dir */
  async init(opts?: {
    streamFn?: StreamFn;
    skipChannels?: boolean;
    pairOpts?: { pendingFile?: string; configFile?: string };
    stateDir?: string;
  }): Promise<void> {
    this.pairOpts = opts?.pairOpts;
    if (opts?.stateDir) {
      this.chatsFile = join(opts.stateDir, "chats.json");
    }
    this.cfg = loadConfig();
    mkdirSync(PATHS.data, { recursive: true });
    if (!opts?.stateDir) sweepDataDirs(); // skip janitor under redirected state (tests)
    if (!opts?.streamFn && !this.cfg.deepseek.apiKey) throw new Error("deepseek.apiKey not set in ani.json");
    this.streamFn =
      opts?.streamFn ??
      createDeepSeekStream({
        apiKey: this.cfg.deepseek.apiKey,
        baseUrl: this.cfg.deepseek.baseUrl,
        thinking: this.cfg.thinking,
      });
    this.sessions = new SessionStore(opts?.stateDir ? join(opts.stateDir, "sessions") : PATHS.sessions, this.cfg.maxContextChars);
    this.loadChats();

    // tools: static set + cron + messaging + MCP
    this.cron = new CronService((task) => this.runCronTask(task));
    this.tools = [
      shellTool,
      readFileTool, writeFileTool, editFileTool, listDirTool, grepTool,
      memoryWriteTool, memorySearchTool, memoryReadTool, userProfileTool,
      webSearchTool, fetchUrlTool,
      browserTool,
      makeCronTool(this.cron),
      ...makeMessagingTools(this),
    ];
    const mcpTools = await this.mcp.init(this.cfg.mcpServers, this.cfg.proxy);
    this.tools.push(...mcpTools);

    // channels
    if (!opts?.skipChannels) {
      if (this.cfg.channels.telegram?.enabled) {
        this.registerChannel(new TelegramChannel(this.cfg.channels.telegram, (e) => void this.handleInbound(e)));
      }
      if (this.cfg.channels.qq?.enabled) {
        this.registerChannel(new QQChannel(this.cfg.channels.qq, (e) => void this.handleInbound(e)));
      }
      for (const ch of this.channels.values()) {
        try {
          await ch.start();
        } catch (e) {
          warn("router", `${ch.name} failed to start: ${e instanceof Error ? e.message : e}`);
        }
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

  /** Register a channel (used by init and by tests injecting fakes). */
  registerChannel(ch: Channel): void {
    this.channels.set(ch.name, ch);
  }

  async shutdown(): Promise<void> {
    this.cron.stop();
    this.mcp.close();
    for (const ch of this.channels.values()) await ch.stop().catch(() => {});
  }

  private recordUsage(chatKey: string, u?: { prompt: number; completion: number }): void {
    if (!u) return;
    const cur = this.usageLedger.get(chatKey) ?? { prompt: 0, completion: 0, calls: 0 };
    cur.prompt += u.prompt;
    cur.completion += u.completion;
    cur.calls++;
    this.usageLedger.set(chatKey, cur);
  }

  /** Snapshot for the CLI /status command. */
  sessionStatus(chatKey: string): {
    messages: number;
    chars: number;
    maxChars: number;
    compactions: number;
    usage: { prompt: number; completion: number; calls: number } | null;
    model: string;
    thinking: string;
  } {
    return {
      messages: this.sessions.get(chatKey).length,
      chars: this.sessions.size(chatKey),
      maxChars: this.cfg.maxContextChars,
      compactions: this.sessions.compactions(chatKey),
      usage: this.usageLedger.get(chatKey) ?? null,
      model: this.cfg.model,
      thinking: this.cfg.thinking ?? "enabled",
    };
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

    // in-channel slash commands (owner-only — we passed the gate above).
    // Only KNOWN commands are intercepted; other "/..." text (linux paths,
    // model shorthand) flows to the agent as usual.
    if (evt.text.trim().startsWith("/")) {
      const reply = this.channelCommand(chatKey, evt.text.trim());
      if (reply !== null) {
        await channel.sendText(evt.chatId, reply);
        return;
      }
    }

    let text = evt.text;
    if (evt.files?.length) {
      const lines = evt.files.map((f) => `[收到文件] ${f.name} (${f.size} bytes) 已保存到 ${f.path}`);
      text = text ? `${text}\n\n${lines.join("\n")}` : lines.join("\n");
    }
    if (evt.isGroup && evt.userName) text = `${evt.userName}: ${text}`;
    if (!text.trim()) return;

    // abort any stale run for this chat — newest message wins
    this.running.get(chatKey)?.abort();
    void this.queueFor(chatKey).push(() => this.runChat(chatKey, text, { isGroup: evt.isGroup === true }));
  }

  private async handlePairing(channel: Channel, evt: InboundEvent): Promise<void> {
    // never run the pairing flow in group chats: the code would be visible
    // to every member, and the reply spam is rude. Log only; pairing
    // happens in DM.
    if (evt.isGroup) {
      log("router", `ignoring non-owner ${evt.userId} in group ${evt.chatId} (pairing via DM only)`);
      return;
    }
    const pf = this.pairOpts?.pendingFile;
    const p = upsertPending({ channel: evt.channel, userId: evt.userId, chatId: evt.chatId, userName: evt.userName }, pf);
    log("router", `unauthorized ${evt.channel} user ${evt.userId} (${evt.userName ?? "?"}) — pairing code ${p.code}`);
    const now = Date.now();
    if (now - p.lastNotifiedAt > PAIR_RENOTIFY) {
      p.lastNotifiedAt = now;
      const pending = loadPending(pf);
      const rec = pending.find((x) => x.code === p.code);
      if (rec) {
        rec.lastNotifiedAt = now;
        savePending(pending, pf);
      }
      try {
        await channel.sendText(
          evt.chatId,
          `我是 Ani，主人的私人 Agent。你还不是我的主人。\n如果这是主人的账号，让主人在装了 ani 的终端运行:\n  ani approve ${p.code}\n（若提示找不到 ani 命令，用完整路径：node ${PATHS.root}ani.ts approve ${p.code}；或在 ani 的交互终端里输入 /approve ${p.code}）\n配对码 30 分钟内有效，过期后重新发消息会生成新码。`,
        );
      } catch (e) {
        warn("router", "pairing reply failed:", e);
      }
    }
  }

  /** Slash commands available inside QQ/Telegram chats. Returns the reply
   *  text, or null when the text isn't a known command (pass to agent). */
  private channelCommand(chatKey: string, text: string): string | null {
    const [cmd] = text.slice(1).split(/\s+/);
    switch (cmd) {
      case "help":
        return [
          "可用命令：",
          "/new     开启全新会话（旧会话归档保留）",
          "/status  会话状态：消息数 / 上下文 / token 用量",
          "/chats   列出已知会话",
          "/model   查看当前模型",
          "/skills [on|off <名>]  查看 / 启用 / 禁用技能",
          "/show <memory|user|persona>  查看记忆 / 用户资料 / 人设文件",
          "/help    本帮助",
          "其它内容直接发给 ani 即可。",
        ].join("\n");
      case "new":
        this.resetSession(chatKey);
        return "新会话已开始（旧会话已归档）🌱";
      case "status": {
        const s = this.sessionStatus(chatKey);
        const pct = s.maxChars ? Math.round((s.chars / s.maxChars) * 100) : 0;
        return [
          `会话 ${chatKey}`,
          `消息 ${s.messages} 条 · 上下文 ${s.chars.toLocaleString()}/${s.maxChars.toLocaleString()} 字符 (${pct}%) · 压缩 ${s.compactions} 次`,
          s.usage
            ? `token：${s.usage.prompt.toLocaleString()} in / ${s.usage.completion.toLocaleString()} out（本次进程 ${s.usage.calls} 次调用）`
            : "token：本次进程还没有 API 调用",
          `模型 ${s.model} · thinking ${s.thinking}`,
        ].join("\n");
      }
      case "chats":
        return this.listChats().map((c) => `${c.chatKey}${c.hint ? `（${c.hint}）` : ""}`).join("\n");
      case "model":
        return `当前模型：${this.cfg.model}（改 ani.json 的 model 字段即热更新）`;
      case "skills": {
        const arg = text.split(/\s+/).slice(1);
        if (arg.length === 2 && (arg[0] === "on" || arg[0] === "off")) return this.skillToggle(arg[1], arg[0] === "on");
        return this.skillsOverview();
      }
      case "show": {
        const which = text.split(/\s+/)[1] ?? "";
        return this.showFile(which);
      }
      default:
        return null; // not a known command — treat as normal text
    }
  }

  /** /skills — auto-detected skills with on/off state. */
  skillsOverview(): string {
    const list = listSkills(skillDirs());
    if (!list.length) return "没有发现任何 skill（项目 skills/ 与 ~/.agents/skills 都为空）";
    const lines = list.map(
      (s: SkillStatus) =>
        `${s.enabled ? "✓" : "✗"} ${s.name}（${s.scope === "project" ? "项目" : "全局"}）— ${s.description}`,
    );
    return ["skills（每次对话自动重扫，新 skill 即刻被发现）:", ...lines, "切换: /skills off <名字> · /skills on <名字>"].join("\n");
  }

  skillToggle(name: string, enabled: boolean): string {
    if (!setSkillEnabled(skillDirs(), name, enabled)) return `没有找到名为 "${name}" 的 skill（/skills 查看全部）`;
    return `${enabled ? "✓ 已启用" : "✗ 已禁用"} skill：${name}（下一条消息生效）`;
  }

  /** /show — quick peek at the memory / user-profile / persona files. */
  showFile(which: string): string {
    const map: Record<string, { label: string; path: string }> = {
      memory: { label: "长期记忆", path: PATHS.memoryFile },
      user: { label: "用户资料", path: PATHS.userFile },
      persona: { label: "人设", path: PATHS.personaFile },
    };
    const hit = map[which];
    if (!hit) {
      return [
        "用法: /show <memory|user|persona>",
        ...Object.entries(map).map(([k, v]) => `  ${k.padEnd(8)} ${v.label} → ${v.path}`),
      ].join("\n");
    }
    let content = "(空)";
    let size = 0;
    try {
      if (existsSync(hit.path)) {
        content = readFileSync(hit.path, "utf8");
        size = Buffer.byteLength(content);
        content = content.trim() || "(空)";
        if (content.length > 8000) content = content.slice(0, 8000) + "\n…（截断，完整见文件）";
      }
    } catch (e) {
      content = `(读取失败: ${e instanceof Error ? e.message : e})`;
    }
    return `${hit.label} → ${hit.path}（${size} 字节）\n\n${content}`;
  }

  /** Approve a pairing code. Works in-process (CLI slash command). */
  approve(code: string): string {
    const p = approveCode(code, this.pairOpts);
    if (!p) return `no pending pairing with code ${code}`;
    this.cfg = loadConfig();
    const ch = this.channels.get(p.channel);
    ch?.addOwner(p.userId);
    void ch?.sendText(p.chatId, "配对成功！你现在是我的主人了。有什么吩咐？").catch(() => {});
    log("router", `approved ${p.channel} user ${p.userId}`);
    return `approved ${p.channel}:${p.userId}${p.userName ? ` (${p.userName})` : ""}`;
  }

  // ------------------------------------------------------------ agent run

  private async runChat(chatKey: string, userText: string, opts?: { isGroup?: boolean }): Promise<void> {
    const controller = new AbortController();
    this.running.set(chatKey, controller);
    const [channelName, chatId] = splitChatKey(chatKey);
    try {
      this.sessions.append(chatKey, { role: "user", content: userText, _meta: { ts: Date.now() } });
      await this.sessions.maybeCompact(chatKey, this.streamFn, this.cfg.model);

      let prompt = buildSystemPrompt();
      if (opts?.isGroup) {
        // privacy guard: group replies are visible to every member — the
        // agent must not spill memory/files/personal data there
        prompt +=
          "\n\n<group_chat_notice>\nThis message came from a GROUP chat. Everyone in the group can read your replies. " +
          "Do NOT reveal private data here: no memory contents, file contents, personal info, credentials, system paths/details beyond the obvious. " +
          "If fulfilling the request needs private data, say so and ask the owner to continue in a private chat (DM) instead. Keep group replies short.\n</group_chat_notice>";
      }
      const system: Msg = { role: "system", content: prompt };
      const history = this.sessions.get(chatKey);
      const wire: Msg[] = [system, ...history];
      const before = wire.length;

      const result = await runAgent({
        messages: wire,
        tools: this.tools,
        streamFn: this.streamFn,
        model: this.cfg.model,
        maxTokens: this.cfg.maxTokens,
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
      this.recordUsage(chatKey, result.usage);

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
      // defensive: only remove if this run is still the registered one
      if (this.running.get(chatKey) === controller) this.running.delete(chatKey);
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
      const [targetChannel, targetChatId] = splitChatKey(task.target);
      const result = await runAgent({
        messages: wire,
        tools: this.tools,
        streamFn: this.streamFn,
        model: this.cfg.model,
        maxTokens: this.cfg.maxTokens,
        signal: controller.signal,
        // ctx points at the DELIVERY TARGET (not the cron session) so that
        // send_message/send_file without an explicit chatKey land where the
        // report goes — previously they errored on the unknown "cron" channel
        ctx: { chatKey: task.target, channel: targetChannel, chatId: targetChatId, cwd: PATHS.root, signal: controller.signal },
      });
      for (const m of wire.slice(before)) this.sessions.append(chatKey, m);
      this.recordUsage(chatKey, result.usage);
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
  async runCliTurn(
    text: string,
    onDelta: (d: string) => void,
    onTool: (name: string, ok: boolean, preview: string) => void,
    onToolStart?: (name: string) => void,
    onReasoning?: (d: string) => void,
  ): Promise<string> {
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
      maxTokens: this.cfg.maxTokens,
      ctx: { chatKey, channel: "cli", chatId: "local", cwd: PATHS.root },
      events: {
        onTextDelta: onDelta,
        onReasoningDelta: onReasoning,
        onToolStart: onToolStart ?? ((name) => process.stdout.write(`\n\x1b[90m⚙ ${name}...\x1b[0m`)),
        onToolEnd: (name, ok, preview) => onTool(name, ok, preview),
      },
    });
    for (const m of wire.slice(before)) this.sessions.append(chatKey, m);
    this.recordUsage(chatKey, result.usage);
    return result.text;
  }

  resetSession(chatKey: string): void {
    this.sessions.reset(chatKey, { archive: true });
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
