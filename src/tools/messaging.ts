/**
 * Messaging tools: talk to the owner on any connected channel, send files.
 * The router injects the actual delivery functions.
 */
import { existsSync, statSync } from "node:fs";
import type { ToolDef } from "../core/types.ts";

export interface MessagingBridge {
  listChats(): { chatKey: string; channel: string; chatId: string; hint?: string }[];
  sendText(chatKey: string, text: string): Promise<void>;
  sendFile(chatKey: string, filePath: string, caption?: string): Promise<void>;
}

export function makeMessagingTools(bridge: MessagingBridge): ToolDef[] {
  return [
    {
      name: "send_message",
      description:
        "Send a message to a chat on any connected channel (telegram/qq/cli). Default target is the current chat. Use list_chats to discover other chat keys. Replies are NOT streamed — this sends a complete message.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          chatKey: { type: "string", description: "Target chat, e.g. telegram:123456 (default: current chat)" },
        },
        required: ["text"],
      },
      async execute(args, ctx) {
        const text = String(args.text ?? "");
        if (!text.trim()) return "Error: empty text";
        const target = typeof args.chatKey === "string" && args.chatKey ? args.chatKey : ctx.chatKey;
        try {
          await bridge.sendText(target, text);
          return `Sent to ${target}`;
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : e}`;
        }
      },
    },
    {
      name: "send_file",
      description:
        "Send a local file (document/image/…) to a chat. Use it to deliver reports, generated files, screenshots. Default target is the current chat.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to a local file" },
          caption: { type: "string" },
          chatKey: { type: "string", description: "Target chat (default: current chat)" },
        },
        required: ["path"],
      },
      async execute(args, ctx) {
        const p = String(args.path ?? "");
        if (!p || !existsSync(p) || !statSync(p).isFile()) return `Error: file not found: ${p}`;
        const size = statSync(p).size;
        if (size > 45 * 1024 * 1024) return `Error: file too large (${size} bytes) — channel limit ~50MB`;
        const target = typeof args.chatKey === "string" && args.chatKey ? args.chatKey : ctx.chatKey;
        try {
          await bridge.sendFile(target, p, typeof args.caption === "string" ? args.caption : undefined);
          return `File sent to ${target} (${size} bytes)`;
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : e}`;
        }
      },
    },
    {
      name: "list_chats",
      description: "List known chats (channels that have talked to ani, plus cli:local) with their chatKeys for send_message/send_file/cron targets.",
      parameters: { type: "object", properties: {} },
      async execute() {
        const chats = bridge.listChats();
        if (!chats.length) return "(no known chats yet)";
        return chats.map((c) => `${c.chatKey}${c.hint ? `  (${c.hint})` : ""}`).join("\n");
      },
    },
  ];
}
