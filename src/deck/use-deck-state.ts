/**
 * The deck-state subscription, ONE copy: the Inbox (Deck.tsx) and the Space pane
 * (space/SpaceView.tsx) both render main's `deckState()` feed. A pull on mount
 * (deck.getState) plus every 'deck-state' push (desk:event). Moved out of Deck.tsx
 * unchanged so the two panes cannot drift or double-normalise.
 */
import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { EMPTY_DECK_STATE, normalizeWakes, type DeckDecision, type DeckState } from './deck-types';

interface DeckStateBridge {
  deck?: { getState?: () => Promise<DeckState> };
  subscribe?: (listener: (event: Record<string, unknown>) => void) => () => void;
}

function bridge(): DeckStateBridge | null {
  if (typeof window === 'undefined') return null;
  return (window.deskBridge as unknown as DeckStateBridge | undefined) ?? null;
}

/** One 'deck-state' push as DeckState. A field missing from THIS copy is dropped on the
 *  first push after the initial pull -- the section would render once and then empty. */
export function deckStateFromEvent(event: Record<string, unknown>): DeckState {
  return {
    decisions: (event.decisions as DeckDecision[]) ?? [],
    openCount: (event.openCount as number) ?? 0,
    totalCount: event.totalCount as number | undefined,
    needsYouIds: (event.needsYouIds as string[] | undefined) ?? [],
    fyiIds: (event.fyiIds as string[] | undefined) ?? [],
    deskVisible: (event.deskVisible as boolean) ?? false,
    slots: (event.slots as DeckState['slots']) ?? [],
    agents: (event.agents as string[]) ?? [],
    characters: (event.characters as string[]) ?? [],
    characterModels: (event.characterModels as Record<string, string>) ?? {},
    activeCharacter: (event.activeCharacter as string) ?? '',
    agentCharacters: (event.agentCharacters as Record<string, string>) ?? {},
    relay: (event.relay as DeckState['relay']) ?? [],
    relayChannel: (event.relayChannel as string) ?? '#agents',
    room: (event.room as DeckState['room']) ?? [],
    roomStatus: (event.roomStatus as string) ?? 'not started',
    spaceAvailable: (event.spaceAvailable as boolean | undefined) ?? false,
    wakes: normalizeWakes(event.wakes),
  };
}

/** main's deck feed, live. The setter is returned for optimistic edits (an answered card). */
export function useDeckState(): [DeckState, Dispatch<SetStateAction<DeckState>>] {
  const [state, setState] = useState<DeckState>(EMPTY_DECK_STATE);
  useEffect(() => {
    const b = bridge();
    // No deck bridge (an older preload): render the empty state, as the Inbox always has.
    if (!b?.deck) return;
    let alive = true;
    const getState = b.deck.getState;
    if (typeof getState === 'function') {
      void Promise.resolve()
        .then(() => getState())
        .then((next) => {
          // Same normalisation as the push path -- the initial PULL carries main's raw
          // feed too, and skipping it made the section render once with undefined fields.
          if (alive && next) setState({ ...next, wakes: normalizeWakes(next.wakes) });
        })
        .catch(() => { /* no handler yet: the first push fills it */ });
    }
    let unsubscribe: () => void = () => {};
    try {
      unsubscribe = b.subscribe?.((event) => {
        if (event && event.type === 'deck-state') setState(deckStateFromEvent(event));
      }) ?? (() => {});
    } catch {
      unsubscribe = () => {};
    }
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return [state, setState];
}
