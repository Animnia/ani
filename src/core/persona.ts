/**
 * System prompt assembly: persona (人设) + environment facts + skills list +
 * a pointer to long-term memory. Rebuilt per run — persona/skills edits take
 * effect on the next message, no restart needed.
 */
import { existsSync, readFileSync } from "node:fs";
import { PATHS } from "./config.ts";
import { enabledSkills, loadSkills, skillsPrompt } from "./skills.ts";
import { platform, release } from "node:os";

const DEFAULT_PERSONA = "You are Ani, a personal agent. Be concise, capable, and honest. Reply in the user's language.";

export function buildSystemPrompt(): string {
  let persona = DEFAULT_PERSONA;
  try {
    if (existsSync(PATHS.personaFile)) persona = readFileSync(PATHS.personaFile, "utf8").trim();
  } catch {
    /* use default */
  }

  const skills = enabledSkills(loadSkills([PATHS.skillsDir, join_homedir_skills()]));

  // USER.md — the living profile of the owner. Grows over time; the agent
  // maintains it via the user_profile tool. This is what makes ani "know"
  // its owner better every week.
  let userBrief = "";
  try {
    if (existsSync(PATHS.userFile)) {
      const u = readFileSync(PATHS.userFile, "utf8").trim();
      if (u) {
        userBrief = `\n\n<owner_profile path="${PATHS.userFile}">\n${u.slice(0, 4000)}\n</owner_profile>\nThis is what you know about your owner. Keep it current with the user_profile tool: when they reveal preferences, habits, identity facts, or correct a wrong assumption, update the profile. Record who they ARE, not conversation logs.`;
      }
    }
  } catch {
    /* no profile yet */
  }
  if (!userBrief) {
    userBrief = `\n\nYou keep a profile of your owner at ${PATHS.userFile} (currently empty). When they reveal preferences/habits/identity facts, record them with the user_profile tool — you should know your owner better over time.`;
  }

  let memoryBrief = "";
  try {
    if (existsSync(PATHS.memoryFile)) {
      const mem = readFileSync(PATHS.memoryFile, "utf8").trim();
      if (mem) {
        memoryBrief = `\n\n<long_term_memory path="${PATHS.memoryFile}">\n${mem.slice(0, 6000)}\n</long_term_memory>\nThis is your long-term memory. Update it with the memory_write tool when you learn durable facts (preferences, important dates, account IDs, project state...). Use memory_search to recall older notes.`;
      }
    }
  } catch {
    /* no memory yet */
  }
  if (!memoryBrief) {
    memoryBrief = `\n\nYou have long-term memory at ${PATHS.memoryFile} (currently empty). Use the memory_write tool to record durable facts; use memory_search to recall older notes.`;
  }

  const env = [
    `Current time: ${new Date().toString()}`,
    `OS: ${platform()} ${release()} (Windows)`,
    `Project dir (your home): ${PATHS.root}`,
    `Shell: Windows — use the shell tool with cmd or powershell syntax.`,
  ].join("\n");

  return `${persona}

<environment>
${env}
</environment>

<capabilities>
You run autonomously on the owner's machine with full control of it. You can:
- run any shell command (shell tool) — install software, manage files, query system state (respect the OS in <environment>)
- read/write/edit files anywhere on disk (file tools)
- search the web and fetch pages (web tools)
- drive a real Chrome/Edge browser via CDP (browser tool) — its persistent profile keeps logins, which avoids most captchas; prefer it over raw fetching for JS-heavy or login-walled pages
- remember things long-term (memory tools), schedule recurring/one-shot tasks (cron tool)
- message the owner on any connected channel and send files (messaging tools)
- use MCP server tools (mcp_* tools) if any are configured
${skillsPrompt(skills)}
</capabilities>

<rules>
- Be terse in chat replies. Long content → save to a file and send the file.
- Confirm before destructive/irreversible actions (delete, overwrite, purchases, messaging third parties).
- When a task needs multiple steps, just do them — don't narrate plans at length.
- Never invent file paths, URLs, or command output. Verify with tools.
${memoryBrief}${userBrief}
</rules>`;
}

function join_homedir_skills(): string {
  // reuse skills shared with pi/hermes harnesses if present
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return home ? `${home}/.agents/skills` : "/nonexistent";
}
