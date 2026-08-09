/**
 * The agent loop — a distillation of pi's agent-loop.ts:
 *
 *   stream assistant response → execute tool calls → append results → repeat
 *   until the model stops calling tools.
 *
 * Deliberately small. Everything else (sessions, channels, skills) lives
 * outside the loop and just feeds it messages.
 */
import type { AgentEvents, Msg, StreamFn, ToolCall, ToolContext, ToolDef } from "./types.ts";
import { log, warn } from "./log.ts";

export interface AgentRunOptions {
  messages: Msg[]; // mutated: assistant + tool messages are appended
  tools: ToolDef[];
  streamFn: StreamFn;
  model: string;
  ctx: ToolContext;
  events?: AgentEvents;
  maxRounds?: number;
  signal?: AbortSignal;
  /** prepare messages right before each API call (compaction hook) */
  beforeCall?: (messages: Msg[]) => Promise<Msg[]>;
}

export interface AgentRunResult {
  text: string;
  rounds: number;
  aborted: boolean;
}

const MAX_ROUNDS = 40;

function preview(s: string, n = 200): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n) + "…" : oneLine;
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { _: v };
  } catch {
    return { _raw: raw };
  }
}

async function executeTool(
  call: ToolCall,
  tools: ToolDef[],
  ctx: ToolContext,
): Promise<string> {
  const tool = tools.find((t) => t.name === call.function.name);
  if (!tool) return `Error: unknown tool "${call.function.name}"`;
  const args = parseArgs(call.function.arguments);
  try {
    const out = await tool.execute(args, ctx);
    return out === "" ? "(no output)" : out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn("tool", `${call.function.name} failed: ${msg}`);
    return `Error: ${msg}`;
  }
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const { messages, tools, streamFn, model, ctx, events, signal } = opts;
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS;
  const wireTools = tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  let rounds = 0;
  let lastText = "";

  for (;;) {
    if (signal?.aborted) return { text: lastText, rounds, aborted: true };
    if (rounds >= maxRounds) {
      messages.push({
        role: "user",
        content: "(system note: tool round limit reached — answer the user with what you have)",
        _meta: { ts: Date.now(), internal: true },
      });
      const finalRes = await streamFn({
        model,
        messages: opts.beforeCall ? await opts.beforeCall(messages) : messages,
        tools: [],
        signal,
        onTextDelta: events?.onTextDelta,
      });
      const finalMsg: Msg = {
        role: "assistant",
        content: finalRes.content,
        reasoning_content: finalRes.reasoning || undefined,
        _meta: { ts: Date.now() },
      };
      messages.push(finalMsg);
      return { text: finalRes.content, rounds, aborted: false };
    }

    const toSend = opts.beforeCall ? await opts.beforeCall(messages) : messages;
    const res = await streamFn({
      model,
      messages: toSend,
      tools: wireTools,
      signal,
      onTextDelta: events?.onTextDelta,
      onReasoningDelta: events?.onReasoningDelta,
    });
    rounds++;

    const assistantMsg: Msg = {
      role: "assistant",
      content: res.content,
      _meta: { ts: Date.now() },
    };
    if (res.reasoning) assistantMsg.reasoning_content = res.reasoning;
    if (res.toolCalls.length) assistantMsg.tool_calls = res.toolCalls;
    messages.push(assistantMsg);
    if (res.content) lastText = res.content;

    if (!res.toolCalls.length) {
      return { text: res.content, rounds, aborted: false };
    }

    for (const call of res.toolCalls) {
      if (signal?.aborted) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: "Error: aborted by user",
          _meta: { ts: Date.now(), internal: true },
        });
        continue;
      }
      const args = parseArgs(call.function.arguments);
      events?.onToolStart?.(call.function.name, args);
      log("agent", `tool → ${call.function.name}(${preview(JSON.stringify(args), 160)})`);
      const out = await executeTool(call, tools, ctx);
      events?.onToolEnd?.(call.function.name, !out.startsWith("Error:"), preview(out));
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: out,
        _meta: { ts: Date.now() },
      });
    }
  }
}
