/** markdown-lite: parser, Telegram HTML renderer, terminal streamer. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, toTelegramHtml, TerminalMdStream } from "../src/core/markdown.ts";

test("parser: bold / italic / code / strike / link", () => {
  const segs = parseMarkdown("a **bold** b *it* c `x<y` d ~~gone~~ e [t](https://x.y/z)");
  const flat = segs.map((s) => `${s.t}:${s.s}`).join("|");
  assert.ok(flat.includes("bold:bold"), flat);
  assert.ok(flat.includes("italic:it"), flat);
  assert.ok(flat.includes("code:x<y"), flat);
  assert.ok(flat.includes("strike:gone"), flat);
  assert.ok(segs.some((s) => s.t === "link" && s.url === "https://x.y/z"), flat);
});

test("parser: fenced code block keeps contents verbatim, lang captured", () => {
  const segs = parseMarkdown("before\n```ts\nconst **notBold** = 1;\n```\nafter");
  const block = segs.find((s) => s.t === "codeblock");
  assert.ok(block && block.t === "codeblock");
  assert.equal(block.lang, "ts");
  assert.equal(block.s, "const **notBold** = 1;");
  assert.ok(segs.some((s) => s.t === "text" && s.s.includes("after")));
});

test("parser: headings", () => {
  const segs = parseMarkdown("## 标题\n正文");
  assert.ok(segs.some((s) => s.t === "heading" && s.level === 2 && s.s === "标题"));
});

test("telegram html: escapes html, wraps styles", () => {
  const html = toTelegramHtml("**加粗** 与 `<tag>` 与 [链](https://a.b/c?d=1&e=2)");
  assert.ok(html.includes("<b>加粗</b>"), html);
  assert.ok(html.includes("<code>&lt;tag&gt;</code>"), html);
  assert.ok(html.includes('<a href="https://a.b/c?d=1&amp;e=2">链</a>'), html);
  assert.ok(!html.includes("<tag>"), html);
});

test("telegram html: fence becomes pre, heading becomes bold", () => {
  const html = toTelegramHtml("# 大标题\n```\n<raw>\n```");
  assert.ok(html.includes("<b>大标题</b>"), html);
  assert.ok(html.includes("<pre><code>&lt;raw&gt;</code></pre>"), html);
});

test("terminal streamer: buffers partial lines, tracks fences, strips markers", () => {
  let out = "";
  const st = new TerminalMdStream((s) => (out += s));
  st.push("hel");
  assert.equal(out, ""); // nothing emitted before newline
  st.push("lo **wo");
  st.push("rld**\n```js\nx");
  st.push(" = 1\n```\ndone");
  st.end();
  // markers never leak through; content does
  assert.ok(!out.includes("**"), out);
  assert.ok(out.includes("hello"), out);
  assert.ok(out.includes("world"), out);
  assert.ok(out.includes("x = 1"), out);
  assert.ok(out.includes("done"), out);
});

test("terminal streamer: markers stripped even without color (tests run piped)", () => {
  let out = "";
  const st = new TerminalMdStream((s) => (out += s));
  st.push("**b**\n");
  st.end();
  assert.equal(out, "b\n"); // parsed + unstyled under piped stdio (useColor=false)
});
