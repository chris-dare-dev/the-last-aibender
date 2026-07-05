/**
 * FE-6 builder DAG model — the client half of the FROZEN versioned JSON DAG
 * document (dag-schema.md v1; packages/protocol/src/dag/). The builder UI
 * composes a {@link BuilderDoc} (steps + `needs` edges + when/forEach/loop
 * affordances + PER-STEP ACCOUNT ROUTING + the first-class `approval` gate
 * node kind); {@link serializeBuilderDoc} lowers it to a raw document and
 * {@link validateBuilderDoc} runs the EXACT frozen validator the broker runs.
 *
 * Byte-identity discipline (plan §9.2 FE-6 "builder composition round-trip
 * byte-identical to golden frames"): the wire payload is NOT the raw builder
 * object — it is `validateDagDocument(raw).document`, the validator's
 * SANITIZED, canonically-key-ordered form (unknown keys dropped [X2], steps
 * emitted `{kind, id, …control, …exec, <kind-specific>}`). Because BE, the
 * golden corpus, and this builder all canonicalize through the same validator,
 * an encoded envelope of a valid builder doc is byte-comparable against the
 * corpus once the corpus fixture is passed through the same validator (the
 * lib/ws/outbound.ts corpus device). Never hand-order keys here.
 *
 * The server stays the authority for everything actually sent: a
 * `validateBuilderDoc` verdict of `blocked` is precisely the class the broker
 * would answer; RUNTIME facts (does the named skill resolve? is the account
 * provisioned?) are NOT judged here — only the static DAG contract is.
 *
 * [X2]: the model carries file paths + step ids + placeholder account labels +
 * capability NAMES only. The frozen validator's naming screen rejects an
 * email- or 12-digit-shaped literal in a name/prompt/summary (bad-shape) — so
 * a blocked build with that code is the [X2] audit surface, client-side.
 */

import {
  validateDagDocument,
  type AccountLabel,
  type DagDocument,
  type DagValidationResult,
  type ExecutableStepKind,
  type LoopControl,
  type OnErrorPolicy,
  type PermissionMode,
  type RetryPolicy,
  type StepBackend,
  type StepBudget,
  type StepKind,
} from '@aibender/protocol';

/** The one schema version the builder emits (unknown versions are refused). */
export { DAG_SCHEMA_VERSION } from '@aibender/protocol';

/**
 * One node the builder composes. A flat, edit-friendly superset of every step
 * kind; the serializer emits only the fields legal for the node's kind (unknown
 * fields are dropped by the validator regardless — this keeps the wire clean).
 * `approval` is a first-class node kind (dag-schema.md §2 — the differentiator
 * no native runtime offers): it carries only control + gate fields, no account.
 */
export interface BuilderNode {
  readonly id: string;
  readonly kind: StepKind;
  // --- control (all kinds) ---
  readonly needs?: readonly string[];
  readonly when?: string;
  readonly forEach?: string;
  readonly maxParallel?: number;
  readonly loop?: LoopControl;
  // --- executable routing / limits (executable kinds only) ---
  /** THE [X1] differentiator: per-step account routing. Placeholder label [X2]. */
  readonly account?: AccountLabel;
  readonly backend?: StepBackend;
  readonly cwd?: string;
  readonly permissionMode?: PermissionMode;
  readonly budget?: StepBudget;
  readonly retry?: RetryPolicy;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly onError?: OnErrorPolicy;
  // --- kind-specific bodies ---
  readonly prompt?: string;
  readonly skill?: { readonly name: string; readonly scope?: string; readonly args?: string };
  readonly agent?: { readonly name: string; readonly scope?: string; readonly args?: string };
  readonly scriptPath?: string;
  readonly summary?: string;
  readonly timeoutSec?: number;
  readonly onTimeout?: 'fail' | 'continue';
}

/** The document the builder edits. `defaults`/`inputs` are optional passthroughs. */
export interface BuilderDoc {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly defaults?: {
    readonly account?: AccountLabel;
    readonly backend?: StepBackend;
    readonly permissionMode?: PermissionMode;
    readonly cwd?: string;
  };
  readonly inputs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly nodes: readonly BuilderNode[];
}

/** Executable node kinds carry account/backend/etc.; the gate does not. */
export function isExecutableKind(kind: StepKind): kind is ExecutableStepKind {
  return kind !== 'approval';
}

