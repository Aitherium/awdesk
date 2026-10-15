/**
 * aither://space/ -- the whole platform as one explorable universe (BeadSpace).
 *
 * Main owns the data and every action: desk:space-get (the universe, never blank),
 * desk:space-verb / desk:space-explore (re-checked against main's own snapshot), and the
 * deck's own answer and credential doors for asks. This view only draws and asks.
 *
 * Owner rules: one obvious action (the Next pill and the panel's primary), no lists, no
 * menus. A new ask NEVER flies the camera or opens anything -- it only glows. The camera
 * moves on a click, a key, the Next pill, or a deep link (?at= | focus=next | card=).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useDeckState } from '../deck/use-deck-state';
import { SpaceSwitch, hasWebGL } from '../vendor/bead-space/space';
import type { ActionResult, ExploreResult, SpaceMode, VerbResult } from '../vendor/bead-space/space';
import { initialSelection, reduceSelection } from '../vendor/bead-space/universe';
import type { SelectionAction, SelectionState } from '../vendor/bead-space/universe';
import type { BeadVerb, UniverseData, UniverseNode } from '../vendor/bead-space/types';
import { buildSpaceModel, deepLinkOf, deepLinkTarget } from './space-model';
import type { SpaceGetResult } from './space-model';

const POLL_MS = 20_000;
const MODE_KEY = 'space.mode';

interface SpaceBridge {
  get(): Promise<SpaceGetResult>;
  verb(nodeId: string, verbId: string, confirmed: boolean): Promise<VerbResult>;
  explore(nodeId: string, exploreIndex: number, question?: string): Promise<ExploreResult & { text?: string }>;
}

interface DeckBridge {
  answer?(id: string, choice: string): Promise<boolean | { pending: true; via?: string }>;
  credential?(id: string, value: string): Promise<{ ok?: boolean; receipt?: string; error?: string; detail?: string }>;
}

function bridges(): { space: SpaceBridge | null; deck: DeckBridge | null } {
  const b = (typeof window !== 'undefined' ? window.deskBridge : undefined) as unknown as
    { space?: SpaceBridge; deck?: DeckBridge } | undefined;
  return { space: b?.space ?? null, deck: b?.deck ?? null };
}

function storedMode(): SpaceMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === '2d' ? '2d' : '3d';
  } catch {
    return '3d';
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'failed';
}

declare global {
  interface Window {
    /** Test hook (space-smoke.cjs): drive the selection and the mode without a mouse. */
    __space?: {
      select(id: string): void;
      selected(): string | null;
      mode(): SpaceMode;
      setMode(mode: SpaceMode): void;
    };
  }
}

