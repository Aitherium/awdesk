/**
 * aither://space/ -- the whole platform as one explorable universe, drawn by the REAL
 * bead-space engine (createBeadSpace: d3-force + d3-zoom + the Kenney sprites), the same
 * one Veil's universe uses. See bead-engine.ts for how the desk carries it.
 *
 * Main owns the data and every action: desk:space-get (the universe, never blank),
 * desk:space-verb / desk:space-explore (re-checked against main's own snapshot), and the
 * deck's own answer and credential doors for asks. This view only draws and asks.
 *
 * One level at a time (bead-level.ts): the focus with one ring of children around it. A
 * click on a planet that has children flies INTO it (engine update()); a click on a leaf,
 * or on the focus itself, selects it and opens the panel. Esc / Backspace / the breadcrumb
 * (and its back arrow) go back up.
 *
 * What the engine cannot say, the desk draws INTO its planet groups after every update()
 * (`decorate`): an ask is a full pulsing gold ring with a count badge; health is a rim
 * whose arcs are the healthy / degraded / down shares (the grey rest is "not reporting"),
 * and a planet nothing reports on is drawn faint. Colours are each node's stable hue
 * (bead-level hueOf), handed to the engine through a palette array it reads by
 * reference -- refilled in place per level, like the options object below. The asks bar
 * (AsksBar) names every ask's place and flies there.
 *
 * The engine's hover card prints the raw id and the engine status, at the mouse. The
 * desk rewrites it in place (useTooltipFormatter) with the name, a health sentence and
 * the ask, and moves it beside the planet on the side that covers the fewest others
 * (preferring the side away from the focus). Per-level cluster order and anchors go in through the options
 * object the engine reads on every update().
 *
 * Owner rules: one obvious action (the Next pill and the panel's primary), no lists, no
 * menus. A new ask NEVER flies the camera or opens anything. The camera moves on a click,
 * a key, the Next pill, or a deep link (?at= | focus=next | card=).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';

import { useDeckState } from '../deck/use-deck-state';
import { FONTS, PALETTE } from '../vendor/bead-space/space/palette';
import { SelectionPanel } from '../vendor/bead-space/space/SelectionPanel';
import type { ActionResult, ExploreResult, VerbResult } from '../vendor/bead-space/space/SelectionPanel';
import { allAsks, indexUniverse, initialSelection, reduceSelection } from '../vendor/bead-space/universe';
import type { SelectionAction, SelectionState } from '../vendor/bead-space/universe';
import type {
  BeadNode, BeadSpaceHandle, BeadSpaceOptions, BeadVerb, UniverseData, UniverseNode,
} from '../vendor/bead-space/types';
import { AsksBar } from './AsksBar';
import { SPRITE_ROOT, loadBeadSpace } from './bead-engine';
import { MAX_LEVEL_NODES, beadLevel, clickIntent, normaliseUniverse } from './bead-level';
import type { BeadLevelData } from './bead-level';
import { contextLine, tooltipLines } from './tooltip';
import './space.css';
import { buildSpaceModel, deepLinkOf, deepLinkTarget, deskAuditOf, deskLensOf } from './space-model';
import {
  AUDIT_VERDICTS, LENS_TIERS, VERDICT_COLORS, VERDICT_WORDS, auditSentence, formatMb, lensSentence,
} from '../vendor/bead-space/space/panel-text';
import type { LensTier } from '../vendor/bead-space/space/panel-text';
import type { DeskAudit, SpaceGetResult } from './space-model';

/** The lens row: a profile tier, the fleet audit, or nothing. */
type DeskLensMode = LensTier | 'audit';

const POLL_MS = 20_000;

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

/**
 * Rewrites the engine's hover card whenever the engine fills it, and hides it for the
 * selected planet: the panel already says all of it, and the card covered the planet's
 * own label.
 */
