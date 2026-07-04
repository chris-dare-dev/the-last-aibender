/**
 * Synthetic TUI child — an honest headless proxy for the claude TUI
 * (we never spawn the real claude binary in spikes: no real accounts,
 * no subscription quota). Plain CommonJS, zero deps, runs under node.
 *
 * Behavior exercised by both PTY harnesses:
 *   - reports whether stdin/stdout are TTYs           -> "TTY <in> <out>"
 *   - reports initial terminal size                   -> "SIZE <cols>x<rows>"
 *   - on SIGWINCH reports the new size                -> "RESIZE <cols>x<rows>"
 *   - echoes stdin bytes (raw mode)                   -> "ECHO <printable>"
 *   - emits ANSI color/cursor noise like a real TUI (bytes only; the
 *     harness never parses semantics out of them — blueprint rule)
 *   - exits 0 on receiving "q"
 */
"use strict";

const out = (s) => process.stdout.write(s + "\r\n");

out(`TTY ${process.stdin.isTTY ? 1 : 0} ${process.stdout.isTTY ? 1 : 0}`);
out(`SIZE ${process.stdout.columns || 0}x${process.stdout.rows || 0}`);
// ANSI noise a real TUI would produce (SGR color + cursor save/restore)
process.stdout.write("\x1b[38;5;214mAIBENDER-SIM\x1b[0m\x1b7\x1b8\r\n");

process.on("SIGWINCH", () => {
  out(`RESIZE ${process.stdout.columns || 0}x${process.stdout.rows || 0}`);
});

if (process.stdin.isTTY && process.stdin.setRawMode) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on("data", (buf) => {
  const s = buf.toString("utf8");
  out(`ECHO ${JSON.stringify(s)}`);
  if (s.includes("q")) {
    out("BYE");
    process.exit(0);
  }
});

// Heartbeat so slow readers always have bytes flowing.
const hb = setInterval(() => out("HB"), 500);
hb.unref?.();
