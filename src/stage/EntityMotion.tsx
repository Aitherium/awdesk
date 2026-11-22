import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { worldPerPixel } from '../hooks/avatarDragMath';
import { cleanRect, lookYaw, rectTargetX, walkSteps, walkTargetX, walkYaw } from './entity-motion';

interface Props {
  positionOf: (slotId: string) => [number, number, number] | undefined;
  setPosition: (slotId: string, position: [number, number, number]) => void;
  setYaw: (slotId: string, yaw: number) => void;
  knownSlots: () => string[];
}

const STEP_MS = 30;

/**
 * Executes the entity verbs main sends (`walk-to`, `look-at`; electron/agent-swarm-host.cjs) inside the
 * canvas, where the camera is. A body's drawn position comes from projecting its world position; the
 * walk is screen-space (the mapping a drag uses), eased, and ends facing the camera again.
 */
export function EntityMotion({ positionOf, setPosition, setYaw, knownSlots }: Props) {
  const { camera, gl } = useThree();
  const walks = useRef(new Map<string, number>());

  useEffect(() => {
    const bridge = window.deskBridge;
    if (!bridge) return undefined;
    const clientXOf = (p: [number, number, number]) => {
      const rect = gl.domElement.getBoundingClientRect();
      const v = new THREE.Vector3(p[0], 1, p[2]).project(camera);
      return { x: rect.left + ((v.x + 1) / 2) * rect.width, width: rect.width, height: rect.height };
    };
    const off = bridge.subscribe((event) => {
      if (event.type !== 'walk-to' && event.type !== 'look-at') return;
      const slot = event.slotId;
      if (typeof slot !== 'string' || !knownSlots().includes(slot)) return;
      const pos = positionOf(slot);
      if (!pos) return;
      const view = clientXOf(pos);
      if (event.type === 'look-at') {
        const point = event.point as { x?: unknown } | null;
        setYaw(slot, point && Number.isFinite(Number(point.x)) ? lookYaw(view.x, Number(point.x), view.width) : 0);
        return;
      }
      const rect = cleanRect(event.rect);
      if (!rect) return;
      const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 45;
      const depth = camera.position.distanceTo(new THREE.Vector3(pos[0], 1, pos[2]));
      const wpp = worldPerPixel(depth, fov, Math.max(1, view.height));
      const to = walkTargetX(pos[0], view.x, rectTargetX(rect), wpp);
      const steps = walkSteps(pos[0], to);
      const prior = walks.current.get(slot);
      if (prior) window.clearTimeout(prior);
      setYaw(slot, walkYaw(pos[0], to));
      let i = 0;
      const tick = () => {
        setPosition(slot, [steps[i], pos[1], pos[2]]);
        i += 1;
        if (i < steps.length) walks.current.set(slot, window.setTimeout(tick, STEP_MS));
        else { walks.current.delete(slot); setYaw(slot, 0); }
      };
      tick();
    });
    const pending = walks.current;
    return () => {
      off();
      for (const t of pending.values()) window.clearTimeout(t);
      pending.clear();
    };
  }, [camera, gl, positionOf, setPosition, setYaw, knownSlots]);

  return null;
}