function useTooltipFormatter(host: HTMLDivElement | null, ready: boolean,
  lines: (id: string) => ReturnType<typeof tooltipLines>, selectedId: string | null, focusId: string | null) {
  const focusRef = useRef(focusId);
  focusRef.current = focusId;
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const syncSelected = useCallback(() => {
    const tip = host?.querySelector<HTMLElement>('.bs-tooltip');
    if (!tip) return;
    tip.toggleAttribute('data-desk-selected', tip.dataset.deskId != null && tip.dataset.deskId === selectedRef.current);
  }, [host]);
  useEffect(() => {
    syncSelected();
  }, [selectedId, syncSelected]);
  useEffect(() => {
    if (!host || !ready) return undefined;
    const tip = host.querySelector<HTMLElement>('.bs-tooltip');
    if (!tip) return undefined;
    const rewrite = () => {
      const first = tip.firstElementChild as HTMLElement | null;
      if (!first || first.dataset.desk === '1') return; // ours already
      const id = first.textContent ?? ''; // the engine writes the node id here
      const l = linesRef.current(id);
      if (!l) return;
      tip.dataset.deskId = id;
      const title = document.createElement('strong');
      title.dataset.desk = '1';
      title.textContent = l.title;
      const body = document.createElement('div');
      body.className = 'bs-tip-body';
      body.textContent = l.body;
      const foot = document.createElement('small');
      foot.textContent = l.foot;
      if (l.ask) foot.dataset.deskAsk = '1';
      tip.replaceChildren(title, body, foot);
      syncSelected();
    };
    const observer = new MutationObserver(() => {
      rewrite();
      placeTip(host, tip, focusRef.current);
    });
    observer.observe(tip, { childList: true, attributes: true, attributeFilter: ['style', 'hidden'] });
    rewrite();
    return () => observer.disconnect();
  }, [host, ready, syncSelected]);
}

type DataEl = Element & { __data__?: { id?: string } };

function nodeGroup(host: HTMLElement, id: string | null): SVGGElement | null {
  if (id == null) return null;
  for (const g of host.querySelectorAll<SVGGElement>('g.bs-node')) {
    if ((g as DataEl).__data__?.id === id) return g;
  }
  return null;
}

