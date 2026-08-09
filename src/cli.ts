/**
 * Interactive terminal chat. Deliberately simple readline — the fancy TUI is
 * what made other agents heavy. Slash commands: /help /reset /model /approve
 * /chats /cron /quit.
 */
import { createInterface } from "node:readline";
import type { Router } from "./router.ts";

export function startCli(router: Router): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let busy = false;
  let streaming = false;
  let queued: string | null = null; // one-deep queue for input typed mid-run

  const prompt = () => {
    if (!busy) process.stdout.write("\nyou> ");
  };

  process.stdout.write("\nani is up. Channels: " + (router.channelNames().join(", ") || "(none)") + " — /help for commands\n");
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
        process.stdout.write("(still working — your message is queued)\n");
        return;
      }
      busy = true;
      streaming = false;
      try {
        for (let current: string | null = text; current !== null; current = queued, queued = null) {
          streaming = false;
          await router.runCliTurn(
            current,
            (d) => {
              if (!streaming) {
                process.stdout.write("\nani> ");
                streaming = true;
              }
              process.stdout.write(d);
            },
            (name, ok, preview) => {
              process.stdout.write(`\x1b[90m ${ok ? "✓" : "✗"} ${preview}\x1b[0m\n`);
            },
          );
          process.stdout.write("\n");
        }
      } catch (e) {
        process.stdout.write(`\nerror: ${e instanceof Error ? e.message : e}\n`);
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
          [
            "/help           this help",
            "/reset          clear the CLI conversation",
            "/approve CODE   approve a QQ/Telegram pairing code",
            "/chats          list known chats",
            "/model NAME     show current model (edit ani.json to change)",
            "/quit           exit",
            "anything else → chat with ani",
            "",
          ].join("\n"),
        );
        break;
      case "reset":
        router.resetSession("cli:local");
        process.stdout.write("conversation cleared.\n");
        break;
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
        process.stdout.write(`unknown command /${cmd} — /help\n`);
    }
  }
}
