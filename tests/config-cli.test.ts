/** ani config set/show: type-safe edits, unknown-key refusal, key preservation. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ani-cfgcli-"));
process.env.ANI_CONFIG = join(dir, "ani.json");

const seed = {
  model: "deepseek-v4-flash",
  thinking: "enabled",
  proxy: "",
  _proxy_note: "documentation key — must survive edits",
  deepseek: { apiKey: "sk-test123456789", baseUrl: "https://api.deepseek.com" },
  channels: { telegram: { enabled: true, token: "111:abc", owners: ["42"] } },
  maxContextChars: 600000,
};

let setConfigValue: (typeof import("../src/config-cli.ts"))["setConfigValue"];
let showConfig: (typeof import("../src/config-cli.ts"))["showConfig"];

before(async () => {
  writeFileSync(process.env.ANI_CONFIG!, JSON.stringify(seed, null, 2));
  ({ setConfigValue, showConfig } = await import("../src/config-cli.ts"));
});

test("set: string / boolean / number / array coercion", () => {
  assert.equal(setConfigValue("model", "deepseek-v4-pro"), null);
  assert.equal(setConfigValue("channels.telegram.enabled", "false"), null);
  assert.equal(setConfigValue("maxContextChars", "700000"), null);
  assert.equal(setConfigValue("channels.telegram.owners", "42, 43"), null);
  const after = JSON.parse(readFileSync(process.env.ANI_CONFIG!, "utf8"));
  assert.equal(after.model, "deepseek-v4-pro");
  assert.equal(after.channels.telegram.enabled, false);
  assert.equal(after.maxContextChars, 700000);
  assert.deepEqual(after.channels.telegram.owners, ["42", "43"]);
});

test("set: wrong-type values are rejected, file untouched", () => {
  const beforeTxt = readFileSync(process.env.ANI_CONFIG!, "utf8");
  assert.ok(setConfigValue("maxContextChars", "not-a-number"));
  assert.ok(setConfigValue("channels.telegram.enabled", "maybe"));
  assert.equal(readFileSync(process.env.ANI_CONFIG!, "utf8"), beforeTxt);
});

test("set: unknown keys are refused with suggestions", () => {
  const err = setConfigValue("channels.telegram.tokne", "x");
  assert.ok(err?.includes("unknown key"), String(err));
  assert.ok(err?.includes("token"), String(err)); // sibling suggestion
  assert.ok(setConfigValue("nope.deeper", "x")?.includes("unknown key"));
});

test("unknown/documentation keys survive any edit", () => {
  setConfigValue("model", "deepseek-v4-flash");
  const after = JSON.parse(readFileSync(process.env.ANI_CONFIG!, "utf8"));
  assert.equal(after._proxy_note, seed._proxy_note);
});

test("show: secrets are masked, structure intact", () => {
  const out = showConfig();
  assert.ok(out.includes("deepseek.apiKey"), out);
  assert.ok(!out.includes("sk-test123456789"), out); // full secret never printed
  assert.ok(out.includes("sk-tes"), out); // recognizable prefix
  assert.ok(!out.includes("_proxy_note"), out); // doc keys hidden from listing
});

test("set --add: creates new sections/keys with inferred types", () => {
  assert.equal(setConfigValue("tavily.apiKey", "tvly-test-123", { allowNew: true }), null);
  assert.equal(setConfigValue("fresh.flag", "true", { allowNew: true }), null);
  assert.equal(setConfigValue("fresh.count", "42", { allowNew: true }), null);
  const after = JSON.parse(readFileSync(process.env.ANI_CONFIG!, "utf8"));
  assert.equal(after.tavily.apiKey, "tvly-test-123");
  assert.equal(after.fresh.flag, true);
  assert.equal(after.fresh.count, 42);
  // without --add those same paths would have been refused
  assert.ok(setConfigValue("another.new", "x")?.includes("--add"));
  // and existing unknown-key protection is intact
  assert.ok(setConfigValue("model.typo", "x")?.includes("unknown key"));
});
