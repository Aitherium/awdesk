import { useCallback, useEffect, useRef } from 'react';
import { Html } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { worldPerPixel } from '../hooks/avatarDragMath';
import { onDragAbort } from '../hooks/dragSafety';
import { groupCentre, handleLabel, shiftGroup, type StageGroup } from './stage-direct';

interface Props {
  groups: StageGroup[];
  /** Where a slot stands now (the layout), or undefined while unplaced. */
  positionOf: (slotId: string) => [number, number, number] | undefined;
  /** Move one slot (the same setter a body drag commits through). */
  setPosition: (slotId: string, position: [number, number, number]) => void;
  /** After a drag: tell main where the members stand now (its stage keeps its own copy). */
  onMoved?: (positions: Record<string, number>) => void;
}

/** The handle sits just under the group's feet, toward the camera: the full-body camera frames the
 *  feet and the heads of the tallest body can touch the top of the window, so a label ABOVE the
 *  heads went off the window (measured on the scratch desk, y = -59). */
const HANDLE_BELOW = 0.06;
const HANDLE_FORWARD = 0.45;

/**
 * One label over each stage (a group of two or more bodies). Dragging it moves the whole
 * group, never past the stage bound; main hears where they ended. It is a DOM chip, so the
 * click-through test (hooks/clickThrough.ts) treats it as something drawn: the window takes
 * the pointer there and nowhere else.
 */
export function StageHandles({ groups, positionOf, setPosition, onMoved }: Props) {
  const { camera, gl } = useThree();
  const dragging = useRef<string | null>(null);
  /** Ends the drag in flight (listeners off): called on unmount so a drag never outlives the handle. */
  const endNow = useRef<(() => void) | null>(null);
  useEffect(() => () => { endNow.current?.(); }, []);

  const begin = useCallback(
    (group: StageGroup, startX: number, startY: number) => {
      if (dragging.current) return;
      dragging.current = group.id;
      const start: Record<string, [number, number, number]> = {};
      for (const s of group.slots) {
        const p = positionOf(s);
        if (p) start[s] = [p[0], p[1], p[2]];
      }
      const c = groupCentre(group.slots, start);
      if (!c) { dragging.current = null; return; }
      const rect = gl.domElement.getBoundingClientRect();
      const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 45;
      const depth = camera.position.distanceTo(new THREE.Vector3(c.x, 1, c.z));
      const wpp = worldPerPixel(depth, fov, Math.max(1, rect.height));
      let last: Record<string, [number, number, number]> = start;
      let frame = 0;
      let pendingDx = 0;
      let lastApply = 0;
      const apply = () => {
        frame = 0;
        lastApply = performance.now();
        last = shiftGroup(start, pendingDx);
        for (const [slot, p] of Object.entries(last)) setPosition(slot, p);
      };
      // Every setPosition re-renders and persists the layout: at most ~20 a second while the handle is
      // dragged (the body drag commits once; review of #105), and the last position always lands on release.
      const move = (e: PointerEvent) => {
        pendingDx = (e.clientX - startX) * wpp;
        if (!frame && performance.now() - lastApply >= 50) frame = window.requestAnimationFrame(apply);
      };
      let disarm = () => {};
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        endNow.current = null;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        disarm();
        if (frame) window.cancelAnimationFrame(frame);
        apply(); // the position the pointer ended on, whatever the throttle skipped
        dragging.current = null;
        void startY;
        onMoved?.(Object.fromEntries(Object.entries(last).map(([slot, p]) => [slot, p[0]])));
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      disarm = onDragAbort(end);
      endNow.current = end;
    },
    [camera, gl, positionOf, setPosition, onMoved],
  );

  return (
    <>
      {groups.map((group) => {
        const pts = Object.fromEntries(group.slots.map((s) => [s, positionOf(s)]));
        const c = groupCentre(group.slots, pts);
        if (!c) return null;
        return (
          <Html key={group.id} position={[c.x, -HANDLE_BELOW, c.z + HANDLE_FORWARD]} center zIndexRange={[40, 0]}>
            <div
              className="stage-handle"
              role="button"
              aria-label={`${handleLabel(group)}: drag to move the stage`}
              title="Drag to move the whole stage"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                begin(group, e.clientX, e.clientY);
              }}
            >
              <span className="stage-handle-grip" aria-hidden="true">{'⠓'}</span>
              {handleLabel(group)}
            </div>
          </Html>
        );
      })}
    </>
  );
}
