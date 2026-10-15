// GENERATED from @aitherium/bead-space 0.2.0 by vendor_bead_space.py -- edit the package and re-run.
/**
 * Where you are and what you are looking at, as a reducer both renderers share, so
 * switching 3D ↔ 2D keeps the focus and the selection. Plus search-to-fly.
 */
import type { UniverseData, UniverseNode } from '../types';
import { childrenOf, indexUniverse, parentOf } from './levels';

export interface SelectionState {
  /** The node whose level is shown (it and its children). */
  focusId: string | null;
  selectedId: string | null;
  hoverId: string | null;
  /** Focus ids we came from, most recent last. */
  history: string[];
}

export type SelectionAction =
  | { type: 'select'; id: string | null }
  | { type: 'hover'; id: string | null }
  /** Into `id` (default: the selection). A node with no children is selected instead. */
  | { type: 'descend'; id?: string | null }
  /** Up one level; the level we left becomes the selection. */
  | { type: 'ascend' }
  /** Show `id` where it lives (its parent's level) and select it. */
  | { type: 'flyTo'; id: string }
  /** Arrow keys: the next (+1) or previous (-1) child of the focus. */
  | { type: 'step'; delta: number };

const HISTORY_CAP = 50;

export function initialSelection(data: UniverseData): SelectionState {
  return {
    focusId: indexUniverse(data).root?.id ?? null,
    selectedId: null,
    hoverId: null,
    history: [],
  };
}

function pushHistory(history: string[], id: string | null): string[] {
  if (id == null) return history;
  const next = [...history, id];
  return next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next;
}

function moveFocus(state: SelectionState, focusId: string | null, selectedId: string | null): SelectionState {
  if (focusId === state.focusId && selectedId === state.selectedId) return state;
  return {
    ...state,
    focusId,
    selectedId,
    history: focusId !== state.focusId ? pushHistory(state.history, state.focusId) : state.history,
  };
}

/** Pure reducer. `data` resolves parents and children; unknown ids are no-ops. */
export function reduceSelection(
  data: UniverseData,
  state: SelectionState,
  action: SelectionAction,
): SelectionState {
  const { byId, root } = indexUniverse(data);
  // A focus that vanished with a data refresh falls back to the root.
  const focusId = state.focusId != null && byId.has(state.focusId) ? state.focusId : root?.id ?? null;
  if (focusId !== state.focusId) state = { ...state, focusId };
  switch (action.type) {
    case 'select': {
      const id = action.id != null && byId.has(action.id) ? action.id : null;
      return id === state.selectedId ? state : { ...state, selectedId: id };
    }
    case 'hover': {
      const id = action.id != null && byId.has(action.id) ? action.id : null;
      return id === state.hoverId ? state : { ...state, hoverId: id };
    }
    case 'descend': {
      const target = action.id !== undefined ? action.id : state.selectedId;
      if (target == null || !byId.has(target)) return state;
      if (childrenOf(data, target).length === 0) {
        return target === state.selectedId ? state : { ...state, selectedId: target };
      }
      return moveFocus(state, target, null);
    }
    case 'ascend': {
      if (state.focusId == null) return state;
      const up = parentOf(data, state.focusId);
      if (up == null) {
        return state.selectedId == null ? state : { ...state, selectedId: null };
      }
      return moveFocus(state, up, state.focusId);
    }
    case 'flyTo': {
      if (!byId.has(action.id)) return state;
      const up = parentOf(data, action.id);
      if (up == null) return moveFocus(state, action.id, null);
      return moveFocus(state, up, action.id);
    }
    case 'step': {
      const kids = childrenOf(data, state.focusId);
      if (!kids.length) return state;
      const at = kids.findIndex((n) => n.id === state.selectedId);
      const delta = action.delta >= 0 ? 1 : -1;
      const next = at < 0
        ? (delta > 0 ? 0 : kids.length - 1)
        : (at + delta + kids.length) % kids.length;
      return { ...state, selectedId: kids[next].id };
    }
    default:
      return state;
  }
}

/** A reducer bound to one dataset, for `useReducer`. */
export function createSelectionReducer(data: UniverseData) {
  return (state: SelectionState, action: SelectionAction): SelectionState =>
    reduceSelection(data, state, action);
}

export interface SearchHit {
  id: string;
  /** Set when the query named a verb ("sleep gpu"): the verb to pre-arm. */
  verbId?: string;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function localId(id: string): string {
  const colon = id.indexOf(':');
  return (colon >= 0 ? id.slice(colon + 1) : id).toLowerCase();
}

/** 0 = prefix, 1 = verb phrase, 2 = substring, -1 = no match. */
function matchClass(node: UniverseNode, q: string, qWords: string[]): { cls: number; verbId?: string } {
  const title = node.title.toLowerCase();
  const id = node.id.toLowerCase();
  const local = localId(node.id);
  if (title.startsWith(q) || local.startsWith(q) || id.startsWith(q)) return { cls: 0 };
  for (const verb of node.verbs ?? []) {
    const vWords = words(verb.label);
    if (!vWords.length || qWords.length <= vWords.length) continue;
    const head = qWords.slice(0, vWords.length);
    if (head.join(' ') !== vWords.join(' ')) continue;
    const rest = qWords.slice(vWords.length).join(' ');
    if (title.includes(rest) || id.includes(rest) || words(node.title).join(' ').includes(rest)) {
      return { cls: 1, verbId: verb.id };
    }
  }
  if (title.includes(q) || id.includes(q)) return { cls: 2 };
  return { cls: -1 };
}

/**
 * Ranked hits for a query. Nodes with asks come first, then title/id prefix matches,
 * then verb phrases (which pre-arm the verb), then substrings; ties go to the shorter
 * title, then the id.
 */
export function search(data: UniverseData, query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const qWords = words(q);
  const scored: Array<{ hit: SearchHit; asks: number; cls: number; len: number; id: string }> = [];
  for (const node of data.nodes) {
    const m = matchClass(node, q, qWords);
    if (m.cls < 0) continue;
    scored.push({
      hit: m.verbId ? { id: node.id, verbId: m.verbId } : { id: node.id },
      asks: node.asks?.length ? 0 : 1,
      cls: m.cls,
      len: node.title.length,
      id: node.id,
    });
  }
  scored.sort((a, b) => a.asks - b.asks || a.cls - b.cls || a.len - b.len || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored.map((s) => s.hit);
}
