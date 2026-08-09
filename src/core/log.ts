/**
 * Tiny logger: console + rotating-free append to data/ani.log.
 * One file, no deps. Verbose enough to debug, quiet enough to live with.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

let logFile: string | null = null;
let quiet = false;

export function initLog(file: string, opts?: { quiet?: boolean }): void {
  logFile = file;
  quiet = opts?.quiet ?? false;
  mkdirSync(dirname(file), { recursive: true });
}

function fmt(level: string, tag: string, msg: string): string {
  // local time — the user reads these logs (toISOString would be UTC)
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  const ts = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return `${ts} ${level.padEnd(5)} [${tag}] ${msg}`;
}

function write(level: string, tag: string, args: unknown[]): void {
  const msg = args
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : JSON.stringify(a)))
    .join(" ");
  const line = fmt(level, tag, msg);
  if (!quiet || level === "ERROR") {
    const out = level === "ERROR" ? process.stderr : process.stdout;
    out.write(line + "\n");
  }
  if (logFile) {
    try {
      appendFileSync(logFile, line + "\n");
    } catch {
      /* disk full etc. — never crash on logging */
    }
  }
}

export function log(tag: string, ...args: unknown[]): void {
  write("INFO", tag, args);
}

export function warn(tag: string, ...args: unknown[]): void {
  write("WARN", tag, args);
}

export function error(tag: string, ...args: unknown[]): void {
  write("ERROR", tag, args);
}

export function debug(tag: string, ...args: unknown[]): void {
  if (process.env.ANI_DEBUG) write("DEBUG", tag, args);
}
