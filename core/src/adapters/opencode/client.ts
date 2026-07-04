/**
 * OpenCode SDK client wrapper (BE-4; blueprint §4.2 "Drive via
 * @opencode-ai/sdk. Sessions are created with `parentID` where lineage
 * applies ([X4])").
 *
 * Thin, deliberately narrow surface over the generated `@opencode-ai/sdk`
 * (pinned 1.17.13 — matches the probed serve binary):
 *   - `createSession` with **parentID pass-through** — the [X4] lineage
 *     primitive. Harness ids never leave the harness; the returned
 *     `nativeSessionId`/`parentId` are OpenCode's `ses_…` ids for the
 *     resume ledger's native columns.
 *   - directory scoping via the documented `?directory=` query param.
 *   - Auth: HTTP Basic with the per-boot password, supplied as a HEADER
 *     value (from the serve handle's `authHeader()` closure) — this module
 *     never sees or stores the password itself.
 *
 * Message/inference verbs are deliberately ABSENT at M2 (they cost money and
 * belong to the pipeline engine's account routing at M5); event consumption
 * lives in sse.ts.
 */

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

import { AdapterError } from '../errors.js';

// ---------------------------------------------------------------------------
// Narrow session view
// ---------------------------------------------------------------------------

/** The session fields the harness records (native ids for the ledger). */
export interface OpencodeSessionInfo {
  readonly nativeSessionId: string;
  readonly parentId?: string;
  readonly title: string;
  readonly directory: string;
  readonly projectId: string;
  readonly version: string;
}

export interface CreateOpencodeSessionInput {
  /** Native parent session id (`ses_…`) — [X4] lineage pass-through. */
  readonly parentId?: string;
  readonly title?: string;
  /** Directory instance to scope the session to (`?directory=`). */
  readonly directory?: string;
}

export interface OpencodeSessionClient {
  createSession(input: CreateOpencodeSessionInput): Promise<OpencodeSessionInfo>;
  /** The underlying generated client, for read-only surfaces BE-5 may need. */
  readonly sdk: OpencodeClient;
}

export interface OpencodeSessionClientOptions {
  /** Serve base URL, e.g. `http://127.0.0.1:<port>`. */
  readonly baseUrl: string;
  /** HTTP Basic header value from the serve handle's `authHeader()`. */
  readonly authHeader: string;
  /** Injectable fetch (tests; the SDK passes it through verbatim). */
  readonly fetchFn?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function asSessionInfo(value: unknown): OpencodeSessionInfo {
  if (typeof value !== 'object' || value === null) {
    throw new AdapterError('internal', 'opencode session create answered a non-object body');
  }
  const record = value as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new AdapterError('internal', 'opencode session create answered without a session id');
  }
  const parentId = record['parentID'];
  return {
    nativeSessionId: id,
    ...(typeof parentId === 'string' ? { parentId } : {}),
    title: typeof record['title'] === 'string' ? record['title'] : '',
    directory: typeof record['directory'] === 'string' ? record['directory'] : '',
    projectId: typeof record['projectID'] === 'string' ? record['projectID'] : '',
    version: typeof record['version'] === 'string' ? record['version'] : '',
  };
}

export function createOpencodeSessionClient(
  options: OpencodeSessionClientOptions,
): OpencodeSessionClient {
  const sdk = createOpencodeClient({
    baseUrl: options.baseUrl,
    headers: { authorization: options.authHeader },
    ...(options.fetchFn !== undefined
      ? { fetch: options.fetchFn as never }
      : {}),
  });

  return {
    sdk,
    createSession: async (input): Promise<OpencodeSessionInfo> => {
      const result = await sdk.session.create({
        body: {
          // parentID pass-through [X4]: undefined stays absent, never null.
          ...(input.parentId !== undefined ? { parentID: input.parentId } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
        },
        ...(input.directory !== undefined ? { query: { directory: input.directory } } : {}),
        throwOnError: false,
      });
      if (result.error !== undefined || result.data === undefined) {
        throw new AdapterError('internal', 'opencode session create failed', {
          retryable: true,
        });
      }
      return asSessionInfo(result.data);
    },
  };
}
