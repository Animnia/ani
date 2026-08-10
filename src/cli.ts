/**
 * Interactive terminal chat. pi-style minimalism: plain readline plus
 * colors and markdown-rendered streaming replies. Slash discovery is
 * readline-native (type `/`, press Tab) — a hand-rolled live menu was
 * tried and corrupted readline's cursor bookkeeping (lost cursor, broken
 * newlines); native completion never desyncs. All decoration is TTY-only;
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
  { name: "/skills", args: " [on|off <名>]", desc: "查看 / 启用 / 禁用技能（自动检测）" },
  { name: "/show", args: " <memory|user|persona>", desc: "查看记忆 / 用户资料 / 人设文件" },
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
    `\n ${bold(cyan(`ani v${ANI_VERSION}`))} ${dim(`· ${router.model()} · 输入即对话；键入 / 后按 Tab 预览命令`)}\n`,
  );
  process.stdout.write("ani is up. Channels: " + (router.channelNames().join(", ") || "(none)") + " — /help for commands\n");

  const prompt = () => {
    if (!busy) process.stdout.write(`\n${cyan("you> ")}`);
  };
  prompt();

  rl.on("line", (line) => {
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
          let thinking = false;
          // markdown-rendered streaming when on a TTY; raw deltas otherwise
          const md = new TerminalMdStream((s) => process.stdout.write(s));
          await router.runCliTurn(
            current,
            (d) => {
              if (thinking) {
                process.stdout.write("\n"); // thinking block ends where the answer begins
                thinking = false;
              }
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
            (name) => {
              // flush any half-rendered line BEFORE tool status lines, or
              // buffered text would surface after them (wrong visual order)
              if (streaming && useColor) md.end();
              if (streaming || thinking) process.stdout.write("\n");
              streaming = false;
              thinking = false;
              process.stdout.write(gray(` ⚙ ${name}...`));
            },
            (d) => {
              // reasoning streams dimmed, before/around the visible answer
              if (!thinking) {
                process.stdout.write(`\n${dim("💭 ")}`);
                thinking = true;
              }
              process.stdout.write(dim(d));
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
      case "skills": {
        const parts = rest.length ? rest : [];
        if (parts.length === 2 && (parts[0] === "on" || parts[0] === "off")) {
          process.stdout.write(router.skillToggle(parts[1], parts[0] === "on") + "\n");
        } else {
          process.stdout.write(router.skillsOverview() + "\n");
        }
        break;
      }
      case "show":
        process.stdout.write(router.showFile(rest[0] ?? "") + "\n");
        break;
      case "quit":
      case "exit":
        process.exit(0);
      default:
        process.stdout.write(`未知命令 /${cmd} — 输入 /help 查看全部\n`);
    }
  }
}
