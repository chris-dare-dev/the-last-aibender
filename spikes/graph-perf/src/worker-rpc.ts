/**
 * Shared helpers for driving the layout worker (bench + tests).
 * Quarantined spike code.
 */

import { Worker } from 'node:worker_threads';
import { buildSync } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Bundle src/layout-worker.ts to dist/ and return the runnable path. */
export function bundleLayoutWorker(): string {
  const outfile = join(here, '..', 'dist', 'layout-worker.mjs');
  buildSync({
    entryPoints: [join(here, 'layout-worker.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile,
  });
  return outfile;
}

/** One id-matched request/response against the worker protocol. */
export function request<T = any>(
  worker: Worker,
  msg: { id: number; type: string; [k: string]: unknown },
  transfer: ArrayBuffer[],
  expect: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMessage = (m: any) => {
      if (m.id !== msg.id) return;
      worker.off('message', onMessage);
      if (m.type === 'error') reject(new Error(`worker error: ${m.message}`));
      else if (m.type !== expect) reject(new Error(`expected ${expect}, got ${m.type}`));
      else resolve(m as T);
    };
    worker.on('message', onMessage);
    worker.postMessage(msg, transfer);
  });
}
