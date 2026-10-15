// GENERATED from @aitherium/bead-space 0.2.0 by vendor_bead_space.py -- edit the package and re-run.
/* eslint-disable react-hooks/immutability -- an imperative scene: buffers, uniforms and
   label/panel element styles are written in frame callbacks and effects, never during
   render, which is the point (a setState per frame is the stutter this avoids). */
/**
 * The flat view: one level at a time as concentric rings in plain React SVG. No d3, no
 * WebGL — it is also the fallback when 3D cannot run. Same colours, same gestures:
 * click selects, double-click descends, right-click / Esc ascends.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { RefObject, WheelEvent as ReactWheelEvent } from 'react';

import type { UniverseData } from '../types';
import { childrenOf } from '../universe/levels';
import type { VisibleSet } from '../universe/levels';
import { extent2d, layout2d } from '../universe/layout';
import type { SelectionAction, SelectionState } from '../universe/selection';
import { spaceGestureAllowed } from './gesture';
import { FONTS, PALETTE, healthColor, isHollow, isQuiet } from './palette';
import type { AskGlow } from './scene';

export interface Space2DProps {
  data: UniverseData;
  visible: VisibleSet;
  state: SelectionState;
  dispatch: (action: SelectionAction) => void;
  glow: AskGlow;
  matchIds?: ReadonlySet<string>;
  reducedMotion?: boolean;
  /** The selection panel's wrapper; positioned beside the selected node. */
  anchorRef?: RefObject<HTMLDivElement | null>;
}

const LABEL_CAP = 24;

function radiusFor(childCount: number, isFocus: boolean): number {
  if (isFocus) return 26;
  return 9 + 3 * Math.sqrt(childCount);
}

