---
name: daily-briefing
description: Generate a morning briefing for the owner — weather, schedule notes from memory, pending tasks. Use when asked for 早报/晨报/briefing, or from a cron task that delivers it every morning.
---

# Daily Briefing Skill

Produce a short morning briefing and deliver it to the owner.

## Steps

1. Check long-term memory (`memory_read`) for the owner's city and interests.
   If the city is unknown, ask once and remember it (`memory_write`).
2. Get the weather:
   - `fetch_url` on `https://wttr.in/<city>?format=j1` (JSON) or use `web_search` for "<city> 天气".
   - Summarize: temperature range, rain probability, suggestion (umbrella?).
3. Read today's memory note (`memory_read` with today's date) and MEMORY.md for pending items.
4. Optionally check local system date/time with `shell` (`date /t & time /t`).
5. Compose a SHORT briefing (under 15 lines) in Chinese:
   - 日期 + 天气 + 穿衣/带伞建议
   - 今日待办/备忘 (from memory)
   - 一条简短新闻（用 web_search 搜一条主人感兴趣的）
6. Send it via `send_message` (or it returns as the cron task result if run from cron).

Keep it warm but terse. No walls of text before coffee.
