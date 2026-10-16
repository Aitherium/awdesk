/**
 * The space's words for one planet: the hover card and the panel's context line.
 *
 * The engine's own card prints the raw node id, its status and "crew <owner>"; SpaceView
 * rewrites it with tooltipLines. The selection panel opens with contextLine: how it is
 * doing (always -- even with an ask on screen), where it sits, and what it touches.
 */
import { stateSentence } from '../vendor/bead-space/space/panel-text';
import { indexUniverse, parentOf, topAskOf } from '../vendor/bead-space/universe';
import type { UniverseData } from '../vendor/bead-space/types';
import type { BeadLevelData } from './bead-level';
import { baseTitle } from './bead-level';

export interface TooltipLines {
  title: string;
  body: string;
  foot: string;
  /** The foot is an ask: drawn in the ask gold. */
  ask: boolean;
}

export function tooltipLines(level: BeadLevelData | null, data: UniverseData | null, id: string): TooltipLines | null {
  const shown = level?.nodes.find((n) => n.id === id);
  const node = data ? indexUniverse(data).byId.get(id) : undefined;
  if (!level || !shown || !node) return null;
  const ask = topAskOf(node);
  const inside = shown.meta.asks - (node.asks?.length ?? 0);
  let foot: string;
  if (ask) foot = `Aither asks: ${ask.title}`;
  else if (inside > 0 && id !== level.focusId) {
    foot = `${inside} thing${inside === 1 ? '' : 's'} inside need${inside === 1 ? 's' : ''} you · click to open`;
  } else if (id !== level.focusId && shown.meta.children > 0) foot = `${shown.meta.children} inside · click to open`;
  else foot = 'Click for what you can do';
  return { title: shown.title, body: stateSentence(node), foot, ask: Boolean(ask) || (inside > 0 && id !== level.focusId) };
}

/** Relation words for the panel: "depends on", "hosts"... keyed by the U1 rel. */
const REL_WORD: Record<string, string> = {
  depends: 'depends on', hosts: 'hosts', serves: 'serves', traffic: 'talks to', routes: 'routes to',
};

/**
 * One line under the panel's name: "Healthy · Watch online · in Core · depends on
 * Secrets, Redis +2". Every part is read off the universe; none is invented.
 */
export function contextLine(data: UniverseData | null, id: string): string {
  if (!data) return '';
  const index = indexUniverse(data);
  const node = index.byId.get(id);
  if (!node) return '';
  const parts = [stateSentence(node)];
  const parentId = parentOf(data, id);
  const parent = parentId != null ? index.byId.get(parentId) : undefined;
  if (parent) parts.push(`in ${baseTitle(parent, data)}`);
  // Links into its own parts (a service hosting its moons) say nothing about its place.
  const inside = (other: string) => {
    for (let c: string | null = parentOf(data, other), n = 0; c != null && n < 64; c = parentOf(data, c), n += 1) {
      if (c === id) return true;
    }
    return false;
  };
  const out = data.links.filter((l) => l.source === id && l.target !== id && !inside(l.target));
  if (out.length) {
    const rel = out[0].rel;
    const same = out.filter((l) => l.rel === rel);
    const names = same.slice(0, 2).map((l) => {
      const t = index.byId.get(l.target);
      return t ? baseTitle(t, data) : l.target;
    });
    const more = same.length - names.length;
    parts.push(`${REL_WORD[rel] ?? 'linked to'} ${names.join(', ')}${more > 0 ? ` +${more}` : ''}`);
  } else {
    const inbound = data.links.filter((l) => l.target === id && l.source !== id).length;
    if (inbound) parts.push(`linked from ${inbound} other${inbound === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}
