/**
 * SPIKE-C (x) — Bun.Terminal driving the same synthetic TUI as the
 * node-pty baseline. MUST RUN UNDER BUN >= 1.3.5 (the spike installs
 * bun 1.3.14 locally via npm; the system bun 1.2.23 predates the API).
 *
 * Discovered API shape (bun 1.3.14, probed 2026-07-04):
 *   const term = new Bun.Terminal({ cols, rows, data(term, chunk) {} })
 *   const proc = Bun.spawn({ cmd: [...], terminal: term })   // proc.terminal === term
 *   term.resize(cols, rows) · term.write(s) · term.close() · term.setRawMode
 *   termios accessors: controlFlags/inputFlags/localFlags/outputFlags
 *   exit: await proc.exited · proc.kill() · proc.exitCode/.signalCode
 *
 * Prints one JSON result line (consumed by run-parity.ts).
 */

// Runs under bun; keep tsc happy without pulling in @types/bun.
declare const Bun: any;

const TIMEOUT_MS = 8000;
const SIM = new URL("./tui-sim.cjs", import.meta.url).pathname;
// node binary to run the sim under (same child as the node-pty baseline)
const NODE = process.env.SPIKE_NODE_BIN || "node";

interface Result {
  impl: string;
  runtime: string;
  ok: boolean;
  hasTerminalApi: boolean;
  ttySeen: boolean;
  initialSize: string | null;
  resizeSeen: string | null;
  echoSeen: boolean;
  exitEvent: { exitCode: number | null; signal: string | null } | null;
  timings: Record<string, number>;
  apiSurface: string[];
  error?: string;
}

const result: Result = {
  impl: `Bun.Terminal (bun ${Bun.version})`,
  runtime: `bun ${Bun.version}`,
  ok: false,
  hasTerminalApi: typeof (Bun as any).Terminal === "function",
  ttySeen: false,
  initialSize: null,
  resizeSeen: null,
  echoSeen: false,
  exitEvent: null,
  timings: {},
  apiSurface: [],
};

function finish(code: number): never {
  console.log(JSON.stringify(result));
  process.exit(code);
}

if (!result.hasTerminalApi) {
  result.error = `Bun.Terminal absent on bun ${Bun.version} (shipped in 1.3.5)`;
  finish(1);
}

result.apiSurface = Object.getOwnPropertyNames((Bun as any).Terminal.prototype)
  .filter((k) => k !== "constructor")
  .sort();

// MEASURED (bun 1.3.14): resize(cols, rows) is the accepted signature
// (object args throw "resize() requires valid cols argument") but the call
// is INERT — the child's TTY stays at the spawn size forever: no SIGWINCH
// and even polling process.stdout.columns never changes. So the probe is
// resize-TOLERANT: it waits a bounded window for the RESIZE report, records
// null on absence, and still completes the echo/kill/exit matrix.
const RESIZE_WAIT_MS = 1500;

let buf = "";
let firstByteAt = 0;
let resizeSentAt = 0;
let killedAt = 0;
let echoSent = false;
let term: any;
let proc: any;

const t0 = performance.now();

function sendEchoProbe() {
  if (echoSent) return;
  echoSent = true;
  term.write("x");
}

const done = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);

  term = new (Bun as any).Terminal({
    cols: 80,
    rows: 24,
    data(_t: unknown, chunk: Uint8Array) {
      if (!firstByteAt) {
        firstByteAt = performance.now();
        result.timings.spawnToFirstByteMs = +(firstByteAt - t0).toFixed(1);
      }
      buf += new TextDecoder().decode(chunk);

      if (!result.ttySeen && /TTY 1 1/.test(buf)) result.ttySeen = true;
      const size = buf.match(/SIZE (\d+x\d+)/);
      if (size && !result.initialSize) {
        result.initialSize = size[1];
        resizeSentAt = performance.now();
        term.resize(120, 40);
        // resize-tolerant: continue to the echo probe even if the resize
        // never surfaces in the child
        setTimeout(sendEchoProbe, RESIZE_WAIT_MS);
      }
      const rs = buf.match(/RESIZE (\d+x\d+)/);
      if (rs && !result.resizeSeen) {
        result.resizeSeen = rs[1];
        result.timings.resizeToSigwinchMs = +(performance.now() - resizeSentAt).toFixed(1);
        sendEchoProbe();
      }
      if (!result.echoSeen && /ECHO "x"/.test(buf)) {
        result.echoSeen = true;
        killedAt = performance.now();
        proc.kill(); // kernel recycle path kills; graceful exit not assumed
      }
    },
  });

  proc = Bun.spawn({ cmd: [NODE, SIM], terminal: term, env: process.env } as any);

  proc.exited.then((exitCode: number) => {
    result.exitEvent = { exitCode, signal: proc.signalCode ?? null };
    if (killedAt) result.timings.killToExitMs = +(performance.now() - killedAt).toFixed(1);
    clearTimeout(timer);
    // small grace so trailing data callbacks flush
    setTimeout(resolve, 100);
  });
});

try {
  await done;
  // "ok" = full node-pty parity, which REQUIRES the resize round-trip.
  result.ok =
    result.ttySeen &&
    result.initialSize === "80x24" &&
    result.resizeSeen === "120x40" &&
    result.echoSeen &&
    result.exitEvent !== null;
} catch (err) {
  result.error = String((err as Error).message);
  try {
    proc?.kill();
  } catch {
    /* already dead */
  }
} finally {
  try {
    term?.close();
  } catch {
    /* already closed */
  }
}

finish(result.ok ? 0 : 1);
