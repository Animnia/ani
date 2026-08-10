/**
 * ani — entry point.
 *
 *   node ani.ts                 start everything + interactive terminal
 *   node ani.ts --no-cli        daemon mode (channels + cron only)
 *   node ani.ts daemon <start|stop|restart|status>   background daemon control
 *   node ani.ts config [show] | config set <key> <v> inspect/edit ani.json safely
 *   node ani.ts approve <CODE>  approve a pairing code (works while daemon runs)
 *   node ani.ts doctor          self-diagnosis (config, network, channels)
 */
import { initLog, log, error } from "./src/core/log.ts";
import { ANI_VERSION, PATHS } from "./src/core/config.ts";
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

  // background daemon lifecycle: start / stop / restart / status
  if (args[0] === "daemon") {
    const d = await import("./src/daemon.ts");
    switch (args[1] ?? "status") {
      case "start":
        console.log(await d.daemonStart());
        break;
      case "stop":
        console.log(await d.daemonStop());
        break;
      case "restart":
        console.log(await d.daemonRestart());
        break;
      case "status":
        console.log(d.daemonStatus());
        break;
      default:
        console.error("usage: node ani.ts daemon <start|stop|restart|status>");
        process.exit(1);
    }
    return;
  }

  // safe config inspection/editing (wizard / show / set)
  if (args[0] === "config") {
    const { runConfig } = await import("./src/config-cli.ts");
    await runConfig(args.slice(1));
    return;
  }

  // runtime status: is a daemon up on this config, who is paired, what is
  // scheduled — the multi-device "is ani alive on that box?" answer
  if (args[0] === "status") {
    const { existsSync, readFileSync } = await import("node:fs");
    const { loadConfig } = await import("./src/core/config.ts");
    console.log(`ani v${ANI_VERSION} — status\n`);
    const lockFile = PATHS.data + "/ani.lock";
    let running = "no";
    if (existsSync(lockFile)) {
      const pid = Number(readFileSync(lockFile, "utf8").trim());
      if (pid) {
        try {
          process.kill(pid, 0);
          running = `yes (pid ${pid})`;
        } catch {
          running = `no (stale lock pid ${pid})`;
        }
      }
    }
    console.log(`  daemon     ${running}`);
    try {
      const cfg = loadConfig();
      const chans = Object.entries(cfg.channels)
        .filter(([, c]) => c?.enabled)
        .map(([n, c]) => `${n} (owners: ${c.owners.length || "none"})`);
      console.log(`  channels   ${chans.join(", ") || "none enabled"}`);
      console.log(`  model      ${cfg.model}`);
    } catch (e) {
      console.log(`  config     unreadable: ${e instanceof Error ? e.message : e}`);
    }
    try {
      const cron = JSON.parse(readFileSync(PATHS.cronFile, "utf8")) as { name: string; enabled: boolean; schedule: string; target: string }[];
      const en = cron.filter((t) => t.enabled);
      console.log(`  cron       ${en.length} enabled / ${cron.length} total${en.length ? ": " + en.map((t) => `${t.name} [${t.schedule}] → ${t.target}`).join("; ") : ""}`);
    } catch {
      console.log("  cron       none");
    }
    try {
      const mem = readFileSync(PATHS.memoryFile, "utf8");
      console.log(`  memory     ${mem.split("\n").filter((l) => l.trim()).length} lines in MEMORY.md`);
    } catch {
      console.log("  memory     empty");
    }
    return;
  }

  // self-update: pull the latest release into the install dir.
  // ani.json + data/ are gitignored / absent from the tarball, so an
  // overlay never touches user state. ani must be restarted afterwards.
  if (args[0] === "update") {
    const { execFileSync } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    const dir = PATHS.root;
    try {
      if (existsSync(dir + ".git")) {
        console.log("updating via git…");
        execFileSync("git", ["pull", "--ff-only"], { cwd: dir, stdio: "inherit" });
      } else {
        console.log("no .git here — overlaying the latest tarball…");
        const url = "https://github.com/Animnia/ani/archive/refs/heads/main.tar.gz";
        const tmp = dir + ".ani-update.tar.gz";
        const proxy = process.env.ANI_GH_PROXY ?? process.env.HTTPS_PROXY;
        try {
          execFileSync(
            "curl",
            [...(proxy ? ["-x", proxy] : []), "-fsSL", "--max-time", "120", "-o", tmp, url],
            { stdio: "inherit" },
          );
          // --force-local: on Windows the drive-letter colon in `tmp` makes
          // tar treat it as a remote host:file ("Cannot connect to C:")
          execFileSync("tar", ["--force-local", "-xzf", tmp, "--strip-components=1", "-C", dir], { stdio: "inherit" });
        } finally {
          try {
            (await import("node:fs")).rmSync(tmp, { force: true });
          } catch {
            /* best effort */
          }
        }
      }
      console.log("updated. restart ani to run the new version.");
      // if a daemon is live, say so explicitly — easy to forget otherwise
      try {
        const lockFile = PATHS.data + "/ani.lock";
        if (existsSync(lockFile)) {
          const pid = Number((await import("node:fs")).readFileSync(lockFile, "utf8").trim());
          if (pid) {
            try {
              process.kill(pid, 0);
              console.log(`⚠️  a daemon is running (pid ${pid}) on the OLD code — restart it to apply.`);
            } catch {
              /* not actually running */
            }
          }
        }
      } catch {
        /* best-effort hint only */
      }
    } catch (e) {
      console.error(`update failed: ${e instanceof Error ? e.message : e}\ntry re-running the one-line installer instead.`);
      process.exit(1);
    }
    return;
  }

  initLog(PATHS.logFile);

  // single-instance guard: two anis on one config means QQ session-stealing
  // loops and Telegram 409 conflicts (observed live when a test booted a
  // second instance). Lock holds the pid; a stale lock (SIGKILL/crash) is
  // detected via a liveness probe.
  const lockFile = PATHS.data + "/ani.lock";
  {
    const { existsSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
    if (existsSync(lockFile)) {
      const pid = Number(readFileSync(lockFile, "utf8").trim());
      if (pid && pid !== process.pid) {
        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          /* dead — stale lock */
        }
        if (alive) {
          console.error(`ani is already running (pid ${pid}). Stop it first, or delete ${lockFile} if that pid is gone.`);
          process.exit(1);
        }
      }
    }
    writeFileSync(lockFile, String(process.pid));
    process.on("exit", () => {
      try {
        rmSync(lockFile, { force: true });
      } catch {
        /* best effort */
      }
    });
  }

  const router = new Router();
  await router.init();
  log("ani", `v${ANI_VERSION} started. channels: ${router.channelNames().join(", ") || "(none)"}, model: ${router.model()}`);

  const shutdown = async (sig: string) => {
    log("ani", `shutting down (${sig})`);
    await router.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // lifetime anchor: with no channels enabled and no CLI, nothing else holds
  // the event loop (cron's timer is unref'd; the config watcher is
  // non-persistent) and the daemon would exit silently right after boot.
  // The entry point owns process lifetime explicitly.
  setInterval(() => {}, 2_147_483_647);

  if (!args.includes("--no-cli")) {
    startCli(router);
  }
}

main().catch((e) => {
  error("ani", "fatal:", e);
  console.error(e);
  process.exit(1);
});