function overlap(a: { l: number; t: number; r: number; b: number }, b: DOMRect): number {
  const w = Math.min(a.r, b.right) - Math.max(a.l, b.left);
  const h = Math.min(a.b, b.bottom) - Math.max(a.t, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Beside the hovered planet, never at the mouse: the engine's spot covered the planet's
 * own label and its neighbour (review r2). Eight candidates -- beside, above-beside and
 * below-beside on the side away from the focus, below, above, then the near side -- each
 * clamped to the pane; the one covering the least of the OTHER planets wins, ties to
 * that order. Writes only on change, so the
 * observer that calls it settles.
 */
function placeTip(host: HTMLElement, tip: HTMLElement, focusId: string | null) {
  if (tip.hidden) return;
  const g = nodeGroup(host, tip.dataset.deskId ?? null);
  if (!g) return;
  const hr = host.getBoundingClientRect();
  const nb = g.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const gap = 16;
  const pad = 14;
  const cx = nb.left + nb.width / 2;
  const focus = nodeGroup(host, focusId);
  const fb = focus && focus !== g ? focus.getBoundingClientRect() : null;
  const away = fb ? cx >= fb.left + fb.width / 2 : cx >= hr.left + hr.width / 2;
  const midY = nb.top + nb.height / 2 - h / 2;
  const right = { x: nb.right + gap, y: midY };
  const left = { x: nb.left - gap - w, y: midY };
  const below = { x: cx - w / 2, y: nb.bottom + gap };
  const above = { x: cx - w / 2, y: nb.top - gap - h };
  const rightUp = { x: nb.right + gap, y: nb.top - h };
  const rightDown = { x: nb.right + gap, y: nb.bottom };
  const leftUp = { x: nb.left - gap - w, y: nb.top - h };
  const leftDown = { x: nb.left - gap - w, y: nb.bottom };
  const candidates = away
    ? [right, rightUp, rightDown, below, above, left, leftUp, leftDown]
    : [left, leftUp, leftDown, below, above, right, rightUp, rightDown];
  const others = [...host.querySelectorAll<SVGGElement>('g.bs-node')].filter((x) => x !== g)
    .map((x) => x.getBoundingClientRect());
  let best: { x: number; y: number } | null = null;
  let bestCost = Infinity;
  for (const c of candidates) {
    const x = Math.min(Math.max(c.x, hr.left + pad), hr.right - w - pad);
    const y = Math.min(Math.max(c.y, hr.top + pad), hr.bottom - h - pad);
    const box = { l: x, t: y, r: x + w, b: y + h };
    // Covering the hovered planet itself is the worst outcome.
    let cost = overlap(box, nb) * 20;
    for (const o of others) cost += overlap(box, o);
    if (cost < bestCost - 1) {
      bestCost = cost;
      best = { x, y };
    }
  }
  if (!best) return;
  const leftPx = `${Math.round(best.x - hr.left)}px`;
  const topPx = `${Math.round(best.y - hr.top)}px`;
  if (tip.style.left !== leftPx) tip.style.left = leftPx;
  if (tip.style.top !== topPx) tip.style.top = topPx;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * Draws what the engine cannot into each of its planet groups (so it moves with them):
 * the health rim, the ask ring + count badge, and the label pushed below both. Run after
 * every create / update() -- update() rewrites each group's class, which carries
 * desk-asking / desk-unreported.
 */
function decorate(host: HTMLElement, level: BeadLevelData, dim: ReadonlySet<string> | null = null,
  audit: DeskAudit | null = null) {
  const byId = new Map(level.nodes.map((n) => [n.id, n]));
  for (const g of host.querySelectorAll<SVGGElement>('g.bs-node')) {
    const n = byId.get((g as DataEl).__data__?.id ?? '');
    let deco = g.querySelector<SVGGElement>(':scope > g.desk-deco');
    g.classList.toggle('desk-lensed', Boolean(n && dim?.has(n.id)));
    if (!n) {
      deco?.remove();
      continue;
    }
    const { mix, asks } = n.meta;
    g.classList.toggle('desk-asking', asks > 0);
    g.classList.toggle('desk-unreported', mix.total > 0 && mix.unknown === mix.total);
    const r = Number(g.querySelector('.bs-planet-core')?.getAttribute('r')) || 10;
    // Inside the engine's collide radius (r + 22) so neighbours' labels stay clear.
    const rim = r * 1.3 + 4;
    const ring = rim + 7;
    const label = g.querySelector<SVGTextElement>('.bs-label');
    const labelY = Math.round((asks > 0 ? ring : rim) + 14);
    label?.setAttribute('y', String(labelY));
    // The audit lens: a verdict ring outside everything else, and the RAM under the name.
    const verdict = audit?.verdict.get(n.id) ?? null;
    const ram = audit?.ramMb.get(n.id) ?? null;
    g.classList.toggle('desk-audited', Boolean(verdict));
    const sig = JSON.stringify([r, mix, asks, verdict, ram]);
    if (deco && deco.dataset.sig === sig) continue;
    if (!deco) {
      deco = svgEl('g', { class: 'desk-deco' }) as SVGGElement;
      g.insertBefore(deco, label);
    }
    deco.dataset.sig = sig;
    const parts: SVGElement[] = [];
    if (mix.total > 0) {
      const c = 2 * Math.PI * rim;
      parts.push(svgEl('circle', { class: 'desk-health-track', r: rim.toFixed(2) }));
      let offset = 0;
      for (const [cls, count] of [['ok', mix.ok], ['warn', mix.warn], ['down', mix.down]] as const) {
        if (!count) continue;
        const len = (c * count) / mix.total;
        parts.push(svgEl('circle', {
          class: `desk-health-arc ${cls}`, r: rim.toFixed(2), transform: 'rotate(-90)',
          'stroke-dasharray': `${len.toFixed(2)} ${c.toFixed(2)}`, 'stroke-dashoffset': (-offset).toFixed(2),
        }));
        offset += len;
      }
    }
    if (asks > 0) {
      parts.push(svgEl('circle', { class: 'desk-ask-ring', r: ring.toFixed(2) }));
      const d = ring * Math.SQRT1_2;
      const badge = svgEl('g', { class: 'desk-ask-badge', transform: `translate(${d.toFixed(1)} ${(-d).toFixed(1)})` });
      badge.append(svgEl('circle', { r: 9 }));
      const t = svgEl('text', { 'text-anchor': 'middle', dy: '0.35em' });
      t.textContent = asks > 9 ? '9+' : String(asks);
      badge.append(t);
      parts.push(badge);
    }
    if (verdict) {
      const vr = (asks > 0 ? ring : rim) + 5;
      const vring = svgEl('circle', { class: `desk-verdict ${verdict}`, r: vr.toFixed(2) });
      vring.style.stroke = VERDICT_COLORS[verdict];
      const title = svgEl('title', {});
      title.textContent = VERDICT_WORDS[verdict];
      vring.append(title);
      parts.push(vring);
    }
    if (ram !== null) {
      const t = svgEl('text', { class: 'desk-ram', 'text-anchor': 'middle', y: labelY + 14 });
      t.textContent = formatMb(ram);
      parts.push(t);
    }
    deco.replaceChildren(...parts);
  }
}

/**
 * Moves each ask badge to the corner of its ring that covers the fewest OTHER planets'
 * labels (top-right first). Run once a level has settled: positions move until then.
 */
function placeBadges(host: HTMLElement) {
  const labels = [...host.querySelectorAll<SVGTextElement>('g.bs-node .bs-label')];
  for (const badge of host.querySelectorAll<SVGGElement>('g.desk-ask-badge')) {
    const g = badge.closest('g.bs-node');
    const ring = g?.querySelector<SVGCircleElement>('.desk-ask-ring');
    const core = g?.querySelector<SVGCircleElement>('.bs-planet-core');
    if (!g || !ring || !core) continue;
    const cr = core.getBoundingClientRect();
    const r = Number(core.getAttribute('r')) || 10;
    const scale = cr.width / (2 * r) || 1;
    const d = Number(ring.getAttribute('r')) * Math.SQRT1_2;
    const cx = cr.left + cr.width / 2;
    const cy = cr.top + cr.height / 2;
    const others = labels.filter((l) => !g.contains(l)).map((l) => l.getBoundingClientRect());
    let best = [d, -d];
    let bestCost = Infinity;
    for (const [x, y] of [[d, -d], [-d, -d], [d, d], [-d, d]]) {
      const half = 10 * scale;
      const box = { l: cx + x * scale - half, r: cx + x * scale + half, t: cy + y * scale - half, b: cy + y * scale + half };
      let cost = 0;
      for (const o of others) cost += overlap(box, o);
      if (cost < bestCost - 0.5) {
        bestCost = cost;
        best = [x, y];
      }
    }
    badge.setAttribute('transform', `translate(${best[0].toFixed(1)} ${best[1].toFixed(1)})`);
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'failed';
}

declare global {
  interface Window {
    /** Test hook (space-smoke.cjs): drive the selection and the level without a mouse. */
    __space?: {
      select(id: string): void;
      selected(): string | null;
      focus(): string | null;
      descend(id: string): void;
      /** What the engine is drawing: node ids on screen and the engine's own counts. */
      drawn(): { nodes: number; planets: number; ships: number } | null;
    };
  }
}

export default function SpaceView() {
  const [deck] = useDeckState();
  const [result, setResult] = useState<SpaceGetResult | null>(null);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [engineError, setEngineError] = useState('');

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
  // "Infra" and "Infrastructure" become one planet before anything is drawn or selected.
  const data = useMemo(() => (model.data ? normaliseUniverse(model.data) : null), [model.data]);
  // The profile lens: dims what a tier would NOT keep and sums what it would cost. The
  // audit lens: rings every planet with the fleet audit's verdict and labels its RAM.
  const [lens, setLens] = useState<DeskLensMode>('none');
  const deskLens = useMemo(() => deskLensOf(data, lens === 'audit' ? 'none' : lens), [data, lens]);
  const deskAudit = useMemo(() => (lens === 'audit' ? deskAuditOf(data) : null), [data, lens]);
  const lensDimRef = useRef<ReadonlySet<string> | null>(null);
  lensDimRef.current = deskLens ? deskLens.dim : null;
  const auditRef = useRef<DeskAudit | null>(null);
  auditRef.current = deskAudit;
  // Right-click on a planet: select it with its start/park verb in the primary slot.
  const [preArm, setPreArm] = useState<{ nodeId: string; verbId: string } | null>(null);

  // ---- selection: the package's universe reducer over the CURRENT data ---------------
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
  const focusId = state?.focusId ?? null;
  const level = useMemo(() => (data ? beadLevel(data, focusId) : null), [data, focusId]);
  const stateRef = useRef<SelectionState | null>(state);
  stateRef.current = state;

  // ---- deep links: applied once, when the data can answer them ----------------------
  const link = useMemo(() => deepLinkOf(typeof window !== 'undefined' ? window.location.search : ''), []);
  const linkDone = useRef(!link.at && !link.focusNext && !link.card);
  useEffect(() => {
    if (linkDone.current || !data) return;
    const target = deepLinkTarget(link, model);
    if (!target) return; // a card not on the feed yet: wait for the next push
    linkDone.current = true;
    const merged = (data.meta.mergedInto ?? {}) as Record<string, string>;
    dispatch({ type: 'flyTo', id: merged[target] ?? target });
  }, [data, link, model, dispatch]);

  // ---- the engine: created once, fed one level at a time -----------------------------
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<BeadSpaceHandle | null>(null);
  const shownFocus = useRef<string | null>(null);
  const echo = useRef(false); // true while WE call handle.select (it calls onSelect back)
  const levelRef = useRef(level);
  levelRef.current = level;
  const [engineReady, setEngineReady] = useState(false);
  // The engine reads clusterOrder / clusterAnchors off THIS object on every update(), and
  // tints cluster i with clusterPalette[i] off THIS array: both are refilled per level.
  const optionsRef = useRef<BeadSpaceOptions | null>(null);
  const paletteRef = useRef<string[]>([]);

  const onEngineSelect = useCallback((node: BeadNode | null) => {
    if (echo.current) return;
    const current = dataRef.current;
    const st = stateRef.current;
    if (!current || !st) return;
    if (!node) {
      dispatch({ type: 'select', id: null });
      return;
    }
    if (clickIntent(current, st.focusId, node.id) === 'descend') dispatch({ type: 'descend', id: node.id });
    else dispatch({ type: 'select', id: node.id });
  }, [dispatch]);

  const hasLevel = level != null;
  useEffect(() => {
    if (!hasLevel || handleRef.current) return;
    let cancelled = false;
    loadBeadSpace().then((engine) => {
      const first = levelRef.current;
      const el = hostRef.current;
      if (cancelled || !first || !el || handleRef.current) return;
      paletteRef.current.splice(0, paletteRef.current.length, ...first.palette);
      const options: BeadSpaceOptions = {
        assetRoot: SPRITE_ROOT,
        clusterOrder: first.clusterOrder,
        clusterAnchors: first.anchors,
        clusterPalette: paletteRef.current,
        labelsAlwaysBelow: MAX_LEVEL_NODES,
        onSelect: onEngineSelect,
      };
      optionsRef.current = options;
      handleRef.current = engine.createBeadSpace(el, { nodes: first.nodes, links: first.links }, options);
      decorate(el, first, lensDimRef.current, auditRef.current);
      window.setTimeout(() => placeBadges(el), 2600);
      shownFocus.current = first.focusId;
      setEngineReady(true);
    }).catch((err) => {
      if (!cancelled) setEngineError(errorText(err));
    });
    return () => {
      cancelled = true;
    };
  }, [hasLevel, onEngineSelect]);

  useEffect(() => () => {
    handleRef.current?.destroy();
    handleRef.current = null;
  }, []);

  // A lens change re-dims the drawn planets in place; nothing moves, no status changes.
  useEffect(() => {
    if (handleRef.current && hostRef.current && level) {
      decorate(hostRef.current, level, deskLens ? deskLens.dim : null, deskAudit);
    }
  }, [deskLens, deskAudit, level]);

  // A new level (a drill, or a refresh of this one) goes in through update().
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle || !level) return undefined;
    if (optionsRef.current) {
      optionsRef.current.clusterOrder = level.clusterOrder;
      optionsRef.current.clusterAnchors = level.anchors;
    }
    paletteRef.current.splice(0, paletteRef.current.length, ...level.palette);
    handle.update({ nodes: level.nodes, links: level.links });
    if (hostRef.current) decorate(hostRef.current, level, lensDimRef.current, auditRef.current);
    if (shownFocus.current === level.focusId) return undefined;
    shownFocus.current = level.focusId;
    handle.fit();
    // The new level is still settling; frame it again once it has (and re-seat the badges).
    const timers = [900, 2600].map((ms) => window.setTimeout(() => {
      handleRef.current?.fit();
      if (hostRef.current) placeBadges(hostRef.current);
    }, ms));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [level, engineReady]);

  const [hostEl, setHostEl] = useState<HTMLDivElement | null>(null);
  const bindHost = useCallback((el: HTMLDivElement | null) => {
    hostRef.current = el;
    setHostEl(el);
  }, []);

  // ---- the asks bar: the pill cycles through every ask, a chip flies to its own -------
  const [askCursor, setAskCursor] = useState(0);
  const flyToAsk = useCallback((i: number) => {
    const current = dataRef.current;
    if (!current) return;
    const asks = allAsks(current);
    if (!asks.length) return;
    const at = ((i % asks.length) + asks.length) % asks.length;
    setAskCursor(at);
    dispatch({ type: 'flyTo', id: asks[at].node.id });
  }, [dispatch]);
  const onNext = useCallback(() => {
    const current = dataRef.current;
    if (!current) return;
    const asks = allAsks(current);
    if (!asks.length) return;
    let i = askCursor % asks.length;
    // Already there: the click means "the next one".
    if (stateRef.current?.selectedId === asks[i].node.id) i = (i + 1) % asks.length;
    flyToAsk(i);
  }, [askCursor, flyToAsk]);

  // The reducer's selection drives the engine's ring and dimming.
  const selectedId = state?.selectedId ?? null;
  useTooltipFormatter(hostEl, engineReady, (id) => tooltipLines(levelRef.current, dataRef.current, id), selectedId,
    level?.focusId ?? null);
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    const onScreen = selectedId != null && (level?.nodes.some((n) => n.id === selectedId) ?? false);
    echo.current = true;
    try {
      handle.select(onScreen ? selectedId : null);
    } finally {
      echo.current = false;
    }
  }, [selectedId, level, engineReady]);

  // ---- the test hook ------------------------------------------------------------------
  useEffect(() => {
    window.__space = {
      select: (id: string) => dispatch({ type: 'flyTo', id }),
      selected: () => stateRef.current?.selectedId ?? null,
      focus: () => stateRef.current?.focusId ?? null,
      descend: (id: string) => dispatch({ type: 'descend', id }),
      drawn: () => {
        const handle = handleRef.current;
        const root = hostRef.current;
        if (!handle || !root) return null;
        const stats = handle.stats();
        return {
          nodes: stats.nodes,
          planets: root.querySelectorAll('g.bs-node').length,
          ships: stats.orbits + stats.patrols,
        };
      },
    };
    return () => {
      delete window.__space;
    };
  }, [dispatch]);

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

  // Right-click a planet: select it with its start / park verb pre-armed in the primary
  // slot (park still needs its second, confirming click). No menu: the panel is the menu.
  const onContextMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as Element | null;
    const g = (target && typeof target.closest === 'function' ? target.closest('g.bs-node') : null) as DataEl | null;
    const id = g?.__data__?.id;
    const current = dataRef.current;
    if (!id || !current) return;
    e.preventDefault();
    const node = indexUniverse(current).byId.get(id);
    const unitVerb = (node?.verbs ?? []).find((v) => v.transport === 'unit');
    setPreArm(unitVerb ? { nodeId: id, verbId: unitVerb.id } : null);
    dispatch({ type: 'select', id });
  }, [dispatch]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"]')) return;
    const onButton = target.closest('button, a') != null;
    switch (e.key) {
      case 'Escape':
      case 'Backspace':
        e.preventDefault();
        dispatch({ type: 'ascend' });
        return;
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
      case ' ': {
        if (onButton || !data) return;
        e.preventDefault();
        onNext();
        return;
      }
      default:
    }
  };

  const shell = { position: 'fixed' as const, inset: 0, background: '#07101c', overflow: 'hidden' };

  if (!data || !state || !level) {
    return (
      <div style={{ ...shell, color: '#8a8fa3', display: 'grid', placeItems: 'center', fontSize: 14 }} data-space="loading">
        {model.error ? `Space is not available: ${model.error}` : 'Opening space…'}
      </div>
    );
  }

  const selected = state.selectedId ? indexUniverse(data).byId.get(state.selectedId) ?? null : null;
  const chip = {
    fontFamily: FONTS.name, fontSize: 14, letterSpacing: 0.2, color: PALETTE.ink,
    border: '1px solid #2B3D50', borderRadius: 999, padding: '6px 14px',
    background: `${PALETTE.surface}E6`, cursor: 'pointer',
  };
  const up = level.path.length > 1 ? level.path[level.path.length - 2] : null;
  return (
    <div style={shell} data-space="ready" data-source={result?.source ?? ''} data-focus={level.focusId}
      tabIndex={0} onKeyDown={onKeyDown} onContextMenu={onContextMenu}>
      <div ref={bindHost} data-space-engine="bead-space" style={{ position: 'absolute', inset: 0 }} />
      {engineError ? (
        <div role="alert" style={{ position: 'absolute', top: '45%', width: '100%', textAlign: 'center', color: PALETTE.danger }}>
          Space could not start its renderer: {engineError}
        </div>
      ) : null}
      <nav aria-label="Where you are" data-space-path
        style={{ position: 'absolute', top: 16, left: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {up ? (
          <button type="button" data-space-back aria-label={`Back to ${up.title}`} title={`Back to ${up.title} (Esc)`}
            style={{ ...chip, padding: '6px 12px' }} onClick={() => dispatch({ type: 'ascend' })}>
            ←
          </button>
        ) : null}
        {level.path.map((p, i) => {
          const here = i === level.path.length - 1;
          return (
            <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {i > 0 ? <span aria-hidden style={{ color: PALETTE.quiet, fontSize: 14 }}>›</span> : null}
              <button type="button"
                style={{ ...chip, color: here ? '#FFFFFF' : '#AEB9C4', fontWeight: here ? 500 : 300 }}
                onClick={() => (here ? dispatch({ type: 'select', id: p.id }) : dispatch({ type: 'descend', id: p.id }))}>
                {p.title}
              </button>
            </span>
          );
        })}
        {level.hidden > 0 ? (
          <span style={{ ...chip, cursor: 'default', color: PALETTE.quiet }}>
            {level.hidden} more not drawn
          </span>
        ) : null}
        {model.badge ? (
          <span
            data-space-badge={model.badge}
            title={model.badge === 'local view' ? `The platform universe is not reachable${model.error ? `: ${model.error}` : ''}; this is what the desk sees by itself.`
              : model.badge === 'direct' ? `Live, read straight from Genesis on the fleet${model.error ? ` (api.aitherium.com: ${model.error})` : ''}`
                : `Last good copy${model.error ? ` -- live read failed: ${model.error}` : ''}`}
            style={{ ...chip, cursor: 'default', color: PALETTE.quiet }}
          >
            {model.badge}
          </span>
        ) : null}
      </nav>
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <AsksBar data={data} level={level} index={askCursor} onNext={onNext} onFly={flyToAsk} />
        <div data-space-lens={lens} style={{ position: 'absolute', left: 16, top: 64, pointerEvents: 'auto' }}>
          <div role="group" aria-label="Profile lens" style={{ display: 'inline-flex', gap: 4 }}>
            {[...LENS_TIERS, 'audit' as const, 'none' as const].map((t) => (
              <button key={t} type="button" aria-pressed={lens === t} onClick={() => setLens(t)}
                style={{ ...chip, padding: '4px 10px', fontSize: 11, color: lens === t ? '#FFFFFF' : PALETTE.quiet,
                  borderColor: lens === t ? PALETTE.aitherium : undefined }}>
                {t}
              </button>
            ))}
          </div>
          {deskLens ? (
            <div data-space-lens-sum style={{ marginTop: 4, fontFamily: FONTS.metric, fontSize: 11, color: '#C9D3DD' }}>
              {lensSentence(deskLens.summary)}
            </div>
          ) : null}
          {deskAudit ? (
            <div data-space-audit style={{ marginTop: 4, fontFamily: FONTS.metric, fontSize: 11, color: '#C9D3DD' }}>
              <div data-space-audit-sum>
                {deskAudit.summary ? auditSentence(deskAudit.summary)
                  : 'audit not measured yet (fleet_audit.py --write measures it)'}
              </div>
              {deskAudit.drift ? (
                <div data-space-audit-drift style={{ marginTop: 3, color: VERDICT_COLORS['trim-candidate'] }}>
                  {`fleet moved since: ${deskAudit.drift.running} running now (desk probe${
                    deskAudit.drift.at ? ` ${new Date(deskAudit.drift.at).toLocaleTimeString()}` : ''
                  }); rings are the measured state`}
                </div>
              ) : null}
              {deskAudit.summary ? (
                <div data-space-audit-legend style={{ marginTop: 3, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {AUDIT_VERDICTS.filter((v) => deskAudit.summary?.byVerdict[v]).map((v) => (
                    <span key={v} title={VERDICT_WORDS[v]} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: VERDICT_COLORS[v] }} />
                      {v} {deskAudit.summary?.byVerdict[v]}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {selected ? (
          <div style={{ position: 'absolute', top: 56, right: 16, maxHeight: 'calc(100% - 140px)', overflowY: 'auto', pointerEvents: 'auto' }}>
            <SelectionPanel
              key={selected.id}
              node={selected}
              preArmVerbId={preArm && preArm.nodeId === selected.id ? preArm.verbId : null}
              onVerb={onVerb}
              onAnswer={onAnswer}
              onCredential={onCredential}
              onExplore={onExplore}
              context={contextLine(data, selected.id)}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
