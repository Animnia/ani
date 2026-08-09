/**
 * Janitor — data/ accumulates files forever otherwise (inbox downloads,
 * screenshots, truncated shell outputs). On boot, sweep files older than
 * 30 days from the known scratch dirs. Sessions/memory/cron are never
 * touched: those are state, not scratch.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import { log, warn } from "./log.ts";

const MAX_AGE_MS = 30 * 86_400_000;
const SCRATCH_DIRS = [PATHS.inbox, join(PATHS.data, "screenshots"), join(PATHS.data, "shell-output")];

export function sweepDataDirs(now = Date.now(), dirs: string[] = SCRATCH_DIRS): { removed: number } {
  let removed = 0;
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // dir doesn't exist yet
    }
    for (const name of entries) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          // inbox has per-chat subdirs — sweep their files, then the dir if empty
          let sub: string[] = [];
          try {
            sub = readdirSync(full);
          } catch {
            continue;
          }
          for (const f of sub) {
            const fp = join(full, f);
            try {
              const fst = statSync(fp);
              if (fst.isFile() && now - fst.mtimeMs > MAX_AGE_MS) {
                rmSync(fp, { force: true });
                removed++;
              }
            } catch {
              /* locked file etc. — leave it */
            }
          }
          try {
            if (readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true });
          } catch {
            /* leave */
          }
        } else if (st.isFile() && now - st.mtimeMs > MAX_AGE_MS) {
          rmSync(full, { force: true });
          removed++;
        }
      } catch {
        /* leave it */
      }
    }
  }
  if (removed) log("janitor", `swept ${removed} scratch file(s) older than 30 days`);
  return { removed };
}
