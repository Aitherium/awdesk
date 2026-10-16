/** Where each open ask is, named from the level on screen (the asks bar's chips). Pure. */
import { allAsks } from '../vendor/bead-space/universe';
import type { UniverseData } from '../vendor/bead-space/types';
import { shownAncestor } from './bead-level';
import type { BeadLevelData } from './bead-level';

/** Chips drawn beside the pill; the rest are reached by clicking the pill. */
export const MAX_ASK_CHIPS = 3;

export interface AskTarget {
  nodeId: string;
  /** "Core › Pulse": the planet on screen that holds it, then the thing itself. */
  where: string;
  title: string;
}

export function askTargets(data: UniverseData, level: BeadLevelData | null): AskTarget[] {
  return allAsks(data).map(({ node, ask }) => {
    const holder = level ? shownAncestor(data, level, node.id) : null;
    const shown = holder ? level?.nodes.find((n) => n.id === holder)?.title : undefined;
    const own = level?.nodes.find((n) => n.id === node.id)?.title ?? node.title;
    const where = shown && holder !== node.id && holder !== level?.focusId ? `${shown} › ${own}` : own;
    return { nodeId: node.id, where, title: ask.title };
  });
}
