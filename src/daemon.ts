/**
 * Daemon lifecycle — `ani daemon start|stop|restart|status`.
 *
 * start spawns a detached `node ani.ts --no-cli` with logs redirected into
 * data/; the child acquires the single-instance lock itself (ani.ts), so a
 * double start is impossible by construction. stop resolves the pid from
 * the lock, signals it, and always cleans a stale lock afterwards.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ANI_VERSION, PATHS } from "./core/config.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lockFile = () => join(PATHS.data, "ani.lock");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** pid of the live daemon on this config, or null (stale locks are pruned). */
export function daemonPid(): number | null {
  try {
    if (!existsSync(lockFile())) return null;
    const pid = Number(readFileSync(lockFile(), "utf8").trim());
    if (pid && alive(pid)) return pid;
    rmSync(lockFile(), { force: true }); // stale
    return null;
  } catch {
    return null;
  }
}

export async function daemonStart(): Promise<string> {
  const existing = daemonPid();
  if (existing) return `ani daemon is already running (pid ${existing})`;
  const out = openSync(join(PATHS.data, "daemon.out.log"), "a");
  const err = openSync(join(PATHS.data, "daemon.err.log"), "a");
  const child = spawn(process.execPath, [join(PATHS.root, "ani.ts"), "--no-cli"], {
    cwd: PATHS.root,
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true,
    env: process.env, // ANI_CONFIG rides along when set
  });
  child.unref();
  closeSync(out);
  closeSync(err);

  // confirm the boot: the child writes its lock before connecting channels
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    if (child.pid && !alive(child.pid)) {
      let tail = "";
      try {
        tail = readFileSync(join(PATHS.data, "daemon.err.log"), "utf8").slice(-400).trim();
      } catch {
        /* no log */
      }
      return `daemon exited during boot — check data/daemon.out.log${tail ? `\n--- stderr tail ---\n${tail}` : ""}`;
    }
    if (existsSync(lockFile())) {
      return `ani daemon started (pid ${child.pid}) — logs: ${join(PATHS.data, "daemon.out.log")}`;
    }
  }
  return `ani daemon spawned (pid ${child.pid}) but no lock yet — check \`ani status\` in a moment`;
}

export async function daemonStop(): Promise<string> {
  const pid = daemonPid();
  if (!pid) return "ani daemon is not running";
  try {
    process.kill(pid, "SIGTERM"); // hard kill on Windows; graceful elsewhere
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(200);
  if (alive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
    await sleep(300);
  }
  rmSync(lockFile(), { force: true }); // Windows hard-kill leaves it behind
  return alive(pid) ? `failed to stop daemon (pid ${pid})` : `ani daemon stopped (pid ${pid})`;
}

export async function daemonRestart(): Promise<string> {
  const wasRunning = daemonPid() !== null;
  const stopped = await daemonStop();
  const started = await daemonStart();
  return wasRunning ? `${stopped}\n${started}` : `(daemon was not running)\n${started}`;
}

export function daemonStatus(): string {
  const pid = daemonPid();
  return pid
    ? `ani v${ANI_VERSION} daemon: running (pid ${pid}) — details: \`ani status\``
    : `ani v${ANI_VERSION} daemon: not running — start with \`ani daemon start\``;
}
