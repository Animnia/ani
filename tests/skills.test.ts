/**
 * Skill discovery + system prompt assembly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSkills, skillsPrompt } from "../src/core/skills.ts";
import { buildSystemPrompt } from "../src/core/persona.ts";
import { PATHS } from "../src/core/config.ts";

test("finds the bundled daily-briefing skill", { timeout: 5000 }, () => {
  const skills = loadSkills([PATHS.skillsDir]);
  const brief = skills.find((s) => s.name === "daily-briefing");
  assert.ok(brief, "daily-briefing skill discovered");
  assert.match(brief!.description, /morning briefing/i);
  assert.match(brief!.path, /SKILL\.md$/);
});

test("skillsPrompt renders XML block", { timeout: 5000 }, () => {
  const xml = skillsPrompt([{ name: "x", description: "does x", path: "/x/SKILL.md" }]);
  assert.match(xml, /<available_skills>/);
  assert.match(xml, /<name>x<\/name>/);
  assert.equal(skillsPrompt([]), "");
});

test("system prompt contains persona + capabilities", { timeout: 5000 }, () => {
  const p = buildSystemPrompt();
  assert.match(p, /Ani/); // from PERSONA.md
  assert.match(p, /<environment>/);
  assert.match(p, /daily-briefing/); // skills listed
  assert.match(p, /memory_write/); // memory pointer
});
