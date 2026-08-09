/**
 * Scheduled tasks. data/cron.json holds entries; a 30s ticker fires due ones.
 * Schedule syntax:
 *   "@every 30m" / "@every 2h"   — fixed interval
 *   "@daily 09:30"               — once a day at local time
 *   "0,15,30,45 * * * *"         — 5-field cron (min hour dom month dow; dom & dow
 *                                  are ANDed, not ORed like classic cron — keep it simple)
 *   Slash steps like star-slash-15 also work (written here to avoid
 *   closing this comment early).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PATHS } from "../core/config.ts";
import { log, warn } from "../core/log.ts";
import type { ToolDef } from "../core/types.ts";

export interface CronTask {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  /** chatKey like "telegram:123" / "qq:openid" / "cli:local" */
  target: string;
  enabled: boolean;
  lastRunAt?: number;
  lastResult?: string;
}

type Runner = (task: CronTask) => Promise<void>;

interface Parsed {
  match(d: Date): boolean;
  /** for @every: interval ms */
  intervalMs?: number;
}

function fieldMatcher(field: string, min: number, max: number): (n: number) => boolean {
  const allow = new Set<number>();
  for (const part of field.split(",")) {
    const stepM = /^(.+)\/(\d+)$/.exec(part);
    const range = stepM ? stepM[1] : part;
    const step = stepM ? Number(stepM[2]) : 1;
    if (step <= 0) throw new Error(`bad step in "${field}"`);
    let lo: number, hi: number;
    if (range === "*") {
      lo = min; hi = max;
    } else if (/^\d+$/.test(range)) {
      lo = hi = Number(range);
    } else {
      const rm = /^(\d+)-(\d+)$/.exec(range);
      if (!rm) throw new Error(`bad cron field "${part}"`);
      lo = Number(rm[1]); hi = Number(rm[2]);
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron field out of range: "${part}" (${min}-${max})`);
    for (let n = lo; n <= hi; n += step) allow.add(n);
  }
  if (!allow.size) throw new Error(`empty cron field "${field}"`);
  // cron dow: both 0 and 7 mean Sunday — normalize so either matches
  if (min === 0 && max === 7) {
    if (allow.has(0)) allow.add(7);
    if (allow.has(7)) allow.add(0);
  }
  return (n) => allow.has(n);
}

export function parseSchedule(schedule: string): Parsed {
  const s = schedule.trim();
  let m = /^@every\s+(\d+)\s*(s|m|h|d)$/i.exec(s);
  if (m) {
    const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase()]!;
    const intervalMs = Number(m[1]) * mult;
    if (intervalMs < 10_000) throw new Error("interval too small (min 10s)");
    return { intervalMs, match: () => true };
  }
  m = /^@daily\s+(\d{1,2}):(\d{2})$/i.exec(s);
  if (m) {
    const hh = Number(m[1]), mm = Number(m[2]);
    if (hh > 23 || mm > 59) throw new Error(`bad @daily time "${s}"`);
    return { match: (d) => d.getHours() === hh && d.getMinutes() === mm };
  }
  if (s === "@hourly") return { match: (d) => d.getMinutes() === 0 };
  const fields = s.split(/\s+/);
  if (fields.length !== 5) throw new Error(`bad schedule "${s}" — use "@every 30m", "@daily 09:30", or 5-field cron`);
  const [minM, hourM, domM, monM, dowM] = [
    fieldMatcher(fields[0], 0, 59),
    fieldMatcher(fields[1], 0, 23),
    fieldMatcher(fields[2], 1, 31),
    fieldMatcher(fields[3], 1, 12),
    fieldMatcher(fields[4], 0, 7),
  ];
  return {
    match: (d) =>
      minM(d.getMinutes()) &&
      hourM(d.getHours()) &&
      monM(d.getMonth() + 1) &&
      domM(d.getDate()) &&
      dowM(d.getDay()), // getDay(): 0=Sunday; the dow matcher accepts both 0 and 7
  };
}

/** Next fire time after `from` (ms epoch), or null if none within a year. */
export function nextRunAt(schedule: string, from: number, lastRun?: number): number | null {
  const p = parseSchedule(schedule);
  if (p.intervalMs) return (lastRun && lastRun + p.intervalMs > from ? lastRun + p.intervalMs : from + 1_000);
  // iterate minute-by-minute, bounded to ~1 year; cheap because we skip days fast
  let t = new Date(from);
  t.setSeconds(0, 0);
  t = new Date(t.getTime() + 60_000);
  for (let i = 0; i < 527_040; i++) {
    if (p.match(t)) return t.getTime();
    t = new Date(t.getTime() + 60_000);
  }
  return null;
}

export class CronService {
  private tasks: CronTask[] = [];
  private nextAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();
  private runner: Runner;

  constructor(runner: Runner) {
    this.runner = runner;
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(PATHS.cronFile)) {
        const arr = JSON.parse(readFileSync(PATHS.cronFile, "utf8")) as CronTask[];
        this.tasks = arr.filter((t) => t.id && t.schedule && t.prompt);
      }
    } catch (e) {
      warn("cron", "failed to load cron.json:", e);
      this.tasks = [];
    }
    for (const t of this.tasks) this.recompute(t);
  }

  private save(): void {
    mkdirSync(PATHS.data, { recursive: true });
    writeFileSync(PATHS.cronFile, JSON.stringify(this.tasks, null, 2));
  }

  private recompute(t: CronTask): void {
    try {
      const n = nextRunAt(t.schedule, Date.now(), t.lastRunAt);
      if (n) this.nextAt.set(t.id, n);
      else this.nextAt.delete(t.id);
    } catch (e) {
      warn("cron", `bad schedule for "${t.name}": ${e instanceof Error ? e.message : e}`);
      this.nextAt.delete(t.id);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref?.();
    log("cron", `scheduler started (${this.tasks.filter((t) => t.enabled).length} enabled tasks)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const t of this.tasks) {
      if (!t.enabled || this.running.has(t.id)) continue;
      const due = this.nextAt.get(t.id);
      if (!due || due > now) continue;
      this.running.add(t.id);
      t.lastRunAt = now;
      this.recompute(t);
      this.save();
      log("cron", `firing "${t.name}" → ${t.target}`);
      this.runner(t)
        .catch((e) => warn("cron", `task "${t.name}" failed: ${e instanceof Error ? e.message : e}`))
        .finally(() => this.running.delete(t.id));
    }
  }

  list(): CronTask[] {
    return this.tasks.map((t) => ({ ...t }));
  }

  add(input: Omit<CronTask, "id" | "enabled"> & { enabled?: boolean }): CronTask {
    parseSchedule(input.schedule); // validate first
    const task: CronTask = { ...input, id: randomUUID().slice(0, 8), enabled: input.enabled ?? true };
    this.tasks.push(task);
    this.recompute(task);
    this.save();
    return task;
  }

  remove(id: string): boolean {
    const n = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id && t.name !== id);
    this.nextAt.delete(id);
    if (this.tasks.length !== n) this.save();
    return this.tasks.length !== n;
  }

  toggle(id: string, enabled: boolean): CronTask | null {
    const t = this.tasks.find((t) => t.id === id || t.name === id);
    if (!t) return null;
    t.enabled = enabled;
    this.recompute(t);
    this.save();
    return t;
  }

  nextOf(id: string): number | undefined {
    const t = this.tasks.find((t) => t.id === id || t.name === id);
    return t ? this.nextAt.get(t.id) : undefined;
  }
}