/** Drop undefined-valued keys so the raw object round-trips cleanly. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/**
 * Lower one builder node to a raw step object. Emits ONLY the fields the node's
 * kind admits (executable routing on executable kinds; gate fields on
 * approval). Key order does not matter here — the validator re-emits in the
 * frozen canonical order; this is the raw INPUT to the validator.
 */
export function serializeNode(node: BuilderNode): Record<string, unknown> {
  const control = compact({
    needs: node.needs !== undefined ? [...node.needs] : undefined,
    when: node.when,
    forEach: node.forEach,
    maxParallel: node.maxParallel,
    loop: node.loop,
  });
  if (node.kind === 'approval') {
    return compact({
      kind: node.kind,
      id: node.id,
      ...control,
      summary: node.summary,
      timeoutSec: node.timeoutSec,
      onTimeout: node.onTimeout,
    });
  }
  const exec = compact({
    account: node.account,
    backend: node.backend,
    cwd: node.cwd,
    permissionMode: node.permissionMode,
    budget: node.budget,
    retry: node.retry,
    outputSchema: node.outputSchema,
    onError: node.onError,
  });
  const base = { kind: node.kind, id: node.id, ...control, ...exec } as Record<string, unknown>;
  switch (node.kind) {
    case 'prompt':
      return compact({ ...base, prompt: node.prompt });
    case 'skill':
      return compact({
        ...base,
        skill: node.skill !== undefined ? compact({ ...node.skill }) : undefined,
        prompt: node.prompt,
      });
    case 'agent':
      return compact({
        ...base,
        agent: node.agent !== undefined ? compact({ ...node.agent }) : undefined,
        prompt: node.prompt,
      });
    case 'workflow-script':
      return compact({ ...base, scriptPath: node.scriptPath });
    default:
      return base;
  }
}

/** Lower a builder doc to a raw document object (validator input). */
export function serializeBuilderDoc(doc: BuilderDoc): Record<string, unknown> {
  return compact({
    schemaVersion: 1,
    id: doc.id,
    name: doc.name,
    description: doc.description,
    defaults: doc.defaults !== undefined ? compact({ ...doc.defaults }) : undefined,
    inputs: doc.inputs,
    steps: doc.nodes.map(serializeNode),
  });
}

/**
 * Validate a builder doc through the FROZEN validator. On success the returned
 * `document` is the CANONICAL, sanitized form — this exact object is what the
 * verb carries on the wire (byte-identical to a corpus fixture canonicalized
 * the same way).
 */
export function validateBuilderDoc(doc: BuilderDoc): DagValidationResult {
  return validateDagDocument(serializeBuilderDoc(doc));
}

/**
 * The canonical wire document for a builder doc, or undefined when it fails
 * static validation (the caller renders the frozen issue class as an
 * instrument state; the server stays the authority for everything sent).
 */
export function canonicalDocument(doc: BuilderDoc): DagDocument | undefined {
  const verdict = validateBuilderDoc(doc);
  return verdict.ok ? verdict.document : undefined;
}

// ---------------------------------------------------------------------------
// Builder mutation helpers (pure — the UI/store drive them; tests exercise them)
// ---------------------------------------------------------------------------

/** An empty builder doc (a fresh canvas needs a name + at least one node to be valid). */
export function emptyBuilderDoc(id: string, name: string): BuilderDoc {
  return { id, name, nodes: [] };
}

/** Append a node (id-collision is a build-time concern the validator catches). */
export function addNode(doc: BuilderDoc, node: BuilderNode): BuilderDoc {
  return { ...doc, nodes: [...doc.nodes, node] };
}

/** Replace a node by id (identity-preserving edit). */
export function updateNode(doc: BuilderDoc, id: string, patch: Partial<BuilderNode>): BuilderDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
  };
}

/** Remove a node AND prune it from every other node's `needs` (no dangling edge). */
export function removeNode(doc: BuilderDoc, id: string): BuilderDoc {
  return {
    ...doc,
    nodes: doc.nodes
      .filter((n) => n.id !== id)
      .map((n) =>
        n.needs !== undefined && n.needs.includes(id)
          ? { ...n, needs: n.needs.filter((dep) => dep !== id) }
          : n,
      ),
  };
}

/** Add a `needs` edge from `toId` back to `fromId` (dedup; the validator checks the DAG). */
export function addEdge(doc: BuilderDoc, fromId: string, toId: string): BuilderDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== toId) return n;
      const needs = n.needs ?? [];
      return needs.includes(fromId) ? n : { ...n, needs: [...needs, fromId] };
    }),
  };
}
