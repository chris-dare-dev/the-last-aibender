/**
 * FE-2 logging seam. Tiny by design: the frontend never owns durable logs
 * (the broker does); this exists so protocol violations and lifecycle events
 * are observable in dev tools AND assertable in tests.
 *
 * [X2] discipline: NOTHING identifier-bearing is ever logged from this layer.
 * The gateway auth token in particular NEVER reaches a log line — the client
 * keeps it inside a closure and no log call site receives it.
 */

export interface Logger {
  debug(msg: string, detail?: Record<string, unknown>): void;
  warn(msg: string, detail?: Record<string, unknown>): void;
  error(msg: string, detail?: Record<string, unknown>): void;
}

/** Console-backed default. Detail objects must already be identifier-free. */
export const consoleLogger: Logger = {
  debug(msg, detail) {
    if (detail === undefined) console.debug(`[aibender] ${msg}`);
    else console.debug(`[aibender] ${msg}`, detail);
  },
  warn(msg, detail) {
    if (detail === undefined) console.warn(`[aibender] ${msg}`);
    else console.warn(`[aibender] ${msg}`, detail);
  },
  error(msg, detail) {
    if (detail === undefined) console.error(`[aibender] ${msg}`);
    else console.error(`[aibender] ${msg}`, detail);
  },
};

/** No-op logger for tests that assert silence. */
export const nullLogger: Logger = {
  debug() {},
  warn() {},
  error() {},
};
