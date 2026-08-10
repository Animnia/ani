/**
 * Skill enable/disable state + owner profile (USER.md) wiring.
 * ANI_CONFIG redirects all state into a temp dir — real data/ stays clean.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ani-skills-"));
process.env.ANI_CONFIG = join(dir, "ani.json");

let skills: typeof import("../src/core/skills.ts");
let persona: typeof import("../src/core/persona.ts");
let memory: typeof import("../src/tools/memory.ts");
let PATHS: (typeof import("../src/core/config.ts"))["PATHS"];

before(async () => {
  writeFileSync(process.env.ANI_CONFIG!, JSON.stringify({ deepseek: { apiKey: "x" } }));
  // a project skill + a global skill to detect
  mkdirSync(join(dir, "proj-skill"), { recursive: true });
  writeFileSync(join(dir, "proj-skill", "SKILL.md"), "---\nname: proj-skill\ndescription: project scope thing\n---\ndo it\n");
  skills = await import("../src/core/skills.ts");
  persona = await import("../src/core/persona.ts");
  memory = await import("../src/tools/memory.ts");
  ({ PATHS } = await import("../src/core/config.ts"));
});

test("listSkills auto-detects and defaults to enabled", () => {
  const dirs = { project: dir, global: "/nonexistent" };
  const list = skills.listSkills(dirs);
  const s = list.find((x) => x.name === "proj-skill");
  assert.ok(s, "skill discovered");
  assert.equal(s.scope, "project");
  assert.equal(s.enabled, true);
});

test("setSkillEnabled persists and filters the prompt list", () => {
  const dirs = { project: dir, global: "/nonexistent" };
  assert.equal(skills.setSkillEnabled(dirs, "proj-skill", false), true);
  assert.equal(skills.listSkills(dirs)[0].enabled, false);
  assert.equal(skills.enabledSkills(skills.loadSkills([dir])).length, 0);
  assert.equal(skills.setSkillEnabled(dirs, "proj-skill", true), true);
  assert.equal(skills.listSkills(dirs)[0].enabled, true);
  assert.equal(skills.setSkillEnabled(dirs, "nope", false), false); // unknown name
});

test("user_profile tool: append/read/set roundtrip", async () => {
  const ctx = {} as never;
  assert.match(await memory.userProfileTool.execute({ action: "append", content: "喜欢深夜写代码" }, ctx), /Appended/);
  assert.match(await memory.userProfileTool.execute({ action: "append", content: "喝美式不加糖" }, ctx), /Appended/);
  const read = await memory.userProfileTool.execute({ action: "read" }, ctx);
  assert.ok(read.includes("喜欢深夜写代码") && read.includes("喝美式不加糖"), read);
  await memory.userProfileTool.execute({ action: "set", content: "# 主人\n- 夜猫子" }, ctx);
  const read2 = await memory.userProfileTool.execute({ action: "read" }, ctx);
  assert.ok(read2.includes("夜猫子") && !read2.includes("美式"), read2);
});

test("owner profile is injected into the system prompt", async () => {
  await memory.userProfileTool.execute({ action: "set", content: "主人是独立开发者" }, {} as never);
  const prompt = persona.buildSystemPrompt();
  assert.ok(prompt.includes("<owner_profile"), prompt.slice(-800));
  assert.ok(prompt.includes("主人是独立开发者"), prompt.slice(-800));
  assert.ok(prompt.includes(PATHS.userFile), "path surfaced");
});

test("empty profile still teaches the tool path", () => {
  writeFileSync(PATHS.userFile, "");
  const prompt = persona.buildSystemPrompt();
  assert.ok(prompt.includes("user_profile"), prompt.slice(-600));
});
