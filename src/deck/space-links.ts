/**
 * The Inbox's doors into BeadSpace (aither://space/). The deck builds the link and
 * hands it to main (deck action "space"), which re-builds it from its parts
 * (electron/space-home.cjs canonicalSpaceLink) or refuses -- so this is the one
 * place the Inbox spells a Space address, and main is the one place that trusts it.
 */

/** The Space on the next thing that needs the owner (the Inbox header's "See in Space"). */
export const SPACE_NEXT_LINK = 'aither://space/?focus=next';

/** A decision card id: the SAME grammar the Space pane accepts (space-model.ts CARD_RE);
 *  awask ids are d-xxxx. Anything else gets no card link (the door falls back to next). */
const CARD_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** The Space on one card (a card row's "in space"), or null for an id main would refuse. */
export function spaceCardLink(cardId: string | null | undefined): string | null {
  const id = String(cardId ?? '');
  if (!CARD_ID.test(id)) return null;
  return `aither://space/?card=${id}`; // CARD_ID admits only query-safe characters
}
