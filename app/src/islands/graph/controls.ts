/**
 * FE-4 island controls — the DAY-ONE hairball levers as in-island DOM
 * (blueprint §8: "layer toggles + cluster-dim from day one"): one toggle per
 * node kind (layer axis) and a cluster-focus readout with a CLEAR action.
 * The island owns everything inside its host element (FE-3 doctrine), so the
 * strip lives here — chrome never knows graph specifics.
 *
 * Instrument Grade discipline (DESIGN.md): every color is a `var(--ig-*)`
 * reference — no literals; engraved mono-caps labels; state changes SNAP
 * (§3.6 — a relay, not a fade); no rounded corners beyond the token range.
 */

import type { GraphNodeKind } from './types.ts';
import { GRAPH_NODE_KINDS } from './types.ts';

/** Engraved labels (mono-caps, terse instrument voice). */
const KIND_LABELS: Record<GraphNodeKind, string> = {
  session: 'SES',
  'claude-md': 'INSTR',
  memory: 'MEM',
  'agent-artifact': 'ARTIF',
  reference: 'REF',
};

/** The slice of the island handle the strip drives. */
export interface GraphControlsIsland {
  setLayerVisible(kind: GraphNodeKind, visible: boolean): void;
  focusCluster(cluster: string | undefined): void;
  snapshot(): {
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly visibleKinds: readonly GraphNodeKind[];
    readonly focusedCluster: string | undefined;
  };
}

export interface GraphControlsHandle {
  /** Re-read the snapshot into the DOM (the island calls this per commit). */
  refresh(): void;
  readonly element: HTMLElement;
  dispose(): void;
}

const strip = (doc: Document): HTMLElement => {
  const el = doc.createElement('div');
  el.dataset['testid'] = 'graph-controls';
  el.style.position = 'absolute';
  el.style.top = 'var(--ig-space-8)';
  el.style.left = 'var(--ig-space-8)';
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.gap = 'var(--ig-space-4)';
  el.style.fontFamily = 'var(--ig-font-mono)';
  el.style.fontSize = '10px';
  el.style.letterSpacing = '0.08em';
  el.style.userSelect = 'none';
  el.style.zIndex = '1';
  return el;
};

export function attachGraphControls(
  host: HTMLElement,
  island: GraphControlsIsland,
): GraphControlsHandle {
  const doc = host.ownerDocument;
  // The island owns the host box; the strip overlays the canvas.
  if (host.style.position === '') host.style.position = 'relative';

  const root = strip(doc);
  const buttons = new Map<GraphNodeKind, HTMLButtonElement>();

  const paintButton = (btn: HTMLButtonElement, on: boolean): void => {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.style.color = on ? 'var(--ig-ink-secondary)' : 'var(--ig-ink-faint)';
    btn.style.borderColor = 'var(--ig-line-hairline)';
  };

  for (const kind of GRAPH_NODE_KINDS) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = KIND_LABELS[kind];
    btn.dataset['kind'] = kind;
    btn.dataset['testid'] = `graph-layer-${kind}`;
    btn.title = `toggle ${kind} layer`;
    btn.style.background = 'transparent';
    btn.style.border = '1px solid var(--ig-line-hairline)';
    btn.style.borderRadius = 'var(--ig-radius-1)';
    btn.style.padding = '1px 5px';
    btn.style.font = 'inherit';
    btn.style.letterSpacing = 'inherit';
    btn.addEventListener('click', () => {
      const visible = island.snapshot().visibleKinds.includes(kind);
      island.setLayerVisible(kind, !visible);
      refresh();
    });
    paintButton(btn, true);
    buttons.set(kind, btn);
    root.appendChild(btn);
  }

  const clusterBtn = doc.createElement('button');
  clusterBtn.type = 'button';
  clusterBtn.dataset['testid'] = 'graph-cluster-clear';
  clusterBtn.title = 'clear cluster focus';
  clusterBtn.style.background = 'transparent';
  clusterBtn.style.border = '1px solid var(--ig-line-hairline)';
  clusterBtn.style.borderRadius = 'var(--ig-radius-1)';
  clusterBtn.style.padding = '1px 5px';
  clusterBtn.style.font = 'inherit';
  clusterBtn.style.letterSpacing = 'inherit';
  clusterBtn.style.color = 'var(--ig-accent)';
  clusterBtn.addEventListener('click', () => {
    island.focusCluster(undefined);
    refresh();
  });
  root.appendChild(clusterBtn);

  const readout = doc.createElement('span');
  readout.dataset['testid'] = 'graph-readout';
  readout.style.color = 'var(--ig-ink-faint)';
  readout.style.marginLeft = 'var(--ig-space-4)';
  root.appendChild(readout);

  function refresh(): void {
    const snap = island.snapshot();
    for (const [kind, btn] of buttons) {
      paintButton(btn, snap.visibleKinds.includes(kind));
    }
    const focused = snap.focusedCluster;
    clusterBtn.style.display = focused === undefined ? 'none' : 'inline-block';
    clusterBtn.textContent = focused === undefined ? '' : `FOCUS ${focused} ×`;
    readout.textContent = `N ${snap.nodeCount} · E ${snap.edgeCount}`;
  }

  refresh();
  host.appendChild(root);

  return {
    element: root,
    refresh,
    dispose(): void {
      root.remove();
    },
  };
}
