/**
 * DeepSeek provider. OpenAI-compatible streaming chat completions.
 *
 * DeepSeek quirks handled here:
 * - thinking is ON by default (v4); reasoning streams in `reasoning_content`
 * - assistant messages that carry tool_calls MUST keep reasoning_content on
 *   follow-up requests or the API 400s — session.ts stores it, we forward it
 * - vision images stay as local paths in sessions and become data URLs only
 *   while serializing a request
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { postSSE } from "./net.ts";
import { log } from "./log.ts";
import type { ImageInput, Msg, StreamFn, StreamParams, StreamResult, ToolCall } from "./types.ts";

export const DEEPSEEK_VISION_MODEL = "deepseek-v4-flash-vision-exp";
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 48 * 1024 * 1024;
const INLINE_MESSAGE_BUDGET = 47 * 1024 * 1024; // leave room for the rest of the JSON request
const MAX_IMAGE_URL_CHARS = 8192;
export const MAX_IMAGES_PER_REQUEST = 600;
export type SupportedImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface DeepSeekOpts {
  apiKey: string;
  baseUrl: string;
  proxy?: string;
  timeoutMs?: number;
  /** "disabled" turns off thinking (faster, cheaper); default enabled */
  thinking?: "enabled" | "disabled";
}

export function isVisionModel(model: string | undefined): boolean {
  return model?.trim().toLowerCase() === DEEPSEEK_VISION_MODEL;
}

function imageMime(data: Uint8Array): SupportedImageMime | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (
    data.length >= 8 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  ) return "image/png";
  if (data.length >= 6) {
    const sig = Buffer.from(data.subarray(0, 6)).toString("ascii");
    if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
  }
  if (
    data.length >= 12 &&
    Buffer.from(data.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(data.subarray(8, 12)).toString("ascii") === "WEBP"
  ) return "image/webp";
  return null;
}

/** Read only the file signature; DeepSeek also detects formats from content. */
export function detectImageMime(path: string): SupportedImageMime | null {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.allocUnsafe(12);
    const length = readSync(fd, header, 0, header.length, 0);
    return imageMime(header.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}

function localInlineBytes(images: ImageInput[]): number {
  let bytes = 0;
  for (const image of images) {
    if (!("path" in image)) continue;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(image.path);
    } catch (e) {
      throw new Error(`Cannot read image ${image.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!stat.isFile()) throw new Error(`Image path is not a file: ${image.path}`);
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image exceeds DeepSeek's 32 MiB inline limit: ${image.path} (${stat.size} bytes)`);
    }
    // Exact base64 length plus a small JSON/data-URL allowance per image.
    bytes += 4 * Math.ceil(stat.size / 3) + 256;
  }
  return bytes;
}

function imageParts(text: string, images: ImageInput[]): Record<string, unknown>[] {
  const estimatedInlineBytes = Buffer.byteLength(text, "utf8") + localInlineBytes(images);
  if (estimatedInlineBytes > INLINE_MESSAGE_BUDGET) {
    throw new Error("Inline images would exceed DeepSeek's 48 MiB request-body limit");
  }

  const parts: Record<string, unknown>[] = text ? [{ type: "text", text }] : [];
  for (const image of images) {
    if ("fileId" in image) {
      if (!image.fileId) throw new Error("DeepSeek image fileId cannot be empty");
      parts.push({ type: "file", file_id: image.fileId });
      continue;
    }
    if ("url" in image) {
      if (image.url.length > MAX_IMAGE_URL_CHARS) {
        throw new Error(`DeepSeek image URL exceeds ${MAX_IMAGE_URL_CHARS} characters`);
      }
      let parsed: URL;
      try {
        parsed = new URL(image.url);
      } catch {
        throw new Error(`Invalid image URL: ${image.url}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Remote image URL must use http or https");
      }
      parts.push({
        type: "image_url",
        image_url: { url: image.url, ...(image.detail ? { detail: image.detail } : {}) },
      });
      continue;
    }

    const data = readFileSync(image.path);
    const mime = imageMime(data);
    if (!mime) {
      throw new Error(`Unsupported image format: ${image.path} (expected JPEG, PNG, GIF, or WebP)`);
    }
    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${mime};base64,${data.toString("base64")}`,
        ...(image.detail ? { detail: image.detail } : {}),
      },
    });
  }
  return parts;
}

/** Strip internal fields; keep the exact wire shape DeepSeek expects. */
export function toWire(m: Msg, model?: string): Record<string, unknown> {
  let content: unknown = m.content;
  if (m.images?.length) {
    if (m.role !== "user") throw new Error("DeepSeek images are only allowed in user messages");
    if (!isVisionModel(model)) {
      throw new Error(`Model ${model || "(unspecified)"} does not support images; use ${DEEPSEEK_VISION_MODEL}`);
    }
    content = imageParts(m.content, m.images);
  }
  const out: Record<string, unknown> = { role: m.role, content };
  if (m.role === "assistant" && m.tool_calls?.length) {
    out.tool_calls = m.tool_calls;
    if (m.reasoning_content) out.reasoning_content = m.reasoning_content;
  }
  if (m.role === "tool" && m.tool_call_id) out.tool_call_id = m.tool_call_id;
  return out;
}

