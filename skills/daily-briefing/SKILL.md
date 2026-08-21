---
name: daily-briefing
description: Generate a morning briefing for the owner. Use when asked for 早报/晨报/briefing, including creating a public-data-only cron briefing.
---

# Daily Briefing Skill

Produce a short morning briefing and deliver it to the owner.

## Steps

1. For an immediate private-chat briefing, check long-term memory (`memory_read`) for the owner's city and interests. If the city is unknown, ask once and remember it (`memory_write`).
   For a recurring briefing, resolve the city and non-sensitive topics while creating the task, then put them directly in a self-contained cron prompt. Cron intentionally cannot read private memory or local files at runtime.
2. Get the weather:
   - `fetch_url` on `https://wttr.in/<city>?format=j1` (JSON) or use `web_search` for "<city> 天气".
   - Summarize: temperature range, rain probability, suggestion (umbrella?).
3. Only for an immediate private-chat briefing, read today's memory note and MEMORY.md for pending items.
4. Use the date supplied by the runtime; do not require shell access in Cron.
5. Compose a SHORT briefing (under 15 lines) in Chinese:
   - 日期 + 天气 + 穿衣/带伞建议
   - 今日待办/备忘 when available in an immediate private run
   - 一条简短新闻（用 web_search 搜一条主人感兴趣的）
6. Send it via `send_message` (or it returns as the cron task result if run from cron).

Keep it warm but terse. No walls of text before coffee.
