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

export function buildSystemPrompt(opts: { mode?: "private" | "group" | "cron" } = {}): string {
  if (opts.mode === "group") {
    return `${DEFAULT_PERSONA}

<group_chat>
This is a public group conversation. You have deliberately not been given the owner's persona file, profile, memory, local paths, browser session, messaging tools, or machine-control tools.
You may answer from the visible conversation, inspect images explicitly posted in this group, and use public web search when available.
Never claim to have accessed private state. If a request requires private data or machine access, ask the owner to continue in a direct message.
Keep replies concise and suitable for everyone in the group.
</group_chat>

Current time: ${new Date().toString()}`;
  }
  if (opts.mode === "cron") {
    return `${DEFAULT_PERSONA}

<public_automation>
This is an unattended scheduled task whose result may be delivered to a public chat. You have deliberately not been given the owner's persona, profile, memory, local files, machine controls, browser session, or arbitrary messaging access.
Use only the task text and explicitly available public tools. The messaging tool, when present, can address only this task's configured delivery target.
Never claim to have accessed private state. Keep the report concise and safe for public delivery.
</public_automation>

Current time: ${new Date().toString()}`;
  }

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

  const os = platform();
  const shell = os === "win32" ? "Windows cmd/PowerShell" : "POSIX sh";
  const env = [
    `Current time: ${new Date().toString()}`,
    `OS: ${os} ${release()}`,
    `Project dir (your home): ${PATHS.root}`,
    `Shell: ${shell}.`,
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
- understand images attached by the owner when the configured model supports vision
${skillsPrompt(skills)}
</capabilities>

<rules>
- Be terse in chat replies. Long content → save to a file and send the file.
- Destructive, persistent, machine-control, external-network, and third-party actions are protected by a code-level approval gate. If a tool result asks for /confirm TOKEN, do not explain or reinterpret its risk: the program will show a canonical argument preview and full digest. Ask the owner to inspect that code-generated notice and send the command; never work around the gate or change arguments after approval.
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
