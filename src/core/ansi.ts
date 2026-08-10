/**
 * Zero-dep ANSI styling. Every helper is a no-op string passthrough when the
 * output isn't a color-capable TTY (piped, NO_COLOR, dumb term) so tests and
 * redirects never see escape bytes.
 */
export const useColor: boolean =
  !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const wrap = (open: string, close: string) => (s: string): string =>
  useColor ? open + s + close : s;

export const bold = wrap("\x1b[1m", "\x1b[22m");
export const dim = wrap("\x1b[2m", "\x1b[22m");
export const italic = wrap("\x1b[3m", "\x1b[23m");
export const underline = wrap("\x1b[4m", "\x1b[24m");
export const inverse = wrap("\x1b[7m", "\x1b[27m");
export const strike = wrap("\x1b[9m", "\x1b[29m");
export const red = wrap("\x1b[31m", "\x1b[39m");
export const green = wrap("\x1b[32m", "\x1b[39m");
export const yellow = wrap("\x1b[33m", "\x1b[39m");
export const cyan = wrap("\x1b[36m", "\x1b[39m");
export const gray = wrap("\x1b[90m", "\x1b[39m");
