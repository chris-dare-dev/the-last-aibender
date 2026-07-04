/**
 * FE-5 markup helper — a deliberately tiny element-description layer.
 *
 * WHY NOT REACT (yet): the FE-2 shell (react 19.2.7 per the locked FE stack)
 * lands in parallel with this slice; the launch views are therefore pure
 * `state → VNode` functions over this ~80-line helper, rendered to strings
 * for tests and for the shell's initial mount. The shapes are JSX-isomorphic
 * on purpose — porting a view to the FE-2 React tree is a mechanical
 * `h(...)` → JSX rewrite that changes no logic and no rendered output. This
 * is NOT a framework: no state, no diffing, no events (interactivity rides
 * the `data-action` contract in controller.ts).
 *
 * Escaping: all text and attribute values are HTML-escaped — free text
 * (prompts, purposes, history previews) can never smuggle markup or break an
 * attribute. Tests feed adversarial text through the full render.
 */

export interface VNode {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly (VNode | string)[];
}

const TAG_RE = /^[a-z][a-z0-9-]*$/;
const ATTR_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** HTML void elements that never render children or a closing tag. */
const VOID_TAGS = new Set(['br', 'hr', 'input', 'img', 'meta', 'link']);

export function h(
  tag: string,
  attrs: Readonly<Record<string, string>> = {},
  ...children: readonly (VNode | string | undefined | false)[]
): VNode {
  if (!TAG_RE.test(tag)) throw new RangeError(`invalid tag ${JSON.stringify(tag)}`);
  for (const name of Object.keys(attrs)) {
    if (!ATTR_NAME_RE.test(name)) {
      throw new RangeError(`invalid attribute name ${JSON.stringify(name)}`);
    }
  }
  const kept: (VNode | string)[] = [];
  for (const child of children) {
    if (child === undefined || child === false) continue; // conditional render
    kept.push(child);
  }
  if (VOID_TAGS.has(tag) && kept.length > 0) {
    throw new RangeError(`void element <${tag}> cannot have children`);
  }
  return Object.freeze({ tag, attrs: Object.freeze({ ...attrs }), children: Object.freeze(kept) });
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Render a VNode tree to an HTML string (deterministic, fully escaped). */
export function renderToHtml(node: VNode | string): string {
  if (typeof node === 'string') return escapeHtml(node);
  const attrs = Object.entries(node.attrs)
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join('');
  if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attrs}>`;
  const children = node.children.map(renderToHtml).join('');
  return `<${node.tag}${attrs}>${children}</${node.tag}>`;
}

/** Depth-first flatten of all text content (audit helper). */
export function textContent(node: VNode | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(textContent).join('');
}

/** Depth-first collect of nodes matching a predicate (test helper). */
export function collectNodes(node: VNode | string, match: (n: VNode) => boolean): VNode[] {
  if (typeof node === 'string') return [];
  const hits: VNode[] = [];
  if (match(node)) hits.push(node);
  for (const child of node.children) hits.push(...collectNodes(child, match));
  return hits;
}