export default function SpaceView() {
  const [deck] = useDeckState();
  const [result, setResult] = useState<SpaceGetResult | null>(null);
  const [mode, setModeState] = useState<SpaceMode>(storedMode);
  // No WebGL at all: draw 2D without overwriting the owner's stored choice.
  const [webgl] = useState(() => hasWebGL());
  const effectiveMode: SpaceMode = webgl ? mode : '2d';
  const [selection, setSelection] = useState<SelectionState | null>(null);

  // ---- the universe, polled only while the pane is on screen -----------------------
  const refresh = useCallback(async () => {
    const { space } = bridges();
    if (!space) {
      setResult({ ok: false, error: 'this desk build has no space bridge' });
      return;
    }
    try {
      const next = await space.get();
      setResult(next && typeof next === 'object' ? next : { ok: false, error: 'no answer' });
    } catch (err) {
      setResult((prev) => (prev && prev.ok ? prev : { ok: false, error: errorText(err) }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const model = useMemo(() => buildSpaceModel(result, deck), [result, deck]);
  const data = model.data;

  // ---- selection: one reducer over the CURRENT data, shared by 3D and 2D -----------
  const dataRef = useRef<UniverseData | null>(data);
  dataRef.current = data;
  const dispatch = useCallback((action: SelectionAction) => {
    setSelection((prev) => {
      const current = dataRef.current;
      if (!current) return prev;
      return reduceSelection(current, prev ?? initialSelection(current), action);
    });
  }, []);
  const state: SelectionState | null = data ? (selection ?? initialSelection(data)) : null;

  // ---- deep links: applied once, when the data can answer them ----------------------
  const link = useMemo(() => deepLinkOf(typeof window !== 'undefined' ? window.location.search : ''), []);
  const linkDone = useRef(!link.at && !link.focusNext && !link.card);
  useEffect(() => {
    if (linkDone.current || !data) return;
    const target = deepLinkTarget(link, model);
    if (!target) return; // a card not on the feed yet: wait for the next push
    linkDone.current = true;
    dispatch({ type: 'flyTo', id: target });
  }, [data, link, model, dispatch]);

  // ---- mode, persisted ---------------------------------------------------------------
  const setMode = useCallback((next: SpaceMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      /* storage refused: the mode still switches for this session */
    }
  }, []);

  // ---- the test hook ------------------------------------------------------------------
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = state?.selectedId ?? null;
  const modeRef = useRef<SpaceMode>(effectiveMode);
  modeRef.current = effectiveMode;
  useEffect(() => {
    window.__space = {
      select: (id: string) => dispatch({ type: 'flyTo', id }),
      selected: () => selectedRef.current,
      mode: () => modeRef.current,
      setMode,
    };
    return () => {
      delete window.__space;
    };
  }, [dispatch, setMode]);

  // ---- actions: every one goes to main ----------------------------------------------
  const onVerb = useCallback(async (node: UniverseNode, verb: BeadVerb, opts: { confirmed: boolean }): Promise<VerbResult> => {
    const { space } = bridges();
    if (!space) return { ok: false, error: 'no space bridge' };
    try {
      const r = await space.verb(node.id, verb.id, opts.confirmed);
      void refresh();
      return r && typeof r === 'object' ? r : { ok: false, error: 'no answer' };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }, [refresh]);

  const onAnswer = useCallback(async (cardId: string, key: string): Promise<ActionResult> => {
    const { deck: d } = bridges();
    if (typeof d?.answer !== 'function') return { ok: false, error: 'this desk build cannot answer cards here' };
    try {
      const r = await d.answer(cardId, key);
      if (r === true) return { ok: true };
      if (r && typeof r === 'object' && r.pending) return { ok: true };
      return { ok: false, error: 'the answer did not land' };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }, []);

  const onCredential = useCallback(async (cardId: string, value: string): Promise<ActionResult> => {
    const { deck: d } = bridges();
    if (typeof d?.credential !== 'function') return { ok: false, error: 'this desk build cannot store secrets here' };
    try {
      // The value goes to main exactly once; ok only when main saw the card answered.
      const r = await d.credential(cardId, value);
      if (r && r.ok === true) return { ok: true };
      return { ok: false, error: (r && (r.error || r.detail)) || 'Not stored' };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }, []);

  const onExplore = useCallback(async (node: UniverseNode, prompt: string): Promise<ExploreResult> => {
    const { space } = bridges();
    if (!space) return { ok: false, error: 'no space bridge' };
    // Main builds the prompt from ITS copy of the node; the page only names which one.
    const at = (node.explore ?? []).findIndex((e) => e && e.prompt === prompt);
    try {
      const r = await space.explore(node.id, at >= 0 ? at : 0);
      return r && typeof r === 'object' ? r : { ok: false, error: 'no answer' };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }, []);

  const shell = { position: 'fixed' as const, inset: 0, background: '#05060a', overflow: 'hidden' };

  if (!data || !state) {
    return (
      <div style={{ ...shell, color: '#8a8fa3', display: 'grid', placeItems: 'center', fontSize: 14 }} data-space="loading">
        {model.error ? `Space is not available: ${model.error}` : 'Opening space…'}
      </div>
    );
  }

  const note = !webgl ? '2D (no WebGL)' : '';
  return (
    <div style={shell} data-space="ready" data-source={result?.source ?? ''}>
      <SpaceSwitch
        data={data}
        mode={effectiveMode}
        onModeChange={setMode}
        state={state}
        dispatch={dispatch}
        onVerb={onVerb}
        onAnswer={onAnswer}
        onCredential={onCredential}
        onExplore={onExplore}
      />
      {model.badge || note ? (
        <div
          data-space-badge={model.badge || undefined}
          title={model.badge === 'local view' ? `The platform universe is not reachable${model.error ? `: ${model.error}` : ''}; this is what the desk sees by itself.`
            : model.badge === 'stale' ? `Last good copy${model.error ? ` -- live read failed: ${model.error}` : ''}` : undefined}
          style={{
            position: 'absolute', top: 16, left: 16, pointerEvents: 'auto',
            fontSize: 11, letterSpacing: 0.4, color: '#8a8fa3', opacity: 0.7,
            border: '1px solid #2a2d3a', borderRadius: 999, padding: '3px 9px', background: '#0b0d14cc',
          }}
        >
          {[model.badge, note].filter(Boolean).join(' · ')}
        </div>
      ) : null}
    </div>
  );
}