function imageLabel(image: ImageInput): string {
  if ("path" in image) return basename(image.path) || "image";
  if ("fileId" in image) return basename(image.fileId) || "image";
  try {
    return basename(new URL(image.url).pathname) || "remote-image";
  } catch {
    return "remote-image";
  }
}

function inspectImage(image: ImageInput): { bytes: number } | { reason: string } {
  if ("path" in image) {
    try {
      const stat = statSync(image.path);
      if (!stat.isFile()) return { reason: "not a file" };
      if (stat.size > MAX_IMAGE_BYTES) return { reason: "larger than 32 MiB" };
      if (!detectImageMime(image.path)) return { reason: "unsupported image format" };
      return { bytes: 4 * Math.ceil(stat.size / 3) + 256 };
    } catch {
      return { reason: "file missing or unreadable" };
    }
  }
  if ("fileId" in image) {
    return image.fileId
      ? { bytes: Buffer.byteLength(image.fileId, "utf8") + 128 }
      : { reason: "empty file id" };
  }
  if (image.url.length > MAX_IMAGE_URL_CHARS) return { reason: "URL longer than 8192 characters" };
  try {
    const parsed = new URL(image.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { reason: "unsupported URL protocol" };
  } catch {
    return { reason: "invalid URL" };
  }
  return { bytes: Buffer.byteLength(image.url, "utf8") + 256 };
}

function messageBytes(m: Msg): number {
  let bytes = Buffer.byteLength(m.content, "utf8") + 256;
  if (m.reasoning_content) bytes += Buffer.byteLength(m.reasoning_content, "utf8");
  if (m.tool_calls) {
    for (const call of m.tool_calls) {
      bytes += Buffer.byteLength(call.function.name + call.function.arguments, "utf8") + 128;
    }
  }
  return bytes;
}

/**
 * Prepare a complete history for the configured model without letting stale
 * local image references brick the chat. `toWire` remains deliberately strict;
 * this conversation-level layer owns model switching and request budgeting.
 */
export function toWireMessages(messages: Msg[], model: string): Record<string, unknown>[] {
  const hasImages = messages.some((m) => m.images?.length);
  if (!hasImages) return messages.map((m) => toWire(m, model));

  // Model hot-switches must not invalidate an otherwise valid text history.
  // Keep the image references in SessionStore so switching back restores them.
  if (!isVisionModel(model)) {
    return messages.map((m) => toWire({ ...m, images: undefined }, model));
  }

  const selected: ImageInput[][] = messages.map(() => []);
  const downgraded: string[][] = messages.map(() => []);
  let estimatedBytes = 4096 + messages.reduce((sum, m) => sum + messageBytes(m), 0);
  let imageCount = 0;

  // Prefer the newest conversational evidence. Within one user message, keep
  // the sender's original image order.
  for (let i = messages.length - 1; i >= 0; i--) {
    const images = messages[i].images ?? [];
    for (const image of images) {
      const label = imageLabel(image);
      if (messages[i].role !== "user") {
        downgraded[i].push(`[image unavailable: ${label} (images are allowed only in user messages)]`);
        continue;
      }
      const inspected = inspectImage(image);
      if ("reason" in inspected) {
        downgraded[i].push(`[image unavailable: ${label} (${inspected.reason})]`);
        continue;
      }
      if (imageCount >= MAX_IMAGES_PER_REQUEST) {
        downgraded[i].push(`[image omitted: ${label} (600-image request limit)]`);
        continue;
      }
      if (estimatedBytes + inspected.bytes > INLINE_MESSAGE_BUDGET) {
        downgraded[i].push(`[image omitted: ${label} (48 MiB request limit)]`);
        continue;
      }
      selected[i].push(image);
      imageCount++;
      estimatedBytes += inspected.bytes;
    }
  }

  return messages.map((m, i) => {
    const notes = downgraded[i];
    const content = notes.length ? [m.content, ...notes].filter(Boolean).join("\n") : m.content;
    return toWire({ ...m, content, images: selected[i].length ? selected[i] : undefined }, model);
  });
}

/** Enforce the provider's complete JSON request-body limit. */
export function assertRequestSize(body: string, maxBytes = MAX_REQUEST_BYTES): void {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`DeepSeek request body exceeds 48 MiB (${bytes} bytes)`);
  }
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
      messages: toWireMessages(messages, model),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens ?? 8192,
    };
    if (opts.thinking === "disabled") payload.thinking = { type: "disabled" };
    if (tools.length) payload.tools = tools;
    const body = JSON.stringify(payload);
    assertRequestSize(body);

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
        body,
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
