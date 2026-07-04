/**
 * SPIKE-C (x) baseline — node-pty 1.1.0 driving the synthetic TUI.
 *
 * Records the exact lifecycle the aibender kernel (BE-2 ptyHost) needs:
 * spawn under a PTY (child sees a TTY), initial size honored, resize
 * propagates as SIGWINCH, write/echo round-trip, kill -> exit event.
 * Prints one JSON result line (consumed by run-parity.ts).
 */
import * as pty from "node-pty";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM = path.join(HERE, "tui-sim.cjs");
const TIMEOUT_MS = 8000;

interface Result {
  impl: string;
  runtime: string;
  ok: boolean;
  ttySeen: boolean;
  initialSize: string | null;
  resizeSeen: string | null;
  echoSeen: boolean;
  exitEvent: { exitCode: number; signal?: number } | null;
  timings: Record<string, number>;
  apiSurface: string[];
  error?: string;
}

async function main(): Promise<void> {
  const result: Result = {
    impl: "node-pty@1.1.0",
    runtime: `node ${process.version}`,
    ok: false,
    ttySeen: false,
    initialSize: null,
    resizeSeen: null,
    echoSeen: false,
    exitEvent: null,
    timings: {},
    apiSurface: [],
  };

  const t0 = performance.now();
  const term = pty.spawn(process.execPath, [SIM], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: HERE,
    env: { ...process.env } as Record<string, string>,
  });

  result.apiSurface = [
    ...new Set([
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(term)),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(Object.getPrototypeOf(term))),
    ]),
  ]
    .filter((k) => !k.startsWith("_") && k !== "constructor")
    .sort();

  let buf = "";
  let firstByteAt = 0;
  let resizeSentAt = 0;
  let killedAt = 0;

  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);

    term.onData((d) => {
      if (!firstByteAt) {
        firstByteAt = performance.now();
        result.timings.spawnToFirstByteMs = +(firstByteAt - t0).toFixed(1);
      }
      buf += d;

      if (!result.ttySeen && /TTY 1 1/.test(buf)) result.ttySeen = true;
      const size = buf.match(/SIZE (\d+x\d+)/);
      if (size && !result.initialSize) {
        result.initialSize = size[1];
        // now resize
        resizeSentAt = performance.now();
        term.resize(120, 40);
      }
      const rs = buf.match(/RESIZE (\d+x\d+)/);
      if (rs && !result.resizeSeen) {
        result.resizeSeen = rs[1];
        result.timings.resizeToSigwinchMs = +(performance.now() - resizeSentAt).toFixed(1);
        term.write("x");
      }
      if (!result.echoSeen && /ECHO "x"/.test(buf)) {
        result.echoSeen = true;
        // exercise kill -> exit event (not graceful 'q' exit: the kernel's
        // recycle path kills, it doesn't ask nicely)
        killedAt = performance.now();
        term.kill();
      }
    });

    term.onExit(({ exitCode, signal }) => {
      result.exitEvent = { exitCode, signal };
      if (killedAt) result.timings.killToExitMs = +(performance.now() - killedAt).toFixed(1);
      clearTimeout(timer);
      resolve();
    });
  });

  try {
    await done;
    result.ok =
      result.ttySeen &&
      result.initialSize === "80x24" &&
      result.resizeSeen === "120x40" &&
      result.echoSeen &&
      result.exitEvent !== null;
  } catch (err) {
    result.error = String((err as Error).message);
    try {
      term.kill();
    } catch {
      /* already dead */
    }
  }

  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

main();
