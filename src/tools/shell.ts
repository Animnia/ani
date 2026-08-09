/**
 * shell tool — full machine control, pi-style: one tool, a command string,
 * a timeout. Cross-platform: cmd.exe on Windows, sh elsewhere. Output is
 * truncated to keep context lean; full output goes to a temp file when huge.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../core/config.ts";
import type { ToolDef } from "../core/types.ts";

const MAX_OUT = 30_000; // chars returned inline
const DEFAULT_TIMEOUT_SEC = 120;
const IS_WIN = process.platform === "win32";

/** Kill a process tree. Windows: taskkill /t. POSIX: we spawned with a new
 *  process group (detached), so kill the whole group. */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (IS_WIN) {
    spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { windowsHide: true });
  } else {
    try {
      process.kill(-pid, "SIGKILL"); // negative pid = process group
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }
}

export const shellTool: ToolDef = {
  name: "shell",
  description: IS_WIN
    ? "Run a shell command on this Windows machine and return stdout+stderr. Use cmd syntax by default, or call powershell explicitly (`powershell -NoProfile -Command \"...\"`). You have full control of the machine. Always set a timeout for long-running commands."
    : "Run a shell command on this machine and return stdout+stderr (sh -c syntax; call bash explicitly for bashisms). You have full control of the machine. Always set a timeout for long-running commands.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command to execute" },
      timeout: { type: "number", description: "Timeout in seconds (default 120, max 3600)" },
      cwd: { type: "string", description: "Working directory (default: project dir)" },
    },
    required: ["command"],
  },
  async execute(args, ctx) {
    const command = String(args.command ?? "");
    if (!command.trim()) return "Error: empty command";
    const timeoutSec = Math.min(Math.max(Number(args.timeout) || DEFAULT_TIMEOUT_SEC, 1), 3600);
    const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : ctx.cwd;

    return new Promise((resolve) => {
      const child = IS_WIN
        ? spawn("cmd.exe", ["/d", "/s", "/c", command], { cwd, windowsHide: true, env: process.env })
        : spawn("sh", ["-c", command], { cwd, env: process.env, detached: true }); // detached: own process group for killTree
      let out = Buffer.alloc(0);
      let killed = false;
      const onData = (chunk: Buffer) => {
        out = Buffer.concat([out, chunk]);
        if (out.length > 4 * 1024 * 1024) {
          killed = true;
          child.kill("SIGKILL");
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      const timer = setTimeout(() => {
        killed = true;
        killTree(child.pid); // child.kill alone leaves grandchildren
      }, timeoutSec * 1000);

      const abort = () => {
        killed = true;
        killTree(child.pid);
      };
      ctx.signal?.addEventListener("abort", abort, { once: true });

      child.on("error", (e) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", abort);
        resolve(`Error: failed to start command: ${e.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", abort);
        let text = out.toString("utf8");
        let note = "";
        if (text.length > MAX_OUT) {
          const dir = join(PATHS.data, "shell-output");
          mkdirSync(dir, { recursive: true });
          const f = join(dir, `out-${Date.now()}.log`);
          try {
            writeFileSync(f, text);
            note = `\n[output truncated: ${text.length} chars, full output saved to ${f}]`;
          } catch {
            /* just truncate */
          }
          text = text.slice(0, MAX_OUT);
        }
        const status = killed ? "killed (timeout or abort)" : `exit code ${code ?? "?"}`;
        resolve(`${text}${note}\n[${status}]`);
      });
    });
  },
};
