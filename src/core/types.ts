/**
 * Core types for ani. Text messages mirror the DeepSeek/OpenAI wire format;
 * local image paths and `_meta` stay internal until the provider serializes.
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ImageDetail = "low" | "high" | "original" | "auto";

/** Image input kept outside `content` so session JSONL stores paths, not base64. */
export type ImageInput =
  | { path: string; detail?: ImageDetail }
  | { url: string; detail?: ImageDetail }
  | { fileId: string };

export interface Msg {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Vision input. Only valid on user messages; encoded by the provider. */
  images?: ImageInput[];
  /** DeepSeek thinking content. MUST be preserved for assistant messages
   *  that carry tool_calls, or the API returns 400. */
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  /** role === "tool" */
  tool_call_id?: string;
  /** Internal metadata, stripped before sending to the API. */
  _meta?: { ts: number; [k: string]: unknown };
}

export interface ToolContext {
  /** chat key like "telegram:123" / "qq:openid" / "cli:local" */
  chatKey: string;
  channel: string;
  chatId: string;
  /** working directory for shell/file tools */
  cwd: string;
  signal?: AbortSignal;
  /** Code-level authorization hook (group isolation / exact one-shot approval). */
  authorizeTool?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => { allowed: boolean; reason?: string };
  /** send a file from local disk to this chat. Implemented by the router. */
  sendFile?: (filePath: string, caption?: string) => Promise<string>;
  /** send a message to any known chat. Implemented by the router. */
  sendTo?: (chatKey: string, text: string) => Promise<void>;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

/** Events emitted by the agent loop, for UI rendering. */
export interface AgentEvents {
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolEnd?: (name: string, ok: boolean, preview: string) => void;
}

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface StreamParams {
  model: string;
  messages: Msg[];
  tools: { type: "function"; function: { name: string; description: string; parameters: unknown } }[];
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  maxTokens?: number;
}

/** A provider turns a conversation into one assistant message (streamed). */
export type StreamFn = (params: StreamParams) => Promise<StreamResult>;

/** Inbound message from any channel. */
export interface InboundEvent {
  channel: string;
  chatId: string;
  userId: string;
  userName?: string;
  text: string;
  messageId?: string;
  /** files already downloaded to local disk */
  files?: { path: string; name: string; size: number }[];
  /** true for group chats (the bot was @-mentioned) */
  isGroup?: boolean;
}

export interface Channel {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(chatId: string, text: string, replyTo?: string, signal?: AbortSignal): Promise<void>;
  sendFile(chatId: string, filePath: string, caption?: string): Promise<void>;
  isOwner(userId: string): boolean;
  addOwner(userId: string): void;
}
