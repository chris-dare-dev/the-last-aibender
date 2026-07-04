/**
 * Bedrock secret injection for the supervised serve child (BE-4; blueprint
 * §4.2 "Bedrock env (SSO profile, Keychain-fetched key — replicating the
 * owner's existing shell function) is injected into the spawned server's
 * process env, never persisted to disk").
 *
 * Design [X2]:
 *   - {@link SecretFetcher} is the injectable seam. Tests use fakes; the ONE
 *     real implementation shells `security find-generic-password -s <item> -w`
 *     and exists behind an explicit live opt-in gate (same class as the
 *     kernel's liveSpawnOptIn) — it runs ONLY at spawn time, per spawn.
 *   - Keychain item NAMES are safe to commit; VALUES never touch disk, never
 *     land in a serializable field, and are offered to the caller's line
 *     scrubber via `onSecretValue` so logs can never echo them (fs-audit test
 *     in serve.spec.ts proves the whole spawn flow writes no value anywhere).
 *   - Non-secret env names/values (AWS_PROFILE, AWS_REGION) come from
 *     machine-local operator config ($AIBENDER_HOME side — the SSO profile
 *     name embeds the AWS account id, so even those values are treated as
 *     identifier-bearing and offered to the scrubber too).
 */

import { execFile } from 'node:child_process';

import { KeychainItemUnavailableError, LiveKeychainDisabledError } from '../errors.js';

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

export interface SecretFetcher {
  /** Fetch one secret VALUE by Keychain item name. Called at spawn time only. */
  fetch(itemName: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Real fetcher — live opt-in gated
// ---------------------------------------------------------------------------

export type ExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

export interface KeychainSecretFetcherOptions {
  /**
   * MUST be `true`. Exists so no code path shells `security` by accident —
   * composition roots set it only from explicit operator config. In this
   * build the flag is never set outside T3 owner-gated runs.
   */
  readonly liveKeychainOptIn: boolean;
  /** Injectable exec (unit tests verify argv without shelling). */
  readonly execFileFn?: ExecFileFn;
}

/**
 * The real Keychain fetcher: `security find-generic-password -s <item> -w`.
 * READ-ONLY (`-w` prints the value; it never writes). Still opt-in gated
 * because the value enters process memory and the call may prompt the user.
 */
export function createKeychainSecretFetcher(options: KeychainSecretFetcherOptions): SecretFetcher {
  if (options.liveKeychainOptIn !== true) throw new LiveKeychainDisabledError();
  const exec = options.execFileFn ?? defaultExecFile;
  return {
    fetch: async (itemName: string): Promise<string> => {
      try {
        const { stdout } = await exec('security', [
          'find-generic-password',
          '-s',
          itemName,
          '-w',
        ]);
        // `security -w` terminates the value with a newline; the value itself
        // is opaque bytes-as-text. Strip exactly one trailing newline.
        const value = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
        if (value.length === 0) throw new KeychainItemUnavailableError(itemName);
        return value;
      } catch (error) {
        if (error instanceof KeychainItemUnavailableError) throw error;
        throw new KeychainItemUnavailableError(itemName);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Bedrock env assembly (the oc-bedrock pattern, generalized)
// ---------------------------------------------------------------------------

/** One Keychain-backed env var: the item NAME is config, the value is not. */
export interface KeychainEnvVarSpec {
  /** Env var to set on the child (e.g. OPENAI_API_KEY for the mantle path). */
  readonly envVar: string;
  /** Keychain item name (e.g. `bedrock-openai-api-key`). Names are safe. */
  readonly keychainItem: string;
}

export interface BedrockEnvSpec {
  /**
   * Plain (non-Keychain) env vars — AWS_PROFILE / AWS_REGION per the owner's
   * `oc-bedrock` pattern. Values come from machine-local config and are
   * treated as identifier-bearing (offered to the scrubber like secrets).
   */
  readonly plainEnv?: Readonly<Record<string, string>>;
  /** Keychain-fetched vars, resolved at spawn time via the SecretFetcher. */
  readonly keychainEnv?: readonly KeychainEnvVarSpec[];
}

export interface BuildBedrockEnvOptions {
  readonly spec: BedrockEnvSpec;
  readonly secretFetcher: SecretFetcher;
  /**
   * Called once per injected VALUE so the composition root can register it
   * with the @aibender/shared line scrubber [X2]. Optional; never persisted.
   */
  readonly onSecretValue?: (value: string) => void;
}

/**
 * Resolve the Bedrock env block for one spawn. Fetches every Keychain value
 * NOW (spawn time), returns a plain frozen object destined for the child's
 * process env — the caller must not store it beyond the spawn call.
 */
export async function buildBedrockEnv(
  options: BuildBedrockEnvOptions,
): Promise<Readonly<Record<string, string>>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.spec.plainEnv ?? {})) {
    env[key] = value;
    options.onSecretValue?.(value);
  }
  for (const { envVar, keychainItem } of options.spec.keychainEnv ?? []) {
    const value = await options.secretFetcher.fetch(keychainItem);
    env[envVar] = value;
    options.onSecretValue?.(value);
  }
  return Object.freeze(env);
}