export function Space2D({ data, visible, state, dispatch, glow, matchIds, reducedMotion, anchorRef }: Space2DProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wheelAccum = useRef(0);
  const xy = useMemo(() => layout2d(visible), [visible]);
  const extent = extent2d(visible.nodes.length - 1) + 70;

  const placed = visible.nodes.map((node, i) => ({
    node,
    x: xy[i * 2],
    y: xy[i * 2 + 1],
    r: radiusFor(childrenOf(data, node.id).length, i === 0),
    asks: glow.counts.get(node.id) ?? 0,
    urgent: glow.urgent.has(node.id),
  }));
  const at = new Map(placed.map((p) => [p.node.id, p]));

  // Labels: the focus, selected, hovered, every ask, then children up to the cap.
  const labelled = new Set<string>([visible.focus.id]);
  if (state.selectedId) labelled.add(state.selectedId);
  if (state.hoverId) labelled.add(state.hoverId);
  for (const p of placed) if (p.asks) labelled.add(p.node.id);
  for (const p of placed) {
    if (labelled.size >= LABEL_CAP + 3) break;
    labelled.add(p.node.id);
  }

  // Put the panel beside the selected node, on whichever side has room.
  useLayoutEffect(() => {
    const anchor = anchorRef?.current;
    const svg = svgRef.current;
    if (!anchor || !svg) return;
    const sel = state.selectedId ? at.get(state.selectedId) : undefined;
    const box = svg.getBoundingClientRect();
    const parent = anchor.offsetParent?.getBoundingClientRect() ?? box;
    const ctm = svg.getScreenCTM();
    if (!sel || !ctm) {
      anchor.style.transform = `translate(${Math.max(8, box.width - 360)}px, 64px)`;
      anchor.style.visibility = 'visible';
      return;
    }
    const pt = new DOMPoint(sel.x, sel.y).matrixTransform(ctm);
    const x = pt.x - parent.left;
    const y = pt.y - parent.top;
    const w = anchor.offsetWidth || 340;
    const h = anchor.offsetHeight || 200;
    const left = x + w + 40 < parent.width ? x + 28 : x - w - 28;
    const top = Math.min(Math.max(8, y - 40), Math.max(8, parent.height - h - 8));
    anchor.style.transform = `translate(${Math.max(8, left)}px, ${top}px)`;
    anchor.style.visibility = 'visible';
  });

  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    if (!spaceGestureAllowed({ type: 'wheel', ctrlKey: e.ctrlKey, metaKey: e.metaKey })) return;
    wheelAccum.current += e.deltaY;
    if (wheelAccum.current < -240) {
      wheelAccum.current = 0;
      const into = state.hoverId ?? state.selectedId;
      if (into && into !== visible.focus.id) dispatch({ type: 'descend', id: into });
    } else if (wheelAccum.current > 240) {
      wheelAccum.current = 0;
      dispatch({ type: 'ascend' });
    }
  };

  const pulse = !reducedMotion;
  return (
    <svg
      ref={svgRef}
      role="img"
      aria-label={`${visible.focus.title}: ${visible.nodes.length - 1} inside`}
      viewBox={`${-extent} ${-extent} ${extent * 2} ${extent * 2}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', height: '100%', display: 'block', background: PALETTE.void }}
      onWheel={onWheel}
      onClick={(e) => {
        if (e.target === svgRef.current) dispatch({ type: 'select', id: null });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        dispatch({ type: 'ascend' });
      }}
    >
      {/* Ghost ancestors: faint rings behind the level, outermost = the root. */}
      {visible.ghosts.map((g, i) => {
        const r = extent - 12 - (visible.ghosts.length - 1 - i) * 18;
        return (
          <g key={`ghost-${g.id}`} opacity={0.35}>
            <circle r={r} fill="none" stroke={PALETTE.hairline} strokeWidth={1} />
            <text
              x={0}
              y={-r + 12}
              textAnchor="middle"
              fill={PALETTE.quiet}
              style={{ fontFamily: FONTS.name, fontWeight: FONTS.nameWeight, fontSize: 10 }}
            >
              {g.title}
            </text>
          </g>
        );
      })}
      {visible.links.map((link, i) => {
        const a = at.get(link.source);
        const b = at.get(link.target);
        if (!a || !b) return null;
        const dashed = link.kind === 'blocks' || link.kind === 'related';
        return (
          <line
            key={`l${i}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={PALETTE.aitherium}
            strokeOpacity={0.35}
            strokeWidth={link.rel === 'traffic' ? 1.6 : 1}
            strokeDasharray={dashed ? '4 4' : undefined}
          />
        );
      })}
      {placed.map(({ node, x, y, r, asks, urgent }) => {
        const state3 = node.health?.state;
        const color = healthColor(state3);
        const hollow = isHollow(state3);
        const selected = node.id === state.selectedId;
        const matched = matchIds?.has(node.id) ?? false;
        const halo = urgent ? PALETTE.forge : PALETTE.gold;
        return (
          <g
            key={node.id}
            transform={`translate(${x} ${y})`}
            style={{ cursor: 'pointer' }}
            data-id={node.id}
            onClick={(e) => {
              e.stopPropagation();
              dispatch({ type: 'select', id: node.id });
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (node.id !== visible.focus.id) dispatch({ type: 'descend', id: node.id });
            }}
            onPointerEnter={() => dispatch({ type: 'hover', id: node.id })}
            onPointerLeave={() => dispatch({ type: 'hover', id: null })}
          >
            {asks ? (
              <circle r={r + 7} fill="none" stroke={halo} strokeWidth={2} strokeOpacity={0.85}>
                {pulse ? (
                  <animate attributeName="r" values={`${r + 5};${r + 11};${r + 5}`} dur="2.4s" repeatCount="indefinite" />
                ) : null}
              </circle>
            ) : null}
            <circle
              r={r}
              fill={hollow ? 'none' : color}
              fillOpacity={isQuiet(state3) ? 0.45 : 0.9}
              stroke={hollow ? PALETTE.quiet : color}
              strokeWidth={hollow ? 1.5 : 1}
              strokeDasharray={hollow ? '3 3' : undefined}
            />
            {selected || matched ? (
              <circle r={r + 3.5} fill="none" stroke={PALETTE.aitherium} strokeWidth={selected ? 2 : 1.2} />
            ) : null}
            {labelled.has(node.id) ? (
              <text
                y={r + 14}
                textAnchor="middle"
                fill={PALETTE.ink}
                style={{ fontFamily: FONTS.name, fontWeight: FONTS.nameWeight, fontSize: node.id === visible.focus.id ? 14 : 11 }}
              >
                {node.title}
                {node.meta?.metric != null ? (
                  <tspan x={0} dy={12} fill={PALETTE.quiet} style={{ fontFamily: FONTS.metric, fontSize: 9 }}>
                    {String(node.meta.metric)}
                  </tspan>
                ) : null}
              </text>
            ) : null}
            {asks ? (
              <text
                x={r * 0.75}
                y={-r * 0.75}
                fill={urgent ? PALETTE.forge : PALETTE.gold}
                style={{ fontFamily: FONTS.metric, fontSize: 10 }}
              >
                {asks}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
