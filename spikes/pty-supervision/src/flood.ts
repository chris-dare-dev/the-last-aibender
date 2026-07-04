/**
 * SPIKE-D (vi) — synthetic high-throughput TUI flooder (child program).
 *
 * HONEST PROXY, NOT THE REAL THING: this stands in for the real `claude` TUI,
 * which we must not run headlessly against real accounts (M0 spike brief).
 * It emits ANSI-decorated, sequence-numbered records at a target byte rate
 * (default ~5 MB/s) to stdout — which is a PTY slave when spawned via
 * node-pty. Node's stdout on a POSIX TTY is written synchronously, so when
 * the supervisor pauses the PTY master the kernel PTY buffer fills and this
 * process BLOCKS on write(2): exactly the backpressure propagation the flow
 * control depends on.
 *
 * Record shape (ASCII markers so chunk-boundary splits are trivial):
 *   ESC[2K ESC[36m <<S{id}:{seq}>> ESC[0m xxxxx…x \r\n
 *
 * Usage: tsx src/flood.ts --id 3 --rate 5242880 --duration 10 [--chunk 65536]
 *   --duration 0 = flood until killed.
 */

interface FloodArgs {
  id: number;
  rateBytesPerSec: number;
  durationSec: number;
  chunkBytes: number;
}

function parseArgs(argv: string[]): FloodArgs {
  const get = (flag: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    if (i === -1 || i + 1 >= argv.length) return fallback;
    const v = Number(argv[i + 1]);
    if (!Number.isFinite(v) || v < 0) throw new Error(`bad value for ${flag}`);
    return v;
  };
  return {
    id: get('--id', 0),
    rateBytesPerSec: get('--rate', 5 * 1024 * 1024),
    durationSec: get('--duration', 10),
    chunkBytes: get('--chunk', 64 * 1024),
  };
}

const TICK_MS = 20;
const PAD = 'x'.repeat(96);

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const bytesPerTick = Math.max(1, Math.round((args.rateBytesPerSec * TICK_MS) / 1000));
  const startedAt = Date.now();
  let seq = 0;
  let emitted = 0;

  const buildChunk = (budget: number): string => {
    let out = '';
    while (out.length < budget) {
      seq += 1;
      out += `\x1b[2K\x1b[36m<<S${args.id}:${seq}>>\x1b[0m${PAD}\r\n`;
    }
    return out;
  };

  const timer = setInterval(() => {
    if (args.durationSec > 0 && Date.now() - startedAt >= args.durationSec * 1000) {
      clearInterval(timer);
      // Final marker so the consumer can see a clean tail, then exit.
      process.stdout.write(`\x1b[0m<<S${args.id}:${seq + 1}>>DONE\r\n`, () => process.exit(0));
      return;
    }
    // Emit in sub-chunks bounded by --chunk to mimic bursty TUI writes.
    let budget = bytesPerTick;
    while (budget > 0) {
      const size = Math.min(budget, args.chunkBytes);
      const data = buildChunk(size);
      emitted += data.length;
      // On a TTY this write is synchronous; if the master is paused we block
      // here — that stall IS the flow-control success condition.
      process.stdout.write(data);
      budget -= size;
    }
  }, TICK_MS);

  process.on('SIGTERM', () => {
    clearInterval(timer);
    process.exit(0);
  });
  // Keep a heartbeat on stderr? No — stderr shares the PTY; stay silent.
  void emitted;
}

main();