export function makeCronTool(service: CronService): ToolDef {
  return {
    name: "cron_manage",
    description:
      'Manage scheduled tasks. Actions: list | add | remove | toggle. Schedules: "@every 30m", "@daily 09:30", "@hourly", or 5-field cron "min hour dom month dow". A task runs `prompt` as an agent turn and delivers the result to target chat (default: the current chat).',
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "remove", "toggle"] },
        name: { type: "string", description: "Task name (add/remove/toggle)" },
        schedule: { type: "string", description: 'e.g. "@every 2h", "@daily 08:00", "30 8 * * 1-5"' },
        prompt: { type: "string", description: "Instruction to execute when the task fires" },
        target: { type: "string", description: "chatKey to deliver results to (default: current chat)" },
        enabled: { type: "boolean" },
      },
      required: ["action"],
    },
    async execute(args, ctx) {
      const action = String(args.action);
      if (action === "list") {
        const tasks = service.list();
        if (!tasks.length) return "(no scheduled tasks)";
        return tasks
          .map((t) => {
            const next = service.nextOf(t.id);
            return `- [${t.id}] ${t.name} — ${t.schedule} → ${t.target} ${t.enabled ? "enabled" : "DISABLED"}${next ? `, next: ${new Date(next).toLocaleString()}` : ""}${t.lastRunAt ? `, last: ${new Date(t.lastRunAt).toLocaleString()}` : ""}\n  prompt: ${t.prompt.slice(0, 120)}`;
          })
          .join("\n");
      }
      if (action === "add") {
        const name = String(args.name ?? "").trim();
        const schedule = String(args.schedule ?? "").trim();
        const prompt = String(args.prompt ?? "").trim();
        if (!name || !schedule || !prompt) return "Error: add needs name, schedule, prompt";
        try {
          const t = service.add({ name, schedule, prompt, target: String(args.target ?? ctx.chatKey), enabled: args.enabled !== false });
          const next = service.nextOf(t.id);
          return `Task "${t.name}" added [${t.id}], next run: ${next ? new Date(next).toLocaleString() : "never?"}`;
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : e}`;
        }
      }
      if (action === "remove") {
        const id = String(args.name ?? "").trim();
        return service.remove(id) ? `Removed ${id}` : `Error: no task "${id}"`;
      }
      if (action === "toggle") {
        const id = String(args.name ?? "").trim();
        const t = service.toggle(id, args.enabled !== false);
        return t ? `Task "${t.name}" ${t.enabled ? "enabled" : "disabled"}` : `Error: no task "${id}"`;
      }
      return `Error: unknown action "${action}"`;
    },
  };
}
