// GENERATED from @aitherium/bead-space 0.2.0 by vendor_bead_space.py -- edit the package and re-run.
/**
 * One space, two renderers. The host owns the selection state (so 3D ↔ 2D keeps focus
 * and selection) and stores the mode; this component wires the keys, the search line,
 * the Next pill, the `3D | 2D` pill and the selection panel around whichever renderer
 * is showing.
 *
 * Keys: arrows step siblings · Enter / double-click descends (Enter flies to the search
 * match while there is search text) · Esc / Backspace / right-click ascends · `/` searches
 * · Space flies to the next ask · V toggles 3D/2D.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { UniverseData, UniverseNode } from '../types';
import { indexUniverse, visibleAt } from '../universe/levels';
import { search } from '../universe/selection';
import type { SearchHit, SelectionAction, SelectionState } from '../universe/selection';
import { allAsks } from '../universe/verbs';
import { ModePill, NextPill, SearchLine } from './Hud';
import { PALETTE } from './palette';
import { askGlow, positions3d } from './scene';
import { SelectionPanel } from './SelectionPanel';
import type { SpaceActions } from './SelectionPanel';
import { Space2D } from './Space2D';
import { Space3D } from './Space3D';
import type { FallbackReason } from './Space3D';

export type SpaceMode = '3d' | '2d';

export interface SpaceSwitchProps extends SpaceActions {
  data: UniverseData;
  mode: SpaceMode;
  /** Called on the pill, on V, and when 3D falls back. The host persists it. */
  onModeChange: (mode: SpaceMode) => void;
  state: SelectionState;
  dispatch: (action: SelectionAction) => void;
  onSelect?: (node: UniverseNode | null) => void;
  /** Defaults to the user's prefers-reduced-motion. */
  reducedMotion?: boolean;
  className?: string;
  style?: CSSProperties;
}

function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

function isPrintable(e: ReactKeyboardEvent): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}

export function SpaceSwitch(props: SpaceSwitchProps) {
  const { data, mode, onModeChange, state, dispatch, onSelect } = props;
  const prefersReduced = usePrefersReducedMotion();
  const reducedMotion = props.reducedMotion ?? prefersReduced;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [preArm, setPreArm] = useState<{ nodeId: string; verbId: string } | null>(null);
  const [exploringId, setExploringId] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const visible = useMemo(() => visibleAt(data, state.focusId), [data, state.focusId]);
  const positions = useMemo(() => positions3d(data), [data]);
  const glow = useMemo(() => askGlow(data), [data]);
  const hits = useMemo(() => (query ? search(data, query) : []), [data, query]);
  const matchIds = useMemo(() => new Set(hits.map((h) => h.id)), [hits]);
  const byId = indexUniverse(data).byId;
  const selected = state.selectedId ? byId.get(state.selectedId) ?? null : null;

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  useEffect(() => {
    onSelectRef.current?.(selected);
  }, [selected]);

  useEffect(() => {
    if (rootRef.current && typeof document !== 'undefined' && document.activeElement === document.body) {
      rootRef.current.focus({ preventScroll: true });
    }
  }, []);

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery('');
    setActive(0);
    rootRef.current?.focus({ preventScroll: true });
  };

  const fly = (hit: SearchHit) => {
    dispatch({ type: 'flyTo', id: hit.id });
    setPreArm(hit.verbId ? { nodeId: hit.id, verbId: hit.verbId } : null);
    closeSearch();
  };

  const flyToNextAsk = () => {
    const top = allAsks(data)[0];
    if (top) dispatch({ type: 'flyTo', id: top.node.id });
  };

  const toggle = () => onModeChange(mode === '3d' ? '2d' : '3d');

  const onFallback = (reason: FallbackReason) => {
    setNote(reason === 'slow' ? '2D: 3D ran too slowly' : '2D: no WebGL here');
    onModeChange('2d');
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"]')) return;
    const onButton = target.closest('button, a') != null;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        dispatch({ type: 'step', delta: 1 });
        return;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        dispatch({ type: 'step', delta: -1 });
        return;
      case 'Enter':
        if (onButton) return;
        e.preventDefault();
        if (query && hits.length) fly(hits[Math.min(active, hits.length - 1)]);
        else dispatch({ type: 'descend' });
        return;
      case 'Escape':
      case 'Backspace':
        e.preventDefault();
        if (searchOpen) closeSearch();
        else dispatch({ type: 'ascend' });
        return;
      case '/':
        e.preventDefault();
        setSearchOpen(true);
        return;
      case ' ':
        if (onButton) return;
        e.preventDefault();
        flyToNextAsk();
        return;
      case 'v':
      case 'V':
        e.preventDefault();
        toggle();
        return;
      default:
        if (isPrintable(e)) {
          e.preventDefault();
          setSearchOpen(true);
          setQuery((q) => q + e.key);
          setActive(0);
        }
    }
  };

  if (!visible) {
    return (
      <div className={props.className} style={{ ...props.style, background: PALETTE.void, color: PALETTE.quiet }}>
        Nothing to show yet.
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={props.className}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        outline: 'none',
        background: PALETTE.void,
        ...props.style,
      }}
    >
      {mode === '3d' ? (
        <Space3D
          data={data}
          visible={visible}
          positions={positions}
          glow={glow}
          state={state}
          dispatch={dispatch}
          matchIds={matchIds}
          reducedMotion={reducedMotion}
          exploringId={exploringId}
          anchorRef={anchorRef}
          onFallback={onFallback}
        />
      ) : (
        <div style={{ position: 'absolute', inset: 0 }}>
          <Space2D
            data={data}
            visible={visible}
            state={state}
            dispatch={dispatch}
            glow={glow}
            matchIds={matchIds}
            reducedMotion={reducedMotion}
            anchorRef={anchorRef}
          />
        </div>
      )}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {searchOpen || query ? (
          <SearchLine
            data={data}
            query={query}
            hits={hits}
            active={active}
            onQuery={(q) => {
              setQuery(q);
              setActive(0);
            }}
            onFly={fly}
            onNext={() => {
              if (!hits.length) return;
              const next = (active + 1) % hits.length;
              setActive(next);
              dispatch({ type: 'flyTo', id: hits[next].id });
            }}
            onClose={closeSearch}
          />
        ) : null}
        <ModePill mode={mode} onModeChange={onModeChange} note={note} />
        <NextPill data={data} onFly={(id) => dispatch({ type: 'flyTo', id })} />
        {selected ? (
          <div
            ref={anchorRef}
            style={{ position: 'absolute', left: 0, top: 0, visibility: 'hidden', pointerEvents: 'auto' }}
          >
            <SelectionPanel
              key={selected.id}
              node={selected}
              preArmVerbId={preArm && preArm.nodeId === selected.id ? preArm.verbId : null}
              onVerb={props.onVerb}
              onAnswer={props.onAnswer}
              onCredential={props.onCredential}
              onExplore={props.onExplore}
              onOpenChat={props.onOpenChat}
              onExploring={setExploringId}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
