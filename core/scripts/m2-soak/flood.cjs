#!/usr/bin/env node
/**
 * Synthetic flood TUI for the M2 gate soak (docs/runbooks/m2-dod.md).
 *
 * Emits `lineCount` seq-tagged lines to stdout (a real PTY — writes are
 * SYNCHRONOUS on POSIX TTYs, so a full kernel TTY buffer blocks this process
 * exactly like a real TUI under producer backpressure), then stays alive
 * until reaped by the ptyHost (`host.shutdown()` → process-group SIGKILL).
 * Staying alive keeps child-exit races out of the byte-loss measurement —
 * exit-path retention has its own unit test (serverStreaming.spec.ts
 * "trailing output of an exited session stays replayable").
 *
 * argv: <sessionIndex> <lineCount>
 * Line format (62 bytes + \n; the PTY line discipline maps \n -> \r\n):
 *   S<idx>:<seq 8 digits>:<48 x 'x'>\n
 *
 * [X2]: synthesized bytes only — nothing here touches accounts or secrets.
 */
'use strict';

const index = Number(process.argv[2] ?? '0');
const lineCount = Number(process.argv[3] ?? '1000');
const PAD = 'x'.repeat(48);
const CHUNK_LINES = 64;

let seq = 0;
function writeChunk() {
  let burst = '';
  const end = Math.min(seq + CHUNK_LINES, lineCount);
  for (; seq < end; seq += 1) {
    burst += `S${index}:${String(seq).padStart(8, '0')}:${PAD}\n`;
  }
  // Synchronous TTY write: blocks right here when the pty buffer is full
  // (the gateway pulled the pause lever) — that IS the flow-control proof.
  process.stdout.write(burst);
  if (seq < lineCount) {
    setImmediate(writeChunk);
  } else {
    // Done producing. Park until the host reaps us.
    setInterval(() => {}, 1 << 30);
  }
}
writeChunk();
