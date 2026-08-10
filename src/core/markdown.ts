/**
 * Markdown-lite: just the subset a chat model actually emits, parsed into
 * flat segments and rendered per target — Telegram HTML, or ANSI terminal.
 *
 * Supported: fenced code blocks, inline `code`, **bold** / __bold__,
 * *italic*, ~~strike~~, [links](url), # headings. Everything else passes
 * through untouched. Deliberately NOT a full markdown parser.
 */
import { bold as aBold, dim, inverse, italic as aItalic, strike as aStrike, underline } from "./ansi.ts";

export type MdSeg =
  | { t: "text"; s: string }
  | { t: "bold"; s: string }
  | { t: "italic"; s: string }
  | { t: "strike"; s: string }
  | { t: "code"; s: string }
  | { t: "codeblock"; s: string; lang: string }
  | { t: "link"; s: string; url: string }
  | { t: "heading"; s: string; level: number };

/** Split text segments by `re`; captured groups become new segments via `make`. */
function splitSegs(segs: MdSeg[], re: RegExp, make: (m: RegExpMatchArray) => MdSeg): MdSeg[] {
  const out: MdSeg[] = [];
  for (const seg of segs) {
    if (seg.t !== "text") {
      out.push(seg);
      continue;
    }
    let rest = seg.s;
    let m: RegExpMatchArray | null;
    while ((m = rest.match(re))) {
      const idx = m.index ?? 0;
      if (idx > 0) out.push({ t: "text", s: rest.slice(0, idx) });
      out.push(make(m));
      rest = rest.slice(idx + m[0].length);
    }
    if (rest) out.push({ t: "text", s: rest });
  }
  return out;
}

function parseInline(s: string): MdSeg[] {
  let segs: MdSeg[] = [{ t: "text", s }];
  segs = splitSegs(segs, /`([^`\n]+)`/, (m) => ({ t: "code", s: m[1] }));
  segs = splitSegs(segs, /\[([^\]\n]+)\]\((https?:[^)\s]+)\)/, (m) => ({ t: "link", s: m[1], url: m[2] }));
  segs = splitSegs(segs, /\*\*([^*\n]+)\*\*|__([^_\n]+)__/, (m) => ({ t: "bold", s: m[1] ?? m[2] }));
  segs = splitSegs(segs, /~~([^~\n]+)~~/, (m) => ({ t: "strike", s: m[1] }));
  // single-* italic is safe only after ** is gone
  segs = splitSegs(segs, /\*([^*\n]+)\*/, (m) => ({ t: "italic", s: m[1] }));
  return segs;
}

export function parseMarkdown(src: string): MdSeg[] {
  const out: MdSeg[] = [];
  // fenced blocks first; they may contain anything
  const fenceRe = /```(\w*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(src))) {
    if (m.index > last) pushText(out, src.slice(last, m.index));
    out.push({ t: "codeblock", s: m[2].replace(/\n$/, ""), lang: m[1] });
    last = m.index + m[0].length;
  }
  if (last < src.length) pushText(out, src.slice(last));
  return out;
}

/** Line-wise handling (headings) then inline parsing for a fence-free chunk. */
function pushText(out: MdSeg[], chunk: string): void {
  const lines = chunk.split("\n");
  lines.forEach((line, i) => {
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      out.push({ t: "heading", s: h[2], level: h[1].length });
    } else {
      out.push(...parseInline(line));
    }
    if (i < lines.length - 1) out.push({ t: "text", s: "\n" });
  });
}

// ---------------------------------------------------------- Telegram HTML

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function toTelegramHtml(src: string): string {
  return parseMarkdown(src)
    .map((seg) => {
      switch (seg.t) {
        case "bold": return `<b>${esc(seg.s)}</b>`;
        case "italic": return `<i>${esc(seg.s)}</i>`;
        case "strike": return `<s>${esc(seg.s)}</s>`;
        case "code": return `<code>${esc(seg.s)}</code>`;
        case "codeblock": return `<pre><code${seg.lang ? ` class="language-${esc(seg.lang)}"` : ""}>${esc(seg.s)}</code></pre>`;
        case "link": return `<a href="${esc(seg.url)}">${esc(seg.s)}</a>`;
        case "heading": return `<b>${esc(seg.s)}</b>`;
        default: return esc(seg.s);
      }
    })
    .join("");
}

// ------------------------------------------------------------- terminal

function renderInlineTerminal(s: string): string {
  return parseInline(s)
    .map((seg) => {
      switch (seg.t) {
        case "bold": return aBold(seg.s);
        case "italic": return aItalic(seg.s);
        case "strike": return aStrike(seg.s);
        case "code": return inverse(` ${seg.s} `);
        case "link": return `${underline(seg.s)}${dim(` (${seg.url})`)}`;
        default: return seg.s;
      }
    })
    .join("");
}

/** Render a complete markdown string for the terminal (non-streaming use). */
export function toTerminal(src: string): string {
  const parts: string[] = [];
  const st = new TerminalMdStream((s) => parts.push(s));
  st.push(src);
  st.end();
  return parts.join("");
}

/**
 * Incremental terminal renderer for streamed model output. Deltas are
 * buffered until a full line arrives (markdown markers can't be styled
 * half-arrived), code-fence state is tracked across lines. Styles spanning
 * multiple lines simply render unstyled — an accepted trade-off.
 */
export class TerminalMdStream {
  private buf = "";
  private fence = false;
  private write: (s: string) => void;
  constructor(write: (s: string) => void) {
    this.write = write;
  }

  push(delta: string): void {
    this.buf += delta;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      this.line(this.buf.slice(0, i));
      this.write("\n");
      this.buf = this.buf.slice(i + 1);
    }
  }

  end(): void {
    if (this.buf) {
      this.line(this.buf);
      this.buf = "";
    }
  }

  private line(l: string): void {
    if (l.trimStart().startsWith("```")) {
      this.fence = !this.fence;
      this.write(dim(l));
      return;
    }
    if (this.fence) {
      this.write(dim(l));
      return;
    }
    const h = l.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      this.write(aBold(underline(renderInlineTerminal(h[2]))));
      return;
    }
    this.write(renderInlineTerminal(l));
  }
}
