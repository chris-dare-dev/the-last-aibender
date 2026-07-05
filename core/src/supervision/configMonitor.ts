/**
 * `~/.claude.json` SIZE MONITORING per account dir (BE-9; plan §4/BE-9,
 * blueprint §11: "`~/.claude.json` size monitored per account dir"). A
 * runaway `.claude.json` (the CLI's per-config-dir settings/state file) is an
 * early warning of state bloat that degrades every session of that account.
 *
 * READ-ONLY, BY CONSTRUCTION: this module `statSync`s a file to read its
 * size — nothing more. It imports NO write-capable fs API (the architecture
 * test asserts this). It NEVER reads the file CONTENTS (size only — the
 * contents can carry identity/state we have no business touching [X2]).
 *
 * FIXTURE PATHS IN TESTS, NEVER THE REAL DIRS: the config-dir paths are
 * injected (per {@link ClaudeConfigMonitorOptions.configDirsByAccount}); the
 * vitest suite points them at synthesized tmp fixtures. The composition root
 * wires the real per-account `CLAUDE_CONFIG_DIR`s at runtime — this module has
 * no knowledge of the real home dir on its own.
 *
 * [X2]: the report is LABELS + numbers only — the account label + a byte size.
 * The absolute path is used only to stat; it never leaves this module (and
 * would be an `identifier`-tagged field if it did).
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';

import type { AccountLabel } from '@aibender/protocol';
import type { Logger } from '@aibender/shared';

/** The file name the CLI writes in each config dir. */
export const CLAUDE_CONFIG_FILE = '.claude.json' as const;

/** Default warn threshold — a `.claude.json` over this is flagged. 10 MB. */
export const DEFAULT_CONFIG_WARN_BYTES = 10 * 1024 * 1024;

export interface ClaudeConfigMonitorOptions {
  /**
   * Absolute config-dir path per account (tests inject fixture paths). The
   * monitor stats `<dir>/.claude.json`. Missing account → not monitored.
   */
  readonly configDirsByAccount: Readonly<Partial<Record<AccountLabel, string>>>;
  /** Warn threshold, bytes. Default 10 MB. */
  readonly warnBytes?: number;
  readonly logger?: Logger;
}

/** One account's `.claude.json` size reading — labels + numbers only [X2]. */
export interface ClaudeConfigSize {
  readonly account: AccountLabel;
  /** File size in bytes; absent when the file does not exist / is unreadable. */
  readonly bytes?: number;
  /** True when `bytes` exceeds the warn threshold. */
  readonly overWarn: boolean;
}

export interface ClaudeConfigMonitor {
  /** Stat every monitored account's `.claude.json`. Read-only; never throws. */
  sample(): readonly ClaudeConfigSize[];
  /** Just the accounts currently over the warn threshold (labels only). */
  overWarn(): readonly AccountLabel[];
}

export function createClaudeConfigMonitor(
  options: ClaudeConfigMonitorOptions,
): ClaudeConfigMonitor {
  const warnBytes = options.warnBytes ?? DEFAULT_CONFIG_WARN_BYTES;
  const entries = Object.entries(options.configDirsByAccount) as [AccountLabel, string][];

  const sample = (): readonly ClaudeConfigSize[] =>
    entries.map(([account, dir]) => {
      try {
        // statSync ONLY — size, no contents read [X2]. `statSync` is a
        // read-only fs member (the architecture test allowlists it).
        const stat = statSync(join(dir, CLAUDE_CONFIG_FILE));
        const bytes = stat.size;
        return { account, bytes, overWarn: bytes > warnBytes };
      } catch (cause) {
        // File absent / unreadable → no reading (never a fabricated zero that
        // reads as "healthy 0 bytes"). Debug-log only; a missing file is
        // normal for a not-yet-logged-in account.
        options.logger?.debug('claude config stat unavailable', {
          account,
          detail: (cause as Error).message,
        });
        return { account, overWarn: false };
      }
    });

  return {
    sample,
    overWarn: () => sample().filter((s) => s.overWarn).map((s) => s.account),
  };
}
