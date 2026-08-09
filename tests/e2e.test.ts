/**
 * End-to-end: boot the real ani process, chat with it over stdin, verify the
 * agent uses tools and answers. Strict timeouts; the child is always killed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { hasLiveChannels, hasLiveCredentials, needs } from "./helpers.ts";

const SKIP = needs(hasLiveCredentials() && hasLiveChannels(), "valid ani.json with live channels");

test("ani boots, channels connect, CLI agent turn works", { timeout: 180_000, ...SKIP }, async () => {
  const child = spawn("node", ["ani.ts"], {
    cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
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
  }
});
