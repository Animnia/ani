/**
 * Daemon lifecycle mechanics. start() against real channels is dogfooded
 * live; here we test the OS-risky parts with a stand-in process: pid
 * resolution from the lock, already-running detection, stop semantics and
 * stale-lock cleanup.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "ani-daemon-"));
process.env.ANI_CONFIG = join(dir, "ani.json");

let daemon: typeof import("../src/daemon.ts");
let sleeper: ChildProcess | null = null;

const lockFile = () => join(dir, "data", "ani.lock");

async function waitDead(pid: number, ms = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

before(async () => {
  writeFileSync(process.env.ANI_CONFIG!, JSON.stringify({ deepseek: { apiKey: "x" } }));
  daemon = await import("../src/daemon.ts");
});

after(() => {
  try {
    if (sleeper?.pid) process.kill(sleeper.pid, "SIGKILL");
  } catch {
    /* already dead */
  }
});

test("stop: resolves pid from lock, kills, removes lock", async () => {
  sleeper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  assert.ok(sleeper.pid);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(lockFile(), String(sleeper.pid));

  assert.equal(daemon.daemonPid(), sleeper.pid);
  const msg = await daemon.daemonStop();
  assert.match(msg, /stopped/, msg);
  assert.ok(await waitDead(sleeper.pid!), "sleeper still alive after stop");
  assert.ok(!existsSync(lockFile()), "stale lock left behind");
  assert.equal(daemon.daemonPid(), null);
  sleeper = null;
});

test("stop: not running is a clean no-op", async () => {
  const msg = await daemon.daemonStop();
  assert.match(msg, /not running/, msg);
});

test("start: refuses when a live daemon holds the lock", async () => {
  sleeper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  writeFileSync(lockFile(), String(sleeper.pid));
  const msg = await daemon.daemonStart();
  assert.match(msg, /already running/, msg);
  process.kill(sleeper.pid!, "SIGKILL");
  await waitDead(sleeper.pid!);
  sleeper = null;
});

test("daemonPid: stale lock (dead pid) is pruned, returns null", () => {
  // a pid that (almost certainly) doesn't exist
  writeFileSync(lockFile(), "4194303");
  assert.equal(daemon.daemonPid(), null);
  assert.ok(!existsSync(lockFile()), "stale lock not pruned");
});
