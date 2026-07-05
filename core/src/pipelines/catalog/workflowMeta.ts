/**
 * STATIC `export const meta` parser for saved native dynamic-workflow scripts
 * (BE-8; findings pipeline-workflow-builder §1.5/§R4 Option E interop #1).
 *
 * THE ONE HARD RULE (rule 3, [X2], arch-tested): a saved workflow script is
 * NEVER EXECUTED. Not `eval`, not `new Function`, not `import()`, not `vm`.
 * The scanner extracts the `name`/`description`/`phases` from the `meta`
 * export by REGEX + a bounded balanced-brace scan over the SOURCE TEXT — the
 * body (`await agent(...)`, top-level await, shell-less JS) is read as opaque
 * text and discarded. This module imports NOTHING from `node:vm`, `node:child_process`,
 * or the SDK; the architectural test asserts that (arch.spec.ts).
 *
 * A script with no recoverable `meta` is a DEGRADED workflow catalog row
 * (filename name) — never a crash, never an execution attempt.
 */

export interface WorkflowMetaOk {
  readonly ok: true;
  /** `meta.name`, when present. */
  readonly name?: string;
  /** `meta.description`, when present. */
  readonly description?: string;
  /** `meta.phases[].title`, when present (progress grouping, §1.5). */
  readonly phases?: readonly string[];
}

export interface WorkflowMetaDegraded {
  readonly ok: false;
  /** Identifier-free diagnostic — a static-parse reason, never a file path. */
  readonly reason: string;
}

export type WorkflowMetaResult = WorkflowMetaOk | WorkflowMetaDegraded;

/**
 * Extract the `meta` export from a workflow script's SOURCE TEXT without
 * executing it. Recognizes `export const meta = { … }` (the documented form,
 * §1.5). Everything else — the script body, imports (there shouldn't be any),
 * top-level await — is ignored.
 */
export function parseWorkflowMeta(source: string): WorkflowMetaResult {
  const marker = /export\s+const\s+meta\s*=\s*\{/.exec(source);
  if (marker === null) {
    return { ok: false, reason: 'no `export const meta` object found' };
  }
  const objectStart = marker.index + marker[0].length - 1; // position of the `{`
  const objectText = extractBalancedBraces(source, objectStart);
  if (objectText === undefined) {
    return { ok: false, reason: 'unterminated meta object literal' };
  }

  const name = extractStringField(objectText, 'name');
  const description = extractStringField(objectText, 'description');
  const phases = extractPhaseTitles(objectText);

  // A meta with none of the recognized fields is still a valid (if sparse)
  // parse — the name falls back to the filename in the scanner.
  return {
    ok: true,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(phases !== undefined ? { phases } : {}),
  };
}

/** From the `{` at `openIndex`, return the balanced-brace substring (incl. braces). */
function extractBalancedBraces(source: string, openIndex: number): string | undefined {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
    if (i - openIndex > 65_536) return undefined; // pathological-size guard
  }
  return undefined;
}

/** Extract a top-level `key: '…'` / `key: "…"` string value from an object literal. */
function extractStringField(objectText: string, key: string): string | undefined {
  // Match `key:` then a single- or double-quoted string. Deliberately does not
  // handle template literals or concatenation (a meta field is a literal, §1.5).
  const re = new RegExp(`(?:^|[,{\\s])${key}\\s*:\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`);
  const match = re.exec(objectText);
  if (match === null) return undefined;
  const value = unescape(match[2] ?? '');
  return value.length > 0 ? value : undefined;
}

/** Extract `phases: [ { title: '…' }, … ]` titles (best-effort, static). */
function extractPhaseTitles(objectText: string): readonly string[] | undefined {
  const phasesMatch = /phases\s*:\s*\[/.exec(objectText);
  if (phasesMatch === null) return undefined;
  const arrayStart = phasesMatch.index + phasesMatch[0].length - 1;
  const arrayText = extractBalancedBrackets(objectText, arrayStart);
  if (arrayText === undefined) return undefined;
  const titles: string[] = [];
  const titleRe = /title\s*:\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(arrayText)) !== null) {
    const t = unescape(m[2] ?? '');
    if (t.length > 0) titles.push(t);
  }
  return titles.length > 0 ? titles : undefined;
}

/** From the `[` at `openIndex`, return the balanced-bracket substring. */
function extractBalancedBrackets(source: string, openIndex: number): string | undefined {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
    if (i - openIndex > 65_536) return undefined;
  }
  return undefined;
}

/** Minimal string-escape unescaping (`\'` `\"` `\\` `\n` `\t`). */
function unescape(value: string): string {
  return value.replace(/\\(['"\\nt])/g, (_full, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    return ch;
  });
}
