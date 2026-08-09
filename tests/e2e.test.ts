/**
 * End-to-end: boot the real ani process, chat with it over stdin, verify the
 * agent uses tools and answers. Strict timeouts; the child is always killed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasLiveChannels, hasLiveCredentials, needs } from "./helpers.ts";

const SKIP = needs(hasLiveCredentials() && hasLiveChannels(), "valid ani.json with live channels");

test("ani boots, channels connect, CLI agent turn works", { timeout: 180_000, ...SKIP }, async () => {
  const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  // temp state root: the live config (real channels) but isolated data/ —
  // keeps the single-instance lock and session files away from any running
  // daemon and from the developer's real state
  const dir = mkdtempSync(join(tmpdir(), "ani-e2e-live-"));
  copyFileSync(join(root, "ani.json"), join(dir, "ani.json"));
  copyFileSync(join(root, "PERSONA.md"), join(dir, "PERSONA.md"));
  const child = spawn(process.execPath, ["ani.ts"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ANI_CONFIG: join(dir, "ani.json") },
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (err += d.toString()));

  const kill = async () => {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 5000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  };

  try {
    // wait for boot banner
    const bootDeadline = Date.now() + 60_000;
    while (!out.includes("ani is up") && Date.now() < bootDeadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(out.includes("ani is up"), `boot banner missing.\nstdout:\n${out}\nstderr:\n${err}`);

    // ask something that forces a tool call
    child.stdin.write("用 shell 工具执行 `echo ANI_E2E_MARKER` 然后把输出原样告诉我\n");

    const answerDeadline = Date.now() + 120_000;
    while (!out.includes("ANI_E2E_MARKER") && Date.now() < answerDeadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(out.includes("ANI_E2E_MARKER"), `agent never echoed the marker.\nstdout:\n${out}\nstderr:\n${err}`);

    // slash command
    child.stdin.write("/chats\n"); // eslint-disable-line
    await new Promise((r) => setTimeout(r, 2000));
    assert.match(out, /cli:local/);
  } finally {
    await kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

// the single-instance lock: a second daemon on the same config must refuse
test("second instance on the same config is refused", { timeout: 60_000 }, async () => {
  const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const dir = mkdtempSync(join(tmpdir(), "ani-e2e-lock-"));
  try {
    const cfg = JSON.parse(readFileSync(join(root, "ani.example.json"), "utf8"));
    cfg.deepseek.apiKey = "test-dummy";
    writeFileSync(join(dir, "ani.json"), JSON.stringify(cfg));
    copyFileSync(join(root, "PERSONA.md"), join(dir, "PERSONA.md"));
    const env = { ...process.env, ANI_CONFIG: join(dir, "ani.json") };

    const first = spawn(process.execPath, [join(root, "ani.ts"), "--no-cli"], { stdio: ["ignore", "pipe", "pipe"], env });
    let out1 = "";
    first.stdout.on("data", (d) => (out1 += d.toString()));
    first.stderr.on("data", (d) => (out1 += d.toString()));
    try {
      const deadline = Date.now() + 20_000;
      while (!out1.includes("started") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      assert.ok(out1.includes("started"), `first instance never booted:\n${out1}`);

      const second = spawn(process.execPath, [join(root, "ani.ts"), "--no-cli"], { stdio: ["ignore", "pipe", "pipe"], env });
      let out2 = "";
      second.stdout.on("data", (d) => (out2 += d.toString()));
      second.stderr.on("data", (d) => (out2 += d.toString()));
      const code2: number = await new Promise((res) => second.on("exit", (c) => res(c ?? -1)));
      assert.equal(code2, 1, "second instance must exit 1");
      assert.match(out2, /already running/, `refusal message missing:\n${out2}`);

      // and the first must still be alive afterwards
      assert.equal(first.exitCode, null, "first instance died");
    } finally {
      if (first.exitCode === null) {
        first.kill("SIGKILL");
        await Promise.race([once(first, "exit"), new Promise((r) => setTimeout(r, 5000))]);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// regression: a daemon with ZERO enabled channels used to exit silently right
// after boot (cron timer unref'd, config watcher non-persistent — nothing held
// the event loop). It must stay up until signalled.
test("daemon with no channels stays alive until signalled", { timeout: 60_000 }, async () => {
  const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const dir = mkdtempSync(join(tmpdir(), "ani-e2e-nk-"));
  try {
    const cfg = JSON.parse(readFileSync(join(root, "ani.example.json"), "utf8"));
    cfg.deepseek.apiKey = "test-dummy"; // no live calls happen: nothing connects
    writeFileSync(join(dir, "ani.json"), JSON.stringify(cfg));
    copyFileSync(join(root, "PERSONA.md"), join(dir, "PERSONA.md"));

    const child = spawn(process.execPath, [join(root, "ani.ts"), "--no-cli"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ANI_CONFIG: join(dir, "ani.json") },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    try {
      // wait for startup, then prove it is STILL alive 3s later
      const deadline = Date.now() + 20_000;
      while (!out.includes("started") && Date.now() < deadline) {
        assert.equal(child.exitCode, null, `exited during boot:\n${out}`);
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(out.includes("started"), `never booted:\n${out}`);
      await new Promise((r) => setTimeout(r, 3000));
      assert.equal(child.exitCode, null, `daemon exited silently after boot:\n${out}`);

      if (process.platform !== "win32") {
        // POSIX: SIGTERM reaches the handler — clean shutdown must be logged
        child.kill("SIGTERM");
        await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 8000))]);
        assert.match(out, /shutting down \(SIGTERM\)/, `graceful shutdown missing:\n${out}`);
      }
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 5000))]);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
