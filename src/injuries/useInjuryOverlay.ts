import { useCallback, useEffect, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { injuryView, parseInjuries, INJURY_TIERS, type InjuryTier } from './injury-view';
import { applyInjuryOverlay, clearInjuryOverlay, type VrmLike } from './injury-overlay';

/** What main sends per body (electron/injuries.cjs injuriesEvent): the export + the tier THIS desk's
 *  viewer may see (already decided in main from the adult-content mirror, the safety plane and the
 *  desk ceiling). */
export interface DeskInjuries {
  injuries: unknown;
  viewerTier: InjuryTier;
}

/** Sanitise an `injuries-avatar` event: an unknown tier is pg, never anything higher. */
export function sanitizeDeskInjuries(event: { injuries?: unknown; viewerTier?: unknown }): DeskInjuries {
  const tier = INJURY_TIERS.includes(event.viewerTier as InjuryTier) ? (event.viewerTier as InjuryTier) : 'pg';
  return { injuries: event.injuries ?? null, viewerTier: tier };
}

/** How often a mounted body re-reads its healing clock (a wound closing, blood fading). */
export const INJURY_REFRESH_MS = 5 * 60 * 1000;

/**
 * Keep one body's injury overlay in step with what main sent and with the clock. Returns `draw`,
 * for the model-ready path (the body's first frame should already be the injured one).
 */
export function useInjuryOverlay(vrmRef: RefObject<VRM | null>, value: DeskInjuries | undefined) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const keyRef = useRef<string | null>(null);

  const draw = useCallback((vrm: VRM | null, force = false) => {
    if (!vrm) return;
    const v = valueRef.current;
    const view = v ? injuryView(parseInjuries(v.injuries), v.viewerTier, Date.now()) : null;
    const key = view?.key ?? '';
    if (!force && key === keyRef.current) return;
    keyRef.current = key;
    try {
      applyInjuryOverlay(THREE, vrm as unknown as VrmLike, view);
    } catch (error) {
      console.warn('[desk] injury overlay failed', error);
    }
  }, []);

  const valueKey = value ? JSON.stringify([value.injuries, value.viewerTier]) : '';
  useEffect(() => {
    draw(vrmRef.current, true);
  }, [valueKey, draw, vrmRef]);

  useEffect(() => {
    if (!valueKey) return;
    const timer = setInterval(() => draw(vrmRef.current), INJURY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [valueKey, draw, vrmRef]);

  useEffect(
    () => () => {
      const vrm = vrmRef.current;
      if (vrm) clearInjuryOverlay(vrm as unknown as VrmLike);
    },
    [vrmRef],
  );

  return draw;
}
