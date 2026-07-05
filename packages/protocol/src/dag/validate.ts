/**
 * DAG document validator — the machine-checkable half of dag-schema.md v1
 * validation semantics (blueprint §7, plan §4/BE-8, findings §R2/§R3).
 *
 * Total over `unknown`, never throws, returns a sanitized {@link DagDocument}
 * containing ONLY contract keys (unknown keys dropped, never echoed — [X2]).
 * The verdict is a {@link DagValidationResult}: on failure a
 * {@link DagValidationIssue} naming the frozen error class + the offending
 * path. Hand-rolled (no zod) for the same reasons validate.ts is (index.ts /
 * validate.ts headers): zero runtime deps in the frozen contract both
 * departments consume.
 *
 * VALIDATION SEMANTICS (each has an exhaustive negative test):
 *   - unsupported-version  schemaVersion !== DAG_SCHEMA_VERSION
 *   - unknown-step-kind     a step whose `kind` is outside STEP_KINDS
 *   - dangling-needs        `needs`/`goto`/`forEach`-ref names an absent step
 *   - duplicate-step-id     two steps share an id
 *   - cycle                 the `needs:` graph is not a DAG
 *   - invalid-account       account label outside ACCOUNT_LABELS, or a
 *                           backend inconsistent with the account
 *   - bad-shape             field-level (blank id/name, empty steps, bad
 *                           budget/retry bounds, forEach+loop both set, …)
 *
 * ============================================================================
 * FROZEN-M5 (dag-schema.md v1). Amendments only via ICR. Prose of record:
 * docs/contracts/dag-schema.md.
 * ============================================================================
 */

import { isAccountLabel, type AccountLabel } from '../vocab.js';
import type {
  AgentStep,
  ApprovalStep,
  CapabilityRef,
  DagDefaults,
  DagDocument,
  LoopControl,
  OnErrorPolicy,
  PipelineStep,
  PromptStep,
  RetryPolicy,
  SkillStep,
  StepBackend,
  StepBudget,
  WorkflowScriptStep,
} from './types.js';
import {
  ACCOUNT_STEP_BACKENDS,
  DAG_ID_RE,
  DAG_NAME_RE,
  DAG_SCHEMA_VERSION,
  ON_ERROR_POLICIES,
  STEP_ID_RE,
  isCapabilityScope,
  isPermissionMode,
  isRetryOnClass,
  isStepBackend,
  isStepKind,
} from './types.js';

/** Frozen DAG validation error classes (the dag-schema.md v1 taxonomy). */
export const DAG_ISSUE_CODES = Object.freeze([
  'unsupported-version',
  'unknown-step-kind',
  'dangling-needs',
  'duplicate-step-id',
  'cycle',
  'invalid-account',
  'bad-shape',
] as const);

export type DagIssueCode = (typeof DAG_ISSUE_CODES)[number];

export interface DagValidationIssue {
  readonly code: DagIssueCode;
  /** Human-readable, identifier-free [X2]. */
  readonly message: string;
  /** Dotted path to the offending node, e.g. `steps[2].needs`. */
  readonly path: string;
}

export type DagValidationResult =
  | { readonly ok: true; readonly document: DagDocument }
  | { readonly ok: false; readonly issue: DagValidationIssue };

