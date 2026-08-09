/**
 * Channel shared helpers.
 */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    // prefer splitting at a newline or sentence end near the limit
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) {
      const m = /[。！？.!?；;，,、\s](?=[^。！？.!?；;，,、\s]*$)/.exec(rest.slice(0, max + 1));
      cut = m && m.index > max * 0.5 ? m.index + 1 : max;
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.trim()) out.push(rest);
  return out;
}

export class DedupSet {
  private seen = new Set<string>();
  private order: string[] = [];
  private cap: number;
  constructor(cap = 500) {
    this.cap = cap;
  }
  has(id: string): boolean {
    return this.seen.has(id);
  }
  add(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.cap) {
      const old = this.order.shift()!;
      this.seen.delete(old);
    }
  }
}
