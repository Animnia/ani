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
import { createDeepSeekStream, detectImageMime } from "./core/deepseek.ts";
import { runAgent } from "./core/agent.ts";
import { SessionStore } from "./core/session.ts";
import { buildSystemPrompt } from "./core/persona.ts";
import { listSkills, setSkillEnabled, skillDirs, type SkillStatus } from "./core/skills.ts";
import { Queue } from "./core/net.ts";
import { log, warn } from "./core/log.ts";
import type { Channel, ImageInput, InboundEvent, Msg, StreamFn, ToolDef } from "./core/types.ts";
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
import { ToolPolicy, type ToolMode } from "./core/tool-policy.ts";

interface ChatEntry {
  chatKey: string;
  channel: string;
  chatId: string;
  hint?: string;
  /** true = public group, false = verified private, undefined = legacy/unknown.
   *  Unknown is always treated as public by background delivery paths. */
  isGroup?: boolean;
}

export class Router implements MessagingBridge {
  private cfg: Config;
  private streamFn: StreamFn;
  private sessions: SessionStore;
  private channels = new Map<string, Channel>();
  private queues = new Map<string, Queue>();
  private running = new Map<string, AbortController>();
  /** Monotonic per-chat generation. Queued/running turns from an older
   *  generation are discarded when a newer message or /new arrives. */
  private generations = new Map<string, number>();
  private cron!: CronService;
  private mcp = new McpManager();
  private toolPolicy = new ToolPolicy();
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

  /** Invalidate pending work and cancel the active run for this chat. */
  private nextGeneration(chatKey: string, preserveApprovalToken?: string): number {
    this.toolPolicy.invalidate(chatKey, preserveApprovalToken);
    const generation = (this.generations.get(chatKey) ?? 0) + 1;
    this.generations.set(chatKey, generation);
    this.running.get(chatKey)?.abort();
    return generation;
  }

  private isCurrent(chatKey: string, generation: number): boolean {
    return this.generations.get(chatKey) === generation;
  }

  private authorizeTools(chatKey: string, mode: ToolMode, attemptId: string) {
    return (toolName: string, args: Record<string, unknown>) =>
      this.toolPolicy.authorize(chatKey, mode, toolName, args, attemptId);
  }

