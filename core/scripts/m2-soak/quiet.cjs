#!/usr/bin/env node
/**
 * Synthetic quiet TUI for the M2 gate echo-latency measurement.
 *
 * Writes nothing and drains stdin. The PTY line discipline's ECHO (on by
 * default) reflects every input byte back on the output stream at the TTY
 * driver — measuring keystroke -> OUTPUT-frame time through the REAL
 * gateway + ptyHost + node-pty chain without any TUI rendering noise.
 * Reaped by the ptyHost at shutdown.
 */
'use strict';

process.stdin.resume(); // keep the input queue drained (and the process alive)
