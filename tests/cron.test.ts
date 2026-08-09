/**
 * cron schedule parsing + nextRunAt — pure logic, fast timeouts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSchedule, nextRunAt } from "../src/tools/cron.ts";

test("@every intervals", { timeout: 5000 }, () => {
  assert.equal(parseSchedule("@every 30m").intervalMs, 30 * 60_000);
  assert.equal(parseSchedule("@every 2h").intervalMs, 7_200_000);
  assert.equal(parseSchedule("@every 1d").intervalMs, 86_400_000);
  assert.throws(() => parseSchedule("@every 1s"), /too small/);
});

test("@daily", { timeout: 5000 }, () => {
  const p = parseSchedule("@daily 09:30");
  assert.ok(p.match(new Date(2026, 0, 5, 9, 30)));
  assert.ok(!p.match(new Date(2026, 0, 5, 9, 31)));
  assert.throws(() => parseSchedule("@daily 25:00"), /bad @daily/);
});

test("5-field cron matching", { timeout: 5000 }, () => {
  const every15 = parseSchedule("*/15 * * * *");
  assert.ok(every15.match(new Date(2026, 0, 5, 10, 30)));
  assert.ok(!every15.match(new Date(2026, 0, 5, 10, 31)));

  const workdayMorning = parseSchedule("30 8 * * 1-5");
  // 2026-01-05 is a Monday
  assert.ok(workdayMorning.match(new Date(2026, 0, 5, 8, 30)));
  assert.ok(!workdayMorning.match(new Date(2026, 0, 5, 8, 31)));
  // 2026-01-03 is a Saturday
  assert.ok(!workdayMorning.match(new Date(2026, 0, 3, 8, 30)));

  // Sunday: both 0 and 7 must match (2026-01-04 is a Sunday)
  assert.ok(parseSchedule("0 9 * * 0").match(new Date(2026, 0, 4, 9, 0)));
  assert.ok(parseSchedule("0 9 * * 7").match(new Date(2026, 0, 4, 9, 0)));

  const lists = parseSchedule("0 9,12,18 * * *");
  assert.ok(lists.match(new Date(2026, 0, 5, 12, 0)));
  assert.ok(!lists.match(new Date(2026, 0, 5, 13, 0)));
});

test("cron validation errors", { timeout: 5000 }, () => {
  assert.throws(() => parseSchedule("99 * * * *"), /out of range/);
  assert.throws(() => parseSchedule("* * *"), /bad schedule/);
  assert.throws(() => parseSchedule("a b c d e"), /bad cron field/);
});

test("nextRunAt computes a future time", { timeout: 10_000 }, () => {
  const now = Date.now();
  const next = nextRunAt("*/5 * * * *", now);
  assert.ok(next && next > now && next <= now + 5 * 60_000 + 60_000, `next=${next} now=${now}`);
  const d = new Date(next!);
  assert.equal(d.getMinutes() % 5, 0);

  const daily = nextRunAt("@daily 08:00", now);
  assert.ok(daily && daily > now && daily <= now + 86_400_000 + 60_000);

  const every = nextRunAt("@every 30m", now);
  assert.ok(every && every <= now + 60_000);

  const hourly = nextRunAt("@hourly", now);
  assert.ok(hourly && new Date(hourly).getMinutes() === 0);
});
