/**
 * Tauri IPC bridge — native affordances ONLY (blueprint §2 topology rule:
 * Tauri IPC is never a streaming path). Every function degrades gracefully
 * outside the Tauri shell (Chrome-as-frontend is a free second frontend).
 */

import type { BootstrapProvider } from '../bootstrap.ts';

interface TauriGlobals {
  __TAURI_INTERNALS__?: unknown;
  __AIBENDER_BOOTSTRAP__?: unknown;
}

export function isTauri(): boolean {
  return (globalThis as TauriGlobals).__TAURI_INTERNALS__ !== undefined;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import('@tauri-apps/api/core');
  return core.invoke<T>(command, args);
}

/**
 * Bootstrap discovery provider (bootstrap-file.md §4). In the Tauri shell
 * the file read happens in Rust (`read_bootstrap`); in a plain browser the
 * dev shim global `__AIBENDER_BOOTSTRAP__` may inject parsed content.
 * Never throws — any failure is "no broker advertised".
 */
export const nativeBootstrapProvider: BootstrapProvider = async () => {
  try {
    if (isTauri()) {
      const raw = await invoke<string | null>('read_bootstrap');
      if (typeof raw !== 'string') return undefined;
      return JSON.parse(raw) as unknown;
    }
    return (globalThis as TauriGlobals).__AIBENDER_BOOTSTRAP__;
  } catch {
    return undefined;
  }
};

/**
 * Native notification (approval arrivals, broker faults). No-op outside
 * Tauri — the inbox itself is the in-app surface.
 */
export async function notifyNative(title: string, body: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke<void>('notify_native', { title, body });
  } catch {
    // Notification failure is never surfaced as an error (cosmetic path).
  }
}
