/**
 * ani — entry point.
 *
 *   node ani.ts                 start everything + interactive terminal
 *   node ani.ts --no-cli        daemon mode (channels + cron only)
 *   node ani.ts approve <CODE>  approve a pairing code (works while daemon runs)
 *   node ani.ts doctor          self-diagnosis (config, network, channels)
 */
import { initLog, log, error } from "./src/core/log.ts";
import { PATHS } from "./src/core/config.ts";
import { Router } from "./src/router.ts";
import { startCli } from "./src/cli.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // standalone approve: edit ani.json directly; a running daemon picks it up
  // via its config watcher
  if (args[0] === "approve") {
    const code = (args[1] ?? "").trim();
    if (!code) {
      console.error("usage: node ani.ts approve <CODE>");
      process.exit(1);
    }
    const p = (await import("./src/core/pairing.ts")).approveCode(code);
    if (!p) {
      console.error(`no pending pairing with code ${code} (codes expire after 30min — have the user message the bot again)`);
      process.exit(1);
    }
    console.log(`approved ${p.channel}:${p.userId}${p.userName ? ` (${p.userName})` : ""} — running daemon picks this up automatically`);
    return;
  }

  if (args[0] === "doctor") {
    const { runDoctor } = await import("./src/doctor.ts");
    process.exit(await runDoctor());
  }

  initLog(PATHS.logFile);
  const router = new Router();
  await router.init();
  log("ani", `started. channels: ${router.channelNames().join(", ") || "(none)"}, model: ${router.model()}`);

  const shutdown = async (sig: string) => {
    log("ani", `shutting down (${sig})`);
    await router.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (!args.includes("--no-cli")) {
    startCli(router);
  }
}

main().catch((e) => {
  error("ani", "fatal:", e);
  console.error(e);
  process.exit(1);
});