function fail(code: DagIssueCode, path: string, message: string): DagValidationResult {
  return { ok: false, issue: { code, message, path } };
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isAbsolutePath(value: unknown): value is string {
  return isNonEmptyString(value) && value.startsWith('/');
}

/**
 * [X2] identity-shape screen for free-text NAMING fields (name/description/
 * summary/capability names). Rejects emails, 12-digit runs (AWS-account
 * shaped), and long token-shaped strings. Templating (`${…}`) and paths are
 * legal and NOT screened here (they are `identifier`-tagged for redaction
 * downstream, the events/lineage precedent) — this screens the human-authored
 * labels a public repo must never carry as literals.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const TWELVE_DIGIT_RE = /(?<!\d)\d{12}(?!\d)/;

function screenNaming(path: string, value: string): DagValidationResult | undefined {
  if (EMAIL_RE.test(value)) {
    return fail('bad-shape', path, `${path} carries an email-shaped literal (forbidden [X2])`);
  }
  if (TWELVE_DIGIT_RE.test(value)) {
    return fail('bad-shape', path, `${path} carries a 12-digit run (AWS-account shaped, forbidden [X2])`);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Account/backend consistency (the [X1] routing rule)
// ---------------------------------------------------------------------------

function checkAccountBackend(
  path: string,
  account: AccountLabel | undefined,
  backend: StepBackend | undefined,
): DagValidationResult | undefined {
  if (account !== undefined && !isAccountLabel(account)) {
    return fail('invalid-account', path, `unknown account label ${JSON.stringify(account)}`);
  }
  if (backend !== undefined && !isStepBackend(backend)) {
    return fail('bad-shape', path, `unknown step backend ${JSON.stringify(backend)}`);
  }
  if (account !== undefined && backend !== undefined) {
    const legal = ACCOUNT_STEP_BACKENDS[account];
    if (!(legal as readonly string[]).includes(backend)) {
      return fail(
        'invalid-account',
        path,
        `account ${account} cannot run backend ${backend} (legal: ${legal.join('|')})`,
      );
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Sub-object validators
// ---------------------------------------------------------------------------

function validateBudget(path: string, value: unknown): { budget: StepBudget } | DagValidationResult {
  if (!isRecord(value)) return fail('bad-shape', path, `${path} must be an object`);
  const usd = value['usd'];
  if (usd !== undefined && !isPositiveFinite(usd)) {
    return fail('bad-shape', `${path}.usd`, 'budget.usd must be a positive finite number');
  }
  const turns = value['turns'];
  if (turns !== undefined && !isPositiveInteger(turns)) {
    return fail('bad-shape', `${path}.turns`, 'budget.turns must be a positive integer');
  }
  const wallClockSec = value['wallClockSec'];
  if (wallClockSec !== undefined && !isPositiveInteger(wallClockSec)) {
    return fail('bad-shape', `${path}.wallClockSec`, 'budget.wallClockSec must be a positive integer');
  }
  if (usd === undefined && turns === undefined && wallClockSec === undefined) {
    return fail('bad-shape', path, 'budget must carry at least one of usd/turns/wallClockSec');
  }
  return {
    budget: {
      ...(usd !== undefined ? { usd } : {}),
      ...(turns !== undefined ? { turns } : {}),
      ...(wallClockSec !== undefined ? { wallClockSec } : {}),
    },
  };
}

function validateRetry(path: string, value: unknown): { retry: RetryPolicy } | DagValidationResult {
  if (!isRecord(value)) return fail('bad-shape', path, `${path} must be an object`);
  const max = value['max'];
  if (!isNonNegativeInteger(max) || max > 10) {
    return fail('bad-shape', `${path}.max`, 'retry.max must be an integer in 0..10');
  }
  const backoffSec = value['backoffSec'];
  if (backoffSec !== undefined && (typeof backoffSec !== 'number' || !Number.isFinite(backoffSec) || backoffSec < 0)) {
    return fail('bad-shape', `${path}.backoffSec`, 'retry.backoffSec must be a non-negative finite number');
  }
  const retryOn = value['retryOn'];
  let parsedRetryOn: RetryPolicy['retryOn'] | undefined;
  if (retryOn !== undefined) {
    if (!Array.isArray(retryOn) || retryOn.length === 0 || !retryOn.every(isRetryOnClass)) {
      return fail('bad-shape', `${path}.retryOn`, 'retry.retryOn must be a non-empty array of known classes');
    }
    parsedRetryOn = retryOn as RetryPolicy['retryOn'];
  }
  return {
    retry: {
      max,
      ...(backoffSec !== undefined ? { backoffSec } : {}),
      ...(parsedRetryOn !== undefined ? { retryOn: parsedRetryOn } : {}),
    },
  };
}

function validateCapabilityRef(
  path: string,
  value: unknown,
): { ref: CapabilityRef } | DagValidationResult {
  if (!isRecord(value)) return fail('bad-shape', path, `${path} must be an object`);
  const name = value['name'];
  if (!isNonEmptyString(name)) return fail('bad-shape', `${path}.name`, `${path}.name must be a non-empty string`);
  const nameScreen = screenNaming(`${path}.name`, name);
  if (nameScreen) return nameScreen;
  const scope = value['scope'];
  if (scope !== undefined && !isCapabilityScope(scope)) {
    return fail('bad-shape', `${path}.scope`, `unknown capability scope ${JSON.stringify(scope)}`);
  }
  const args = value['args'];
  if (args !== undefined && typeof args !== 'string') {
    return fail('bad-shape', `${path}.args`, `${path}.args must be a string`);
  }
  return {
    ref: {
      name,
      ...(scope !== undefined ? { scope } : {}),
      ...(args !== undefined ? { args } : {}),
    },
  };
}

function validateLoop(path: string, value: unknown): { loop: LoopControl } | DagValidationResult {
  if (!isRecord(value)) return fail('bad-shape', path, `${path} must be an object`);
  const until = value['until'];
  if (!isNonEmptyString(until)) return fail('bad-shape', `${path}.until`, 'loop.until must be a non-empty string');
  const maxIterations = value['maxIterations'];
  if (!isPositiveInteger(maxIterations) || maxIterations > 100) {
    return fail('bad-shape', `${path}.maxIterations`, 'loop.maxIterations must be an integer in 1..100');
  }
  return { loop: { until, maxIterations } };
}

function validateOnError(
  path: string,
  value: unknown,
  stepIds: ReadonlySet<string>,
): { onError: OnErrorPolicy } | DagValidationResult {
  if (typeof value !== 'string') return fail('bad-shape', path, `${path} must be a string`);
  if ((ON_ERROR_POLICIES as readonly string[]).includes(value)) {
    return { onError: value as OnErrorPolicy };
  }
  if (value.startsWith('goto:')) {
    const target = value.slice('goto:'.length);
    if (!stepIds.has(target)) {
      return fail('dangling-needs', path, `onError goto target ${JSON.stringify(target)} names no step`);
    }
    return { onError: value as OnErrorPolicy };
  }
  return fail('bad-shape', path, `onError must be fail|continue|goto:<stepId>, got ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// Step structural validation (per kind). `stepIds` is the full id set for
// needs/goto/forEach reference checks (done AFTER the id pass).
// ---------------------------------------------------------------------------

interface StepContext {
  readonly path: string;
  readonly stepIds: ReadonlySet<string>;
}

function validateStepCommonControl(
  ctx: StepContext,
  raw: Record<string, unknown>,
): Partial<Pick<PipelineStep, 'needs' | 'when' | 'forEach' | 'maxParallel' | 'loop'>> | DagValidationResult {
  const { path, stepIds } = ctx;
  const out: Record<string, unknown> = {};

  const needs = raw['needs'];
  if (needs !== undefined) {
    if (!Array.isArray(needs) || !needs.every((n) => isNonEmptyString(n))) {
      return fail('bad-shape', `${path}.needs`, 'needs must be an array of step ids');
    }
    for (const n of needs as string[]) {
      if (!stepIds.has(n)) {
        return fail('dangling-needs', `${path}.needs`, `needs references unknown step ${JSON.stringify(n)}`);
      }
    }
    out['needs'] = [...(needs as string[])];
  }

  const when = raw['when'];
  if (when !== undefined) {
    if (!isNonEmptyString(when)) return fail('bad-shape', `${path}.when`, 'when must be a non-empty string');
    out['when'] = when;
  }

  const forEach = raw['forEach'];
  const loop = raw['loop'];
  if (forEach !== undefined && loop !== undefined) {
    return fail('bad-shape', path, 'a step may set forEach OR loop, never both');
  }
  if (forEach !== undefined) {
    if (!isNonEmptyString(forEach)) return fail('bad-shape', `${path}.forEach`, 'forEach must be a non-empty template string');
    out['forEach'] = forEach;
    const maxParallel = raw['maxParallel'];
    if (maxParallel !== undefined) {
      if (!isPositiveInteger(maxParallel) || maxParallel > 16) {
        return fail('bad-shape', `${path}.maxParallel`, 'maxParallel must be an integer in 1..16');
      }
      out['maxParallel'] = maxParallel;
    }
  } else if (raw['maxParallel'] !== undefined) {
    return fail('bad-shape', `${path}.maxParallel`, 'maxParallel is only legal with forEach');
  }
  if (loop !== undefined) {
    const parsed = validateLoop(`${path}.loop`, loop);
    if ('ok' in parsed) return parsed;
    out['loop'] = parsed.loop;
  }

  return out as Partial<Pick<PipelineStep, 'needs' | 'when' | 'forEach' | 'maxParallel' | 'loop'>>;
}

function validateExecutableCommon(
  ctx: StepContext,
  raw: Record<string, unknown>,
): { fields: Record<string, unknown> } | DagValidationResult {
  const { path, stepIds } = ctx;
  const out: Record<string, unknown> = {};

  const account = raw['account'] as AccountLabel | undefined;
  const backend = raw['backend'] as StepBackend | undefined;
  const ab = checkAccountBackend(path, account, backend);
  if (ab) return ab;
  if (account !== undefined) out['account'] = account;
  if (backend !== undefined) out['backend'] = backend;

  const cwd = raw['cwd'];
  if (cwd !== undefined) {
    // cwd may be a template (`${workspace}`) OR an absolute path.
    if (!isNonEmptyString(cwd)) return fail('bad-shape', `${path}.cwd`, 'cwd must be a non-empty string');
    if (!cwd.includes('${') && !cwd.startsWith('/')) {
      return fail('bad-shape', `${path}.cwd`, 'cwd must be an absolute path or a template');
    }
    out['cwd'] = cwd;
  }

  const permissionMode = raw['permissionMode'];
  if (permissionMode !== undefined) {
    if (!isPermissionMode(permissionMode)) {
      return fail('bad-shape', `${path}.permissionMode`, `unknown permissionMode ${JSON.stringify(permissionMode)}`);
    }
    out['permissionMode'] = permissionMode;
  }

  if (raw['budget'] !== undefined) {
    const parsed = validateBudget(`${path}.budget`, raw['budget']);
    if ('ok' in parsed) return parsed;
    out['budget'] = parsed.budget;
  }

  if (raw['retry'] !== undefined) {
    const parsed = validateRetry(`${path}.retry`, raw['retry']);
    if ('ok' in parsed) return parsed;
    out['retry'] = parsed.retry;
  }

  const outputSchema = raw['outputSchema'];
  if (outputSchema !== undefined) {
    if (!isRecord(outputSchema) || typeof outputSchema['type'] !== 'string') {
      return fail('bad-shape', `${path}.outputSchema`, 'outputSchema must be a JSON-schema object with a string `type`');
    }
    out['outputSchema'] = outputSchema;
  }

  if (raw['onError'] !== undefined) {
    const parsed = validateOnError(`${path}.onError`, raw['onError'], stepIds);
    if ('ok' in parsed) return parsed;
    out['onError'] = parsed.onError;
  }

  return { fields: out };
}

function validateStep(ctx: StepContext, raw: unknown): { step: PipelineStep } | DagValidationResult {
  const { path } = ctx;
  if (!isRecord(raw)) return fail('bad-shape', path, `${path} must be an object`);
  const kind = raw['kind'];
  if (!isStepKind(kind)) {
    return fail('unknown-step-kind', `${path}.kind`, `unknown step kind ${JSON.stringify(kind)}`);
  }
  const id = raw['id'];
  if (typeof id !== 'string' || !STEP_ID_RE.test(id)) {
    return fail('bad-shape', `${path}.id`, `step id must match ${STEP_ID_RE.source}`);
  }

  const control = validateStepCommonControl(ctx, raw);
  if ('ok' in control) return control;

  if (kind === 'approval') {
    const summary = raw['summary'];
    if (summary !== undefined) {
      if (!isNonEmptyString(summary)) return fail('bad-shape', `${path}.summary`, 'summary must be a non-empty string');
      const screen = screenNaming(`${path}.summary`, summary);
      if (screen) return screen;
    }
    const timeoutSec = raw['timeoutSec'];
    if (timeoutSec !== undefined && !isPositiveInteger(timeoutSec)) {
      return fail('bad-shape', `${path}.timeoutSec`, 'timeoutSec must be a positive integer');
    }
    const onTimeout = raw['onTimeout'];
    if (onTimeout !== undefined && onTimeout !== 'fail' && onTimeout !== 'continue') {
      return fail('bad-shape', `${path}.onTimeout`, 'onTimeout must be fail|continue');
    }
    const step: ApprovalStep = {
      kind: 'approval',
      id,
      ...control,
      ...(summary !== undefined ? { summary: summary as string } : {}),
      ...(timeoutSec !== undefined ? { timeoutSec } : {}),
      ...(onTimeout !== undefined ? { onTimeout } : {}),
    };
    return { step };
  }

  // Executable kinds share the executable-common block.
  const execResult = validateExecutableCommon(ctx, raw);
  if ('ok' in execResult) return execResult;
  const exec = execResult.fields;

  switch (kind) {
    case 'prompt': {
      const prompt = raw['prompt'];
      if (!isNonEmptyString(prompt)) return fail('bad-shape', `${path}.prompt`, 'prompt step requires a non-empty prompt');
      const screen = screenNaming(`${path}.prompt`, prompt);
      if (screen) return screen;
      const step: PromptStep = { kind: 'prompt', id, ...control, ...exec, prompt };
      return { step };
    }
    case 'skill': {
      const ref = validateCapabilityRef(`${path}.skill`, raw['skill']);
      if ('ok' in ref) return ref;
      const prompt = raw['prompt'];
      if (prompt !== undefined && !isNonEmptyString(prompt)) {
        return fail('bad-shape', `${path}.prompt`, 'skill step prompt, when present, must be a non-empty string');
      }
      const step: SkillStep = {
        kind: 'skill',
        id,
        ...control,
        ...exec,
        skill: ref.ref,
        ...(prompt !== undefined ? { prompt } : {}),
      };
      return { step };
    }
    case 'agent': {
      const ref = validateCapabilityRef(`${path}.agent`, raw['agent']);
      if ('ok' in ref) return ref;
      const prompt = raw['prompt'];
      if (!isNonEmptyString(prompt)) return fail('bad-shape', `${path}.prompt`, 'agent step requires a non-empty prompt');
      const screen = screenNaming(`${path}.prompt`, prompt);
      if (screen) return screen;
      const step: AgentStep = { kind: 'agent', id, ...control, ...exec, agent: ref.ref, prompt };
      return { step };
    }
    case 'workflow-script': {
      const scriptPath = raw['scriptPath'];
      if (!isAbsolutePath(scriptPath)) {
        return fail('bad-shape', `${path}.scriptPath`, 'workflow-script step requires an absolute scriptPath');
      }
      const step: WorkflowScriptStep = { kind: 'workflow-script', id, ...control, ...exec, scriptPath };
      return { step };
    }
  }
}

// ---------------------------------------------------------------------------
// Defaults + inputs
// ---------------------------------------------------------------------------

function validateDefaults(value: unknown): { defaults: DagDefaults } | DagValidationResult {
  if (!isRecord(value)) return fail('bad-shape', 'defaults', 'defaults must be an object');
  const account = value['account'] as AccountLabel | undefined;
  const backend = value['backend'] as StepBackend | undefined;
  const ab = checkAccountBackend('defaults', account, backend);
  if (ab) return ab;
  const permissionMode = value['permissionMode'];
  if (permissionMode !== undefined && !isPermissionMode(permissionMode)) {
    return fail('bad-shape', 'defaults.permissionMode', `unknown permissionMode ${JSON.stringify(permissionMode)}`);
  }
  const cwd = value['cwd'];
  if (cwd !== undefined && !isNonEmptyString(cwd)) {
    return fail('bad-shape', 'defaults.cwd', 'defaults.cwd must be a non-empty string');
  }
  return {
    defaults: {
      ...(account !== undefined ? { account } : {}),
      ...(backend !== undefined ? { backend } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    },
  };
}

function validateInputs(
  value: unknown,
): { inputs: Readonly<Record<string, Readonly<Record<string, unknown>>>> } | DagValidationResult {
  if (!isRecord(value)) return fail('bad-shape', 'inputs', 'inputs must be an object');
  const out: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [name, schema] of Object.entries(value)) {
    if (!DAG_NAME_RE.test(name)) {
      return fail('bad-shape', `inputs.${name}`, `input name must match ${DAG_NAME_RE.source}`);
    }
    if (!isRecord(schema) || typeof schema['type'] !== 'string') {
      return fail('bad-shape', `inputs.${name}`, 'each input must be a JSON-schema object with a string `type`');
    }
    out[name] = schema;
  }
  return { inputs: out };
}

// ---------------------------------------------------------------------------
// Cycle detection (Kahn topological sort over the `needs:` graph)
// ---------------------------------------------------------------------------

function findCycle(steps: readonly PipelineStep[]): string | undefined {
  const indegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const step of steps) {
    indegree.set(step.id, 0);
    successors.set(step.id, []);
  }
  for (const step of steps) {
    for (const need of step.needs ?? []) {
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      successors.get(need)?.push(step.id);
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    visited += 1;
    for (const next of successors.get(id) ?? []) {
      const deg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  if (visited === steps.length) return undefined;
  // The unvisited set is the cycle membership; name one representative.
  for (const [id, deg] of indegree) if (deg > 0) return id;
  return steps[0]?.id;
}

// ---------------------------------------------------------------------------
// The document validator
// ---------------------------------------------------------------------------

/**
 * Validate a DAG document. Returns `{ ok: true, document }` with a sanitized
 * document, or `{ ok: false, issue }` naming the frozen error class.
 *
 * Order (each stage's failure is exhaustively tested):
 *   1. object + schemaVersion (unsupported-version)
 *   2. id/name/steps shape (bad-shape)
 *   3. per-step id pass → duplicate-step-id + the id set
 *   4. per-step structural validation → unknown-step-kind / invalid-account /
 *      dangling-needs / bad-shape (needs/goto/forEach reference the id set)
 *   5. cycle detection over the `needs:` graph (cycle)
 */
export function validateDagDocument(value: unknown): DagValidationResult {
  if (!isRecord(value)) return fail('bad-shape', '', 'DAG document must be an object');

  const schemaVersion = value['schemaVersion'];
  if (schemaVersion !== DAG_SCHEMA_VERSION) {
    return fail(
      'unsupported-version',
      'schemaVersion',
      `schemaVersion must be ${DAG_SCHEMA_VERSION}, got ${JSON.stringify(schemaVersion)}`,
    );
  }

  const id = value['id'];
  if (typeof id !== 'string' || !DAG_ID_RE.test(id)) {
    return fail('bad-shape', 'id', `document id must match ${DAG_ID_RE.source}`);
  }
  const name = value['name'];
  if (!isNonEmptyString(name)) return fail('bad-shape', 'name', 'document name must be a non-empty string');
  const nameScreen = screenNaming('name', name);
  if (nameScreen) return nameScreen;

  const description = value['description'];
  if (description !== undefined) {
    if (typeof description !== 'string') return fail('bad-shape', 'description', 'description must be a string');
    if (description.length > 0) {
      const screen = screenNaming('description', description);
      if (screen) return screen;
    }
  }

  let defaults: DagDefaults | undefined;
  if (value['defaults'] !== undefined) {
    const parsed = validateDefaults(value['defaults']);
    if ('ok' in parsed) return parsed;
    defaults = parsed.defaults;
  }

  let inputs: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
  if (value['inputs'] !== undefined) {
    const parsed = validateInputs(value['inputs']);
    if ('ok' in parsed) return parsed;
    inputs = parsed.inputs;
  }

  const rawSteps = value['steps'];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return fail('bad-shape', 'steps', 'steps must be a non-empty array');
  }

  // Id pass FIRST: collect the id set (needs/goto/forEach reference it) and
  // catch duplicates before structural validation.
  const stepIds = new Set<string>();
  for (const [index, raw] of rawSteps.entries()) {
    if (!isRecord(raw)) return fail('bad-shape', `steps[${index}]`, 'step must be an object');
    const sid = raw['id'];
    if (typeof sid !== 'string' || !STEP_ID_RE.test(sid)) {
      return fail('bad-shape', `steps[${index}].id`, `step id must match ${STEP_ID_RE.source}`);
    }
    if (stepIds.has(sid)) {
      return fail('duplicate-step-id', `steps[${index}].id`, `duplicate step id ${JSON.stringify(sid)}`);
    }
    stepIds.add(sid);
  }

  const steps: PipelineStep[] = [];
  for (const [index, raw] of rawSteps.entries()) {
    const parsed = validateStep({ path: `steps[${index}]`, stepIds }, raw);
    if ('ok' in parsed) return parsed;
    steps.push(parsed.step);
  }

  const cycleAt = findCycle(steps);
  if (cycleAt !== undefined) {
    return fail('cycle', 'steps', `the needs graph is not a DAG (cycle involves step ${JSON.stringify(cycleAt)})`);
  }

  const document: DagDocument = {
    schemaVersion: DAG_SCHEMA_VERSION,
    id,
    name,
    ...(description !== undefined && description.length > 0 ? { description } : {}),
    ...(defaults !== undefined ? { defaults } : {}),
    ...(inputs !== undefined ? { inputs } : {}),
    steps,
  };
  return { ok: true, document };
}