  private async handleInbound(evt: InboundEvent): Promise<void> {
    const channel = this.channels.get(evt.channel);
    if (!channel) return;
    const chatKey = `${evt.channel}:${evt.chatId}`;

    if (!channel.isOwner(evt.userId)) {
      await this.handlePairing(channel, evt);
      return;
    }

    this.rememberChat(chatKey, evt.channel, evt.chatId, evt.userName ?? evt.userId, evt.isGroup === true);

    // in-channel slash commands (owner-only — we passed the gate above).
    // Only KNOWN commands are intercepted; other "/..." text (linux paths,
    // model shorthand) flows to the agent as usual.
    let text = evt.text;
    let generation: number | undefined;
    const commandText = text.trim();
    if (commandText.startsWith("/")) {
      const [command, arg = ""] = commandText.slice(1).split(/\s+/);
      if (command === "confirm") {
        if (evt.isGroup) {
          await channel.sendText(evt.chatId, "群聊中不能批准高权限操作，请在私聊中继续。");
          return;
        }
        if (!this.toolPolicy.canConfirm(chatKey, arg)) {
          await channel.sendText(evt.chatId, "确认码无效、已过期，或不属于当前会话。请重新发起操作。");
          return;
        }
        generation = this.nextGeneration(chatKey, arg);
        const approval = this.toolPolicy.confirm(chatKey, arg, String(generation));
        if (!approval) return; // synchronous defensive check
        // Let the model resume from the denied tool result already in history.
        // The grant is bound to this generation + exact arguments + one use.
        text = `[Owner confirmed code-verified ${approval.toolName} with /confirm ${arg}. Retry only the exact same tool call now.]`;
      } else if (command === "new") {
        // /new is a chat barrier: invalidate the active generation now, then
        // reset and acknowledge inside the same queue. A following message
        // therefore cannot race ahead of the reset.
        try {
          await this.queueReset(chatKey, () =>
            channel.sendText(evt.chatId, "新会话已开始（旧会话已归档）🌱").catch((e) => {
              warn("router", `reset acknowledgement ${chatKey} failed: ${e instanceof Error ? e.message : e}`);
            }),
          );
        } catch (e) {
          warn("router", `reset ${chatKey} failed: ${e instanceof Error ? e.message : e}`);
          await channel.sendText(evt.chatId, "旧会话归档失败，已取消重置；历史仍完整保留。请检查本地日志后重试。").catch(() => {});
        }
        return;
      } else {
        // Any owner intent other than the exact /confirm revokes stale codes.
        this.toolPolicy.invalidate(chatKey);
        const reply = this.channelCommand(chatKey, commandText, { isGroup: evt.isGroup === true });
        if (reply !== null) {
          await channel.sendText(evt.chatId, reply);
          return;
        }
      }
    }

    const attachments = (evt.files ?? []).map((file) => ({ ...file, mime: detectInboundImage(file.path) }));
    const images: ImageInput[] = attachments
      .filter((file) => file.mime !== null)
      .map((file) => ({ path: file.path, detail: "auto" }));
    if (attachments.length) {
      const lines = attachments.map((file) => {
        const kind = file.mime ? "图片" : "文件";
        return evt.isGroup
          ? `[收到${kind}] ${file.name} (${file.size} bytes)`
          : `[收到${kind}] ${file.name} (${file.size} bytes) 已保存到 ${file.path}`;
      });
      if (!text.trim() && images.length) text = "请识别并描述我发来的图片。";
      text = text ? `${text}\n\n${lines.join("\n")}` : lines.join("\n");
    }
    if (evt.isGroup && evt.userName) text = `${evt.userName}: ${text}`;
    if (!text.trim()) return;

    // Invalidate both the active run and older queued turns. The generation
    // check at task start makes newest-wins hold even for synchronous bursts.
    generation ??= this.nextGeneration(chatKey);
    void this.queueFor(chatKey).push(() =>
      this.runChat(chatKey, text, generation!, { isGroup: evt.isGroup === true, images }),
    );
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
  private channelCommand(chatKey: string, text: string, opts: { isGroup?: boolean } = {}): string | null {
    const [cmd] = text.slice(1).split(/\s+/);
    switch (cmd) {
      case "help":
        if (opts.isGroup) {
          return [
            "群聊可用命令：",
            "/new     开启全新群聊会话",
            "/status  查看当前群聊会话状态",
            "/model   查看当前模型",
            "/help    本帮助",
            "隐私文件、全局技能、已知会话和机器工具只在私聊中可用。",
          ].join("\n");
        }
        return [
          "可用命令：",
          "/new     开启全新会话（旧会话归档保留）",
          "/status  会话状态：消息数 / 上下文 / token 用量",
          "/chats   列出已知会话",
          "/model   查看当前模型",
          "/skills [on|off <名>]  查看 / 启用 / 禁用技能",
          "/show <memory|user|persona>  查看记忆 / 用户资料 / 人设文件",
          "/confirm <code>  批准一次完全相同的高权限工具调用",
          "/help    本帮助",
          "其它内容直接发给 ani 即可。",
        ].join("\n");
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
        if (opts.isGroup) return "群聊中已禁用 /chats，请在私聊中查看。";
        return this.listChats().map((c) => `${c.chatKey}${c.hint ? `（${c.hint}）` : ""}`).join("\n");
      case "model":
        return `当前模型：${this.cfg.model}（改 ani.json 的 model 字段即热更新）`;
      case "skills": {
        if (opts.isGroup) return "群聊中已禁用 /skills，请在私聊中管理全局技能。";
        const arg = text.split(/\s+/).slice(1);
        if (arg.length === 2 && (arg[0] === "on" || arg[0] === "off")) return this.skillToggle(arg[1], arg[0] === "on");
        return this.skillsOverview();
      }
      case "show": {
        if (opts.isGroup) return "群聊中已禁用 /show，请在私聊中查看私人资料。";
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

  private async runChat(
    chatKey: string,
    userText: string,
    generation: number,
    opts?: { isGroup?: boolean; images?: ImageInput[] },
  ): Promise<void> {
    // This turn may have gone stale while waiting behind an active run.
    if (!this.isCurrent(chatKey, generation)) return;
    // Sessions created by older ani versions may contain replies produced
    // with private prompts/tools. Archive that legacy history once instead
    // of ever replaying it inside the new hard-isolated group context.
    if (opts?.isGroup && this.sessions.get(chatKey).some((message) => message._meta?.groupSafe !== true)) {
      try {
        this.sessions.reset(chatKey, { archive: true });
      } catch (e) {
        warn("router", `group migration ${chatKey} failed: ${e instanceof Error ? e.message : e}`);
        await this.deliver(chatKey, "群聊历史安全迁移失败，本条消息未处理；请检查本地日志后重试。").catch(() => {});
        return;
      }
    }
    const snapshot = this.sessions.snapshot(chatKey);
    let rollbackAttempted = false;
    const rollback = () => {
      if (rollbackAttempted) return;
      rollbackAttempted = true;
      this.sessions.restore(chatKey, snapshot);
    };
    const controller = new AbortController();
    this.running.set(chatKey, controller);
    const [channelName, chatId] = splitChatKey(chatKey);
    try {
      this.sessions.append(chatKey, {
        role: "user",
        content: userText,
        ...(opts?.images?.length ? { images: opts.images } : {}),
        _meta: { ts: Date.now(), ...(opts?.isGroup ? { groupSafe: true } : {}) },
      });
      await this.sessions.maybeCompact(chatKey, this.streamFn, this.cfg.model);
      if (!this.isCurrent(chatKey, generation) || controller.signal.aborted) {
        rollback();
        return;
      }

      const mode: ToolMode = opts?.isGroup ? "group" : "private";
      const prompt = buildSystemPrompt({ mode: opts?.isGroup ? "group" : "private" });
      const system: Msg = { role: "system", content: prompt };
      const history = this.sessions.get(chatKey);
      const wire: Msg[] = [system, ...history];
      const before = wire.length;

      const result = await runAgent({
        messages: wire,
        tools: this.toolPolicy.toolsForMode(this.tools, mode),
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
          authorizeTool: this.authorizeTools(chatKey, mode, String(generation)),
        },
      });

      // A provider is allowed to ignore AbortSignal. Generation is therefore
      // the authority: stale output must never reach storage or the channel.
      if (!this.isCurrent(chatKey, generation) || controller.signal.aborted || result.aborted) {
        rollback();
        return;
      }
      for (const m of wire.slice(before)) {
        if (opts?.isGroup) m._meta = { ...(m._meta ?? { ts: Date.now() }), groupSafe: true };
        this.sessions.append(chatKey, m);
      }
      this.recordUsage(chatKey, result.usage);

      const notice = this.approvalNotice(chatKey);
      // Once a privileged call is pending, do not let model-authored prose
      // describe its risk. Only the code-generated exact arguments are shown.
      const reply = notice || result.text.trim();
      if (!reply) return;
      await this.deliver(chatKey, reply, controller.signal);
      // sendText can be slow enough for a newer inbound event to arrive.
      if (!this.isCurrent(chatKey, generation) || controller.signal.aborted) rollback();
    } catch (e) {
      if (!this.isCurrent(chatKey, generation) || controller.signal.aborted) {
        rollback();
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      warn("router", `runChat ${chatKey} failed: ${msg}`);
      // Provider, attachment and tool errors may contain local paths, URLs or
      // credentials. A public group gets a fixed message; details stay in the
      // local log. Private owner chats keep the useful diagnostic excerpt.
      const reply = opts?.isGroup
        ? "处理这条群聊消息时发生错误，请稍后重试，或在私聊中继续。"
        : `出错了: ${msg.slice(0, 300)}`;
      await this.deliver(chatKey, reply, controller.signal).catch(() => {});
    } finally {
      this.toolPolicy.finishAttempt(chatKey, String(generation));
      // defensive: only remove if this run is still the registered one
      if (this.running.get(chatKey) === controller) this.running.delete(chatKey);
    }
  }

  private approvalNotice(chatKey: string): string {
    const pending = this.toolPolicy.pendingForChat(chatKey);
    if (!pending.length) return "";
    return [
      "🔒 ANI 代码级安全确认（以下参数由程序生成，不由模型解释）：",
      ...pending.flatMap((item) => [
        `工具：${item.toolName}`,
        `参数：${item.argsPreview}`,
        `校验：sha256:${item.argsDigest}`,
        `批准：/confirm ${item.token}（10 分钟内、仅当前会话、仅一次）`,
      ]),
    ].join("\n");
  }

  private async deliver(chatKey: string, text: string, signal?: AbortSignal): Promise<void> {
    const [channelName, chatId] = splitChatKey(chatKey);
    if (channelName === "cli") {
      process.stdout.write(`\nani> ${text}\n\n`);
      return;
    }
    const ch = this.channels.get(channelName);
    if (!ch) throw new Error(`channel ${channelName} not connected`);
    await ch.sendText(chatId, text, undefined, signal);
  }

  // ------------------------------------------------------------------ cron

  private async runCronTask(task: CronTask): Promise<void> {
    const chatKey = `cron:${task.id}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
    try {
      // Cron is unattended and therefore never receives private context or
      // machine-control tools, even when its delivery target is a private
      // chat. This single public mode is deliberately easier to audit.
      const mode: ToolMode = "cron";
      if (this.sessions.get(chatKey).some((message) => message._meta?.groupSafe !== true)) {
        this.sessions.reset(chatKey, { archive: true });
      }
      this.sessions.append(chatKey, {
        role: "user",
        content: `[定时任务触发] ${task.prompt}`,
        _meta: { ts: Date.now(), internal: true, groupSafe: true },
      });
      await this.sessions.maybeCompact(chatKey, this.streamFn, this.cfg.model);
      const wire: Msg[] = [
        { role: "system", content: buildSystemPrompt({ mode: "cron" }) },
        ...this.sessions.get(chatKey),
      ];
      const before = wire.length;
      const [targetChannel, targetChatId] = splitChatKey(task.target);
      const result = await runAgent({
        messages: wire,
        tools: this.toolPolicy.toolsForMode(this.tools, mode),
        streamFn: this.streamFn,
        model: this.cfg.model,
        maxTokens: this.cfg.maxTokens,
        signal: controller.signal,
        // ctx points at the DELIVERY TARGET (not the cron session) so that
        // send_message/send_file without an explicit chatKey land where the
        // report goes — previously they errored on the unknown "cron" channel
        ctx: {
          chatKey: task.target,
          channel: targetChannel,
          chatId: targetChatId,
          cwd: PATHS.root,
          signal: controller.signal,
          authorizeTool: this.authorizeTools(task.target, mode, `cron:${task.id}`),
        },
      });
      for (const m of wire.slice(before)) {
        m._meta = { ...(m._meta ?? { ts: Date.now() }), groupSafe: true };
        this.sessions.append(chatKey, m);
      }
      this.recordUsage(chatKey, result.usage);
      const text = result.text.trim() || "(任务完成，无输出)";
      task.lastResult = text.slice(0, 200);
      if (task.target && this.channels.has(targetChannel)) {
        await this.deliver(task.target, `⏰ ${task.name}\n\n${text}`, controller.signal);
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
    let userText = text;
    let generation: number;
    const confirmation = /^\/confirm\s+(\S+)\s*$/i.exec(text.trim());
    if (confirmation) {
      const token = confirmation[1];
      if (!this.toolPolicy.canConfirm(chatKey, token)) {
        const message = "确认码无效、已过期，或不属于当前会话。请重新发起操作。";
        onDelta(message);
        return message;
      }
      generation = this.nextGeneration(chatKey, token);
      const approval = this.toolPolicy.confirm(chatKey, token, String(generation));
      if (!approval) return "";
      userText = `[Owner confirmed code-verified ${approval.toolName} with /confirm ${token}. Retry only the exact same tool call now.]`;
    } else {
      generation = this.nextGeneration(chatKey);
    }
    return this.queueFor(chatKey).push(async () => {
      if (!this.isCurrent(chatKey, generation)) return "";
      const snapshot = this.sessions.snapshot(chatKey);
      let rollbackAttempted = false;
      const rollback = () => {
        if (rollbackAttempted) return;
        rollbackAttempted = true;
        this.sessions.restore(chatKey, snapshot);
      };
      const controller = new AbortController();
      this.running.set(chatKey, controller);
      const active = () => this.isCurrent(chatKey, generation) && !controller.signal.aborted;
      try {
        this.sessions.append(chatKey, { role: "user", content: userText, _meta: { ts: Date.now() } });
        await this.sessions.maybeCompact(chatKey, this.streamFn, this.cfg.model);
        if (!active()) {
          rollback();
          return "";
        }
        const wire: Msg[] = [{ role: "system", content: buildSystemPrompt() }, ...this.sessions.get(chatKey)];
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
            channel: "cli",
            chatId: "local",
            cwd: PATHS.root,
            signal: controller.signal,
            authorizeTool: this.authorizeTools(chatKey, "cli", String(generation)),
          },
          events: {
            onTextDelta: (d) => {
              if (active() && !this.toolPolicy.hasPending(chatKey)) onDelta(d);
            },
            onReasoningDelta: (d) => {
              if (active() && !this.toolPolicy.hasPending(chatKey)) onReasoning?.(d);
            },
            onToolStart: (name) => {
              if (!active()) return;
              (onToolStart ?? ((n) => process.stdout.write(`\n\x1b[90m⚙ ${n}...\x1b[0m`)))(name);
            },
            onToolEnd: (name, ok, preview) => active() && onTool(name, ok, preview),
          },
        });
        if (!active() || result.aborted) {
          rollback();
          return "";
        }
        for (const m of wire.slice(before)) this.sessions.append(chatKey, m);
        this.recordUsage(chatKey, result.usage);
        const notice = this.approvalNotice(chatKey);
        if (notice) onDelta(notice);
        return notice || result.text;
      } catch (e) {
        if (!active()) {
          rollback();
          return "";
        }
        throw e;
      } finally {
        this.toolPolicy.finishAttempt(chatKey, String(generation));
        if (this.running.get(chatKey) === controller) this.running.delete(chatKey);
      }
    });
  }

  /** Queue a reset behind the active turn after invalidating it immediately. */
  private queueReset(chatKey: string, afterReset?: () => Promise<void>): Promise<void> {
    this.nextGeneration(chatKey);
    return this.queueFor(chatKey).push(async () => {
      this.sessions.reset(chatKey, { archive: true });
      await afterReset?.();
    });
  }

  resetSession(chatKey: string): Promise<void> {
    return this.queueReset(chatKey);
  }

  cancelToolApprovals(chatKey: string): void {
    this.toolPolicy.invalidate(chatKey);
  }

  // ------------------------------------------------------------- registry

  private rememberChat(chatKey: string, channel: string, chatId: string, hint?: string, isGroup?: boolean): void {
    const existing = this.chats.get(chatKey);
    if (existing) {
      // Public wins on any classification conflict. This prevents a channel
      // ID collision or malformed later event from downgrading a known group
      // into a private target for background tasks.
      const nextVisibility = existing.isGroup === true || isGroup === true
        ? true
        : isGroup === false
          ? false
          : existing.isGroup;
      if (nextVisibility === existing.isGroup) return;
      existing.isGroup = nextVisibility;
    } else {
      this.chats.set(chatKey, { chatKey, channel, chatId, hint, ...(isGroup === undefined ? {} : { isGroup }) });
    }
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

function detectInboundImage(path: string): ReturnType<typeof detectImageMime> {
  try {
    return detectImageMime(path);
  } catch {
    return null;
  }
}
