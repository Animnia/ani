/**
 * Skills — pi-style progressive disclosure. At startup we scan skill dirs and
 * put name+description into the system prompt. The agent reads the full
 * SKILL.md with its file tools when a task matches. No special machinery.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { debug } from "./log.ts";

export interface SkillInfo {
  name: string;
  description: string;
  path: string; // absolute path to SKILL.md
}

function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[1] === "name") out.name = kv[2].trim();
    if (kv[1] === "description") out.description = kv[2].trim();
  }
  return out;
}

function scanDir(dir: string, out: SkillInfo[], depth: number): void {
  if (depth > 4 || !existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const skillFile = join(full, "SKILL.md");
      if (existsSync(skillFile)) {
        try {
          const fm = parseFrontmatter(readFileSync(skillFile, "utf8"));
          if (fm.description) {
            out.push({ name: fm.name ?? name, description: fm.description, path: skillFile });
            continue; // don't descend into a skill's own dirs
          }
        } catch {
          /* fall through to recursion */
        }
      }
      scanDir(full, out, depth + 1);
    } else if (depth === 0 && name.endsWith(".md")) {
      // root-level .md files act as single-file skills (pi behavior)
      try {
        const fm = parseFrontmatter(readFileSync(full, "utf8"));
        if (fm.description) out.push({ name: fm.name ?? name.replace(/\.md$/, ""), description: fm.description, path: full });
      } catch {
        /* skip */
      }
    }
  }
}

export function loadSkills(dirs: string[]): SkillInfo[] {
  const out: SkillInfo[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    scanDir(dir, out, 0);
  }
  const uniq = out.filter((s) => {
    const key = s.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  debug("skills", `loaded: ${uniq.map((s) => s.name).join(", ") || "(none)"}`);
  return uniq;
}

/** XML block for the system prompt, per the Agent Skills spec. */
export function skillsPrompt(skills: SkillInfo[]): string {
  if (!skills.length) return "";
  const items = skills
    .map((s) => `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.path}</location>\n  </skill>`)
    .join("\n");
  return `<available_skills>\n${items}\n</available_skills>\nWhen a task matches a skill, read its SKILL.md file first (use the read_file tool with the location path), then follow its instructions.`;
}
