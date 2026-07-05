/**
 * The pipeline templating engine (BE-8; findings pipeline-workflow-builder
 * §R2 "outputs live in the run journal and are templated (`${steps.<id>.
 * output…}`) into successors — NEVER through the model's context").
 *
 * A deliberately small, PURE substitution language (no arbitrary JS eval — the
 * whole point of the declarative-DAG choice, findings §R2/§R4). Supported
 * expressions inside `${…}`:
 *   ${workspace}                     the run's workspace path
 *   ${inputs.<name>}                 a bound input value
 *   ${item}                          the current forEach element
 *   ${steps.<id>.output}             a completed step's whole output
 *   ${steps.<id>.output.<path>}      a dotted/indexed path into it
 *   ${steps.<id>.outputs}            alias for the output (findings sketch used both)
 *
 * `when` and `loop.until` are evaluated by {@link evaluateCondition}: a tiny
 * comparison grammar (`<lhs> <op> <rhs>`, ops `== != > >= < <=`, or a bare
 * expression truthiness). NO general expression evaluator — the DAG is
 * declarative by design; anything richer is an ICR, never free-form JS.
 *
 * [X2]: templating reads run-journal values (machine-local content) and paths;
 * the identity screen already ran on the DAG document's naming fields at the
 * wire. Rendered prompts stay off the events/lineage wire (the workstream/
 * events precedent).
 */

/** The values a template/condition can read. */
export interface TemplateScope {
  /** The run's workspace absolute path (`${workspace}`). */
  readonly workspace?: string;
  /** Bound inputs (`${inputs.<name>}`). */
  readonly inputs: Readonly<Record<string, unknown>>;
  /** Completed step outputs by step id (`${steps.<id>.output…}`). */
  readonly steps: Readonly<Record<string, unknown>>;
  /** The current forEach element (`${item}`), when inside a fan-out. */
  readonly item?: unknown;
}

const EXPR_RE = /\$\{([^}]*)\}/g;

/**
 * Render `${…}` expressions in a template string. An unresolved reference
 * renders as the empty string (a missing optional input is not a hard error —
 * the launcher validates required inputs). A resolved non-string value is
 * JSON-stringified (objects/arrays templated into a prompt become JSON text).
 */
export function renderTemplate(template: string, scope: TemplateScope): string {
  return template.replace(EXPR_RE, (_full, exprRaw: string) => {
    const value = resolveExpression(exprRaw.trim(), scope);
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

/**
 * Resolve a `forEach` expression to its array. Returns [] for undefined /
 * non-array (the empty-forEach edge case: a step whose forEach resolves empty
 * runs zero times and is `skipped`, plan §9.2 edge).
 */
export function resolveArray(expr: string, scope: TemplateScope): readonly unknown[] {
  // A forEach body is a single `${…}` expression (the sketch form) OR a raw
  // reference. Strip a wrapping `${…}` if present.
  const inner = stripSingleExpr(expr);
  const value = resolveExpression(inner, scope);
  return Array.isArray(value) ? value : [];
}

/**
 * Evaluate a `when` / `loop.until` condition. Grammar:
 *   <expr> <op> <expr>    with op ∈ == != > >= < <=
 *   <expr>                bare truthiness (non-empty string, true, non-zero,
 *                         non-empty array/object)
 * Numeric comparison when both sides parse as numbers; else string compare.
 */
export function evaluateCondition(condition: string, scope: TemplateScope): boolean {
  const trimmed = condition.trim();
  const opMatch = /^(.*?)(==|!=|>=|<=|>|<)(.*)$/.exec(trimmed);
  if (opMatch !== null) {
    const lhs = resolveOperand(opMatch[1]!.trim(), scope);
    const op = opMatch[2]!;
    const rhs = resolveOperand(opMatch[3]!.trim(), scope);
    return compare(lhs, op, rhs);
  }
  return truthy(resolveOperand(trimmed, scope));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Strip a single wrapping `${…}` so `resolveArray('${steps.x.output.files}')` works. */
function stripSingleExpr(expr: string): string {
  const trimmed = expr.trim();
  const m = /^\$\{([^}]*)\}$/.exec(trimmed);
  return m !== null ? m[1]!.trim() : trimmed;
}

/**
 * Resolve one path expression against the scope. Returns the raw value (not
 * stringified) so comparisons and forEach see the real type.
 */
function resolveExpression(expr: string, scope: TemplateScope): unknown {
  if (expr === 'workspace') return scope.workspace;
  if (expr === 'item') return scope.item;

  const parts = expr.split('.');
  const head = parts[0];

  if (head === 'inputs') {
    return getPath(scope.inputs, parts.slice(1));
  }
  if (head === 'steps') {
    // steps.<id>.output(.<path>) | steps.<id>.outputs(.<path>)
    const stepId = parts[1];
    const accessor = parts[2];
    if (stepId === undefined) return undefined;
    const stepOutput = scope.steps[stepId];
    if (accessor === 'output' || accessor === 'outputs') {
      return getPath(stepOutput, parts.slice(3));
    }
    // steps.<id> alone → the whole output.
    if (accessor === undefined) return stepOutput;
    // steps.<id>.<field> → treat the rest as a path into the output.
    return getPath(stepOutput, parts.slice(2));
  }
  return undefined;
}

/**
 * An operand in a condition is EITHER a `${…}`/reference OR a literal (a
 * quoted string, a number, `true`/`false`, or a bare word). Also supports the
 * `.length` pseudo-property on arrays/strings (the sketch's
 * `${steps.audit.outputs.length} > 0`).
 */
function resolveOperand(raw: string, scope: TemplateScope): unknown {
  const expr = stripSingleExpr(raw);
  // Literal string?
  if ((expr.startsWith('"') && expr.endsWith('"')) || (expr.startsWith("'") && expr.endsWith("'"))) {
    return expr.slice(1, -1);
  }
  if (expr === 'true') return true;
  if (expr === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);

  // `.length` pseudo-property.
  if (expr.endsWith('.length')) {
    const base = resolveExpression(expr.slice(0, -'.length'.length), scope);
    if (typeof base === 'string' || Array.isArray(base)) return base.length;
    if (base !== null && typeof base === 'object') return Object.keys(base).length;
    return 0;
  }
  return resolveExpression(expr, scope);
}

function getPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(key);
      current = Number.isInteger(idx) ? current[idx] : undefined;
      continue;
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[key];
      continue;
    }
    // `.length` on a string handled by resolveOperand; a scalar has no path.
    return undefined;
  }
  return current;
}

function compare(lhs: unknown, op: string, rhs: unknown): boolean {
  const ln = toNumber(lhs);
  const rn = toNumber(rhs);
  const bothNumeric = ln !== undefined && rn !== undefined;
  switch (op) {
    case '==':
      return bothNumeric ? ln === rn : String(lhs) === String(rhs);
    case '!=':
      return bothNumeric ? ln !== rn : String(lhs) !== String(rhs);
    case '>':
      return bothNumeric ? ln > rn : String(lhs) > String(rhs);
    case '>=':
      return bothNumeric ? ln >= rn : String(lhs) >= String(rhs);
    case '<':
      return bothNumeric ? ln < rn : String(lhs) < String(rhs);
    case '<=':
      return bothNumeric ? ln <= rn : String(lhs) <= String(rhs);
    default:
      return false;
  }
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return undefined;
}

function truthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0 && value !== 'false';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}
