/**
 * Interactive terminal chat. pi-style minimalism: plain readline plus the
 * three things that matter in daily use — colors, a live slash-command
 * preview (type `/`, candidates appear under the input; Tab completes),
 * and markdown-rendered streaming replies. All decoration is TTY-only;
 * piped stdio gets plain text so scripts and tests see stable output.
 */
import { createInterface, type Interface } from "node:readline";
import { ANI_VERSION } from "./core/config.ts";
import { TerminalMdStream } from "./core/markdown.ts";
import { bold, cyan, dim, gray, green, red, useColor, yellow } from "./core/ansi.ts";
import type { Router } from "./router.ts";

/** Single source of truth: /help, Tab completion and the live preview all
 *  read this registry. */
const COMMANDS: { name: string; args: string; desc: string }[] = [
  { name: "/help", args: "", desc: "列出全部命令" },
  { name: "/new", args: "", desc: "开启全新会话（旧会话自动归档保留）" },
  { name: "/status", args: "", desc: "当前会话：消息数 / 上下文占用 / token 用量" },
  { name: "/chats", args: "", desc: "列出已知会话" },
  { name: "/approve", args: " <code>", desc: "批准一个 QQ/Telegram 配对码" },
  { name: "/model", args: "", desc: "查看当前模型（改 ani.json 即热更新）" },
  { name: "/quit", args: "", desc: "退出" },
];

export function startCli(router: Router): void {
  const rl: Interface = createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string): [string[], string] => {
      if (!line.startsWith("/") || line.includes(" ")) return [[], line];
      const hits = COMMANDS.filter((c) => c.name.startsWith(line)).map((c) => c.name);
      return [hits.length ? hits : COMMANDS.map((c) => c.name), line];
    },
  });
  let busy = false;
  let streaming = false;
  let queued: string | null = null; // one-deep queue for input typed mid-run

  // ---- startup banner (keep the literal "ani is up" — tests + scripts grep it)
  process.stdout.write(
    `\n ${bold(cyan(`ani v${ANI_VERSION}`))} ${dim(`· ${router.model()} · 输入即对话，键入 / 预览命令`)}\n`,
  );
  process.stdout.write("ani is up. Channels: " + (router.channelNames().join(", ") || "(none)") + " — /help for commands\n");

  const prompt = () => {
    if (!busy) process.stdout.write(`\n${cyan("you> ")}`);
  };
  prompt();

  // ---- live slash preview: as you type "/", matching commands render below
  // the input line via save/restore-cursor. TTY only.
  const clearBelow = () => process.stdout.write("\x1b7\x1b[0J\x1b8");
  if (process.stdout.isTTY) {
    rl.input.on("keypress", () =>
      setImmediate(() => {
        clearBelow();
        const line = rl.line;
        if (!line.startsWith("/") || line.includes(" ")) return;
        const hits = COMMANDS.filter((c) => c.name.startsWith(line));
        if (!hits.length || (hits.length === 1 && hits[0].name === line)) return;
        const menu = hits.map((c) => `  ${cyan(c.name.padEnd(10))}${gray(c.desc)}`).join("\n");
        process.stdout.write(`\x1b7\x1b[0J\n${dim("命令:")}\n${menu}\x1b8`);
      }),
    );
  }

  rl.on("line", (line) => {
    if (process.stdout.isTTY) clearBelow();
    const text = line.trim();
    void (async () => {
      if (!text) {
        prompt();
        return;
      }
      if (text.startsWith("/")) {
        await command(text);
        prompt();
        return;
      }
      if (busy) {
        // merge multiple mid-run messages into one follow-up turn
        queued = queued ? queued + "\n" + text : text;
        process.stdout.write(yellow("(还在工作 —— 你的消息已排队，本轮结束后继续)\n"));
        return;
      }
      busy = true;
      streaming = false;
      try {
        for (let current: string | null = text; current !== null; current = queued, queued = null) {
          streaming = false;
          // markdown-rendered streaming when on a TTY; raw deltas otherwise
          const md = new TerminalMdStream((s) => process.stdout.write(s));
          await router.runCliTurn(
            current,
            (d) => {
              if (!streaming) {
                process.stdout.write(`\n${green("ani> ")}`);
                streaming = true;
              }
              if (useColor) md.push(d);
              else process.stdout.write(d);
            },
            (name, ok, preview) => {
              process.stdout.write(gray(` ${ok ? "✓" : "✗"} ${preview}`) + "\n");
            },
          );
          if (useColor) md.end();
          process.stdout.write("\n");
        }
      } catch (e) {
        process.stdout.write(`\n${red(`error: ${e instanceof Error ? e.message : e}`)}\n`);
      } finally {
        busy = false;
        streaming = false;
        queued = null;
        prompt();
      }
    })();
  });

  rl.on("close", () => process.exit(0));

  async function command(text: string): Promise<void> {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "help":
        process.stdout.write(
          COMMANDS.map((c) => `  ${cyan((c.name + c.args).padEnd(16))}${c.desc}`).join("\n") + "\n",
        );
        break;
      case "new":
      case "reset": // kept as an alias — muscle memory from older versions
        router.resetSession("cli:local");
        process.stdout.write("新会话已开始（旧会话已归档到 sessions/ 下，随时可查）。\n");
        break;
      case "status": {
        const s = router.sessionStatus("cli:local");
        const pct = s.maxChars ? Math.round((s.chars / s.maxChars) * 100) : 0;
        const lines = [
          `${bold("会话")} cli:local`,
          `  消息     ${s.messages} 条`,
          `  上下文   ${s.chars.toLocaleString()} / ${s.maxChars.toLocaleString()} 字符 (${pct}%)${s.compactions ? ` · 已压缩 ${s.compactions} 次` : ""}`,
          s.usage
            ? `  token    ${s.usage.prompt.toLocaleString()} in / ${s.usage.completion.toLocaleString()} out（本次进程 ${s.usage.calls} 次调用）`
            : `  token    本次进程还没有 API 调用`,
          `  模型     ${s.model} · thinking ${s.thinking}`,
        ];
        process.stdout.write(lines.join("\n") + "\n");
        break;
      }
      case "approve":
        process.stdout.write(router.approve(arg) + "\n");
        break;
      case "chats":
        process.stdout.write(router.listChats().map((c) => `${c.chatKey}${c.hint ? `  (${c.hint})` : ""}`).join("\n") + "\n");
        break;
      case "model":
        process.stdout.write(router.model() + "\n");
        break;
      case "quit":
      case "exit":
        process.exit(0);
      default:
        process.stdout.write(`未知命令 /${cmd} — 输入 /help 查看全部\n`);
    }
  }
}
