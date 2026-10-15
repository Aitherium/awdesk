// GENERATED from @aitherium/bead-space 0.2.0 by vendor_bead_space.py -- edit the package and re-run.
/**
 * The only chrome on the space: a ghost search line that appears when you type, and one
 * pill saying what needs you. No lists, no menus.
 */
import { useEffect, useRef } from 'react';

import type { UniverseData } from '../types';
import type { SearchHit } from '../universe/selection';
import { allAsks } from '../universe/verbs';
import { FONTS, PALETTE } from './palette';

export interface SearchLineProps {
  data: UniverseData;
  query: string;
  hits: SearchHit[];
  /** Which hit Enter flies to (Tab advances it). */
  active: number;
  onQuery: (query: string) => void;
  onFly: (hit: SearchHit) => void;
  onNext: () => void;
  onClose: () => void;
}

/** Top-centre ghost line. Shows ONLY the single best match, as a ghost completion. */
export function SearchLine({ data, query, hits, active, onQuery, onFly, onNext, onClose }: SearchLineProps) {
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const best = hits.length ? hits[Math.min(active, hits.length - 1)] : null;
  const title = best ? data.nodes.find((n) => n.id === best.id)?.title ?? best.id : '';
  const completes = best != null && title.toLowerCase().startsWith(query.toLowerCase());
  const ghost = !best ? '' : completes ? title.slice(query.length) : `  →  ${title}`;
  return (
    <div
      style={{
        position: 'absolute',
        top: 18,
        left: '50%',
        transform: 'translateX(-50%)',
        minWidth: 320,
        maxWidth: '70%',
        pointerEvents: 'auto',
        fontFamily: FONTS.name,
        fontWeight: FONTS.nameWeight,
        fontSize: 18,
        color: PALETTE.ink,
        textAlign: 'center',
      }}
    >
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <span aria-hidden style={{ position: 'absolute', left: 0, top: 0, whiteSpace: 'pre', color: 'transparent' }}>
          {query}
          <span style={{ color: PALETTE.quiet }}>{ghost}</span>
        </span>
        <input
          ref={input}
          value={query}
          aria-label="Fly to"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              if (best) onFly(best);
            } else if (e.key === 'Tab') {
              e.preventDefault();
              onNext();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
          style={{
            position: 'relative',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            padding: 0,
            font: 'inherit',
            color: PALETTE.ink,
            caretColor: PALETTE.aitherium,
            width: `${Math.max(12, query.length + ghost.length + 1)}ch`,
          }}
        />
      </div>
      {query && !best ? (
        <div style={{ fontSize: 12, color: PALETTE.quiet, marginTop: 4 }}>nothing by that name</div>
      ) : null}
    </div>
  );
}

export interface NextPillProps {
  data: UniverseData;
  onFly: (nodeId: string) => void;
}

/** Bottom-centre: how many things need you and the top one. Click (or Space) flies there. */
export function NextPill({ data, onFly }: NextPillProps) {
  const asks = allAsks(data);
  const top = asks[0];
  const n = asks.length;
  return (
    <button
      type="button"
      disabled={!top}
      onClick={() => top && onFly(top.node.id)}
      style={{
        position: 'absolute',
        bottom: 20,
        left: '50%',
        transform: 'translateX(-50%)',
        maxWidth: '70%',
        padding: '9px 18px',
        borderRadius: 999,
        border: `1px solid ${top ? PALETTE.gold : PALETTE.hairline}`,
        background: `${PALETTE.surface}E6`,
        color: top ? PALETTE.gold : PALETTE.quiet,
        fontFamily: FONTS.name,
        fontWeight: FONTS.nameWeight,
        fontSize: 14,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        cursor: top ? 'pointer' : 'default',
        pointerEvents: 'auto',
      }}
    >
      {top ? `${n} thing${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you · ${top.ask.title}` : 'Nothing needs you'}
    </button>
  );
}

export interface ModePillProps {
  mode: '3d' | '2d';
  onModeChange: (mode: '3d' | '2d') => void;
  note?: string;
}

/** The single `3D | 2D` toggle (key V). */
export function ModePill({ mode, onModeChange, note }: ModePillProps) {
  const seg = (m: '3d' | '2d') => ({
    padding: '4px 10px',
    border: 'none',
    borderRadius: 999,
    background: mode === m ? PALETTE.aitherium : 'transparent',
    color: mode === m ? PALETTE.void : PALETTE.quiet,
    fontFamily: FONTS.metric,
    fontSize: 11,
    cursor: 'pointer',
  });
  return (
    <div style={{ position: 'absolute', top: 16, right: 16, textAlign: 'right', pointerEvents: 'auto' }}>
      <div
        role="group"
        aria-label="View"
        style={{ display: 'inline-flex', border: `1px solid ${PALETTE.hairline}`, borderRadius: 999, padding: 2, background: `${PALETTE.surface}CC` }}
      >
        <button type="button" aria-pressed={mode === '3d'} style={seg('3d')} onClick={() => onModeChange('3d')}>3D</button>
        <button type="button" aria-pressed={mode === '2d'} style={seg('2d')} onClick={() => onModeChange('2d')}>2D</button>
      </div>
      {note ? <div style={{ marginTop: 4, fontFamily: FONTS.metric, fontSize: 10, color: PALETTE.quiet }}>{note}</div> : null}
    </div>
  );
}
