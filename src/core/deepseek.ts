/**
 * DeepSeek provider. OpenAI-compatible streaming chat completions.
 *
 * DeepSeek quirks handled here:
 * - thinking is ON by default (v4); reasoning streams in `reasoning_content`
 * - assistant messages that carry tool_calls MUST keep reasoning_content on
 *   follow-up requests or the API 400s — session.ts stores it, we forward it
 * - no vision: text only
 */
import { postSSE } from "./net.ts";
import { log } from "./log.ts";
import type { Msg, StreamFn, StreamParams, StreamResult, ToolCall } from "./types.ts";

export interface DeepSeekOpts {
  apiKey: string;
  baseUrl: string;
  proxy?: string;
  timeoutMs?: number;
  /** "disabled" turns off thinking (faster, cheaper); default enabled */
  thinking?: "enabled" | "disabled";
}

/** Strip internal fields; keep the exact wire shape DeepSeek expects. */
export function toWire(m: Msg): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.role === "assistant" && m.tool_calls?.length) {
    out.tool_calls = m.tool_calls;
    if (m.reasoning_content) out.reasoning_content = m.reasoning_content;
  }
  if (m.role === "tool" && m.tool_call_id) out.tool_call_id = m.tool_call_id;
  return out;
}

export function createDeepSeekStream(opts: DeepSeekOpts): StreamFn {
  return (params: StreamParams) => streamWithRetry(opts, params);
}

async function streamWithRetry(opts: DeepSeekOpts, params: StreamParams): Promise<StreamResult> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    // if any delta already reached the UI, a retry would duplicate output — don't
    let emitted = false;
    const guarded: StreamParams = {
      ...params,
      onTextDelta: params.onTextDelta ? (d) => { emitted = true; params.onTextDelta!(d); } : undefined,
      onReasoningDelta: params.onReasoningDelta ? (d) => { emitted = true; params.onReasoningDelta!(d); } : undefined,
    };
    try {
      return await streamOnce(opts, guarded);
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      // only transient failures are worth another shot; aborts and 4xx are not
      const transient =
        /timeout|ECONN|ECONNRESET|ETIMEDOUT|socket|closed|DeepSeek API (429|5\d\d)/i.test(msg) &&
        !/API (400|401|402|403|404|422)/.test(msg);
      if (!transient || emitted || params.signal?.aborted || attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function streamOnce(opts: DeepSeekOpts, params: StreamParams): Promise<StreamResult> {
  {
    const { model, messages, tools, signal, onTextDelta, onReasoningDelta, maxTokens } = params;
    const payload: Record<string, unknown> = {
      model,
      messages: messages.map(toWire),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens ?? 8192,
    };
    if (opts.thinking === "disabled") payload.thinking = { type: "disabled" };
    if (tools.length) payload.tools = tools;

    let content = "";
    let reasoning = "";
    const calls = new Map<number, ToolCall>();
    let finishReason = "stop";
    let usage: StreamResult["usage"];
    let apiError: string | null = null;

    const res = await postSSE(
      `${opts.baseUrl}/chat/completions`,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify(payload),
        proxy: opts.proxy,
        timeoutMs: opts.timeoutMs ?? 300_000,
        signal,
      },
      (data) => {
        if (data === "[DONE]") return;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          return;
        }
        if (chunk.error) {
          apiError = chunk.error.message ?? JSON.stringify(chunk.error);
          return;
        }
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          onReasoningDelta?.(delta.reasoning_content);
        }
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          onTextDelta?.(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            let acc = calls.get(i);
            if (!acc) {
              acc = { id: tc.id ?? "", type: "function", function: { name: "", arguments: "" } };
              calls.set(i, acc);
            }
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.function.name += tc.function.name;
            if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
          }
        }
      },
    );

    if (res.status >= 400) {
      throw new Error(`DeepSeek API ${res.status}: ${res.body.slice(0, 500)}`);
    }
    if (apiError) throw new Error(`DeepSeek API error: ${apiError}`);
    if (finishReason === "length") {
      // discoverability > silence: a cut-off answer looks like a model bug
      log("deepseek", `output truncated at max_tokens=${payload.max_tokens} (finish_reason=length) — raise maxTokens in ani.json`);
    }

    return {
      content,
      reasoning,
      toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
      finishReason,
      usage,
    };
  }
}
