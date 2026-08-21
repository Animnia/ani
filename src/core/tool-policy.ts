/** Code-level tool policy. Unknown tools fail safe: private and confirmed. */
import { createHash, randomBytes } from "node:crypto";

export type ToolMode = "private" | "group" | "cli" | "cron";

export interface ToolAuthorization {
  allowed: boolean;
  reason?: string;
}

interface PendingApproval {
  token: string;
  chatKey: string;
  signature: string;
  toolName: string;
  argsJson: string;
  expiresAt: number;
}

export interface ToolApprovalNotice {
  token: string;
  toolName: string;
  argsPreview: string;
  argsDigest: string;
  expiresAt: number;
}

const APPROVAL_TTL = 10 * 60_000;
const PUBLIC_TOOLS = new Set(["web_search"]);
const CRON_TOOLS = new Set(["web_search", "send_message"]);
const SAFE_PRIVATE_TOOLS = new Set([
  "read_file",
  "list_dir",
  "grep_files",
  "memory_read",
  "memory_search",
  "list_chats",
]);

export class ToolPolicy {
  private pending = new Map<string, PendingApproval>();
  private grants = new Map<string, { signature: string; attemptId: string; expiresAt: number }>();

  toolsForMode<T extends { name: string }>(tools: T[], mode: ToolMode): T[] {
    if (mode === "group") return tools.filter((tool) => PUBLIC_TOOLS.has(tool.name));
    if (mode === "cron") return tools.filter((tool) => CRON_TOOLS.has(tool.name));
    return tools;
  }

  authorize(
    chatKey: string,
    mode: ToolMode,
    toolName: string,
    args: Record<string, unknown>,
    attemptId = "",
  ): ToolAuthorization {
    this.prune();
    if (mode === "group") {
      if (!PUBLIC_TOOLS.has(toolName)) {
        return { allowed: false, reason: `tool ${toolName} is disabled in public group mode` };
      }
      return { allowed: true };
    }
    if (mode === "cron") {
      if (!CRON_TOOLS.has(toolName)) {
        return { allowed: false, reason: `tool ${toolName} is disabled in public cron mode` };
      }
      if (toolName === "web_search" || !requiresApproval(toolName, args, chatKey)) return { allowed: true };
      return { allowed: false, reason: `tool ${toolName} requires live owner confirmation and cannot run from cron` };
    }
    if (!requiresApproval(toolName, args, chatKey)) return { allowed: true };

    const signature = stableJson([toolName, args]);
    const grant = this.grants.get(chatKey);
    if (grant?.signature === signature && grant.attemptId === attemptId && grant.expiresAt > Date.now()) {
      this.grants.delete(chatKey); // exact action, once
      return { allowed: true };
    }

    const existing = [...this.pending.values()].find(
      (item) => item.chatKey === chatKey && item.signature === signature && item.expiresAt > Date.now(),
    );
    let token = existing?.token;
    if (!token) {
      do token = randomBytes(4).toString("hex").toUpperCase();
      while (this.pending.has(token));
    }
    const argsJson = stableJson(args);
    if (!existing) {
      this.pending.set(token, {
        token,
        chatKey,
        signature,
        toolName,
        argsJson,
        expiresAt: Date.now() + APPROVAL_TTL,
      });
    }
    const notice = approvalNotice(existing ?? this.pending.get(token)!);
    return {
      allowed: false,
      reason:
        `owner confirmation required for ${toolName}; code-verified arguments: ${notice.argsPreview} ` +
        `(sha256:${notice.argsDigest}). Ask the owner to send /confirm ${token}. ` +
        "The approval is bound to these exact arguments, expires in 10 minutes, and can be used once.",
    };
  }

  canConfirm(chatKey: string, rawToken: string): boolean {
    this.prune();
    const token = rawToken.trim().toUpperCase();
    const pending = this.pending.get(token);
    return !!pending && pending.chatKey === chatKey;
  }

  confirm(chatKey: string, rawToken: string, attemptId: string): ToolApprovalNotice | null {
    this.prune();
    const token = rawToken.trim().toUpperCase();
    const pending = this.pending.get(token);
    if (!pending || pending.chatKey !== chatKey) return null;
    this.pending.delete(token);
    this.grants.set(chatKey, { signature: pending.signature, attemptId, expiresAt: Date.now() + APPROVAL_TTL });
    return approvalNotice(pending);
  }

  pendingForChat(chatKey: string): ToolApprovalNotice[] {
    this.prune();
    return [...this.pending.values()]
      .filter((item) => item.chatKey === chatKey)
      .map(approvalNotice);
  }

  hasPending(chatKey: string): boolean {
    this.prune();
    return [...this.pending.values()].some((item) => item.chatKey === chatKey);
  }

  /** A newer user intent invalidates every old code/grant. During /confirm,
   *  preserve only that token until it is synchronously moved into this turn. */
  invalidate(chatKey: string, preserveToken?: string): void {
    const keep = preserveToken?.trim().toUpperCase();
    this.grants.delete(chatKey);
    for (const [token, item] of this.pending) {
      if (item.chatKey === chatKey && token !== keep) this.pending.delete(token);
    }
  }

  /** An unused grant may never leak into another attempt. */
  finishAttempt(chatKey: string, attemptId: string): void {
    const grant = this.grants.get(chatKey);
    if (grant?.attemptId === attemptId) this.grants.delete(chatKey);
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, item] of this.pending) if (item.expiresAt <= now) this.pending.delete(token);
    for (const [chatKey, item] of this.grants) if (item.expiresAt <= now) this.grants.delete(chatKey);
  }
}

function requiresApproval(toolName: string, args: Record<string, unknown>, chatKey: string): boolean {
  if (SAFE_PRIVATE_TOOLS.has(toolName)) return false;
  switch (toolName) {
    case "browser":
      return !["text", "tabs"].includes(String(args.action ?? ""));
    case "cron_manage":
      return args.action !== "list";
    case "user_profile":
      return args.action !== "read";
    case "send_message":
    case "send_file":
      return typeof args.chatKey === "string" && args.chatKey !== chatKey;
    default:
      // shell, file writes, memory writes, MCP and future tools are privileged.
      return true;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function approvalNotice(item: PendingApproval): ToolApprovalNotice {
  const limit = 800;
  return {
    token: item.token,
    toolName: item.toolName,
    argsPreview: item.argsJson.length > limit ? item.argsJson.slice(0, limit) + `… (${item.argsJson.length} chars)` : item.argsJson,
    argsDigest: createHash("sha256").update(item.argsJson).digest("hex"),
    expiresAt: item.expiresAt,
  };
}
