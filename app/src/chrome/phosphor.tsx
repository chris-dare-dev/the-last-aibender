/**
 * Phosphor-decay freshness helper (DESIGN.md §3.2/§3.5). Wraps a live
 * readout value: on change the text lights amber instantly and decays to
 * resting ink (CSS animation, color-only). Under prefers-reduced-motion the
 * decay is replaced by the DISCRETE variant: a static amber freshness tick
 * shown while the sample is <2 s old, removed in one step.
 */

import { useEffect, useState, type ReactNode } from 'react';

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  });
  useEffect(() => {
    const mql = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (mql === undefined) return undefined;
    const onChange = (): void => setReduced(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export const REDUCED_MOTION_TICK_MS = 2000;

export interface PhosphorProps {
  /** Freshness key — the animation retriggers when this changes. */
  readonly signal: unknown;
  readonly children: ReactNode;
}

export function Phosphor({ signal, children }: PhosphorProps): ReactNode {
  const reduced = usePrefersReducedMotion();
  const [tickVisible, setTickVisible] = useState(false);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (signal === undefined) return undefined;
    setEpoch((e) => e + 1);
    if (!reduced) return undefined;
    setTickVisible(true);
    const handle = setTimeout(() => setTickVisible(false), REDUCED_MOTION_TICK_MS);
    return () => clearTimeout(handle);
  }, [signal, reduced]);

  if (reduced) {
    return (
      <span>
        {children}
        {tickVisible ? <span className="ig-fresh-tick" data-testid="fresh-tick" /> : null}
      </span>
    );
  }
  // key remount retriggers the CSS animation on each new sample.
  return (
    <span key={epoch} className={epoch > 0 ? 'ig-phosphor' : undefined}>
      {children}
    </span>
  );
}
