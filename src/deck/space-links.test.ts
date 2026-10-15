import { describe, expect, it } from 'vitest';
import { SPACE_NEXT_LINK, spaceCardLink } from './space-links';

describe('Inbox -> BeadSpace links', () => {
  it('the header "See in Space" opens the Space on the next ask', () => {
    expect(SPACE_NEXT_LINK).toBe('aither://space/?focus=next');
  });

  it('a card row links to that card', () => {
    expect(spaceCardLink('dc-2026-10-15-ab12')).toBe('aither://space/?card=dc-2026-10-15-ab12');
    expect(spaceCardLink('d-ab12')).toBe('aither://space/?card=d-ab12');
  });

  it('uses the Space pane grammar (space-model.ts CARD_RE): no dot, colon, or >80 chars', () => {
    expect(spaceCardLink('ask:proton.bridge_1')).toBeNull();
    expect(spaceCardLink('x'.repeat(80))).toBe(`aither://space/?card=${'x'.repeat(80)}`);
    expect(spaceCardLink('x'.repeat(81))).toBeNull();
  });

  it('an id main would refuse gets no link at all', () => {
    expect(spaceCardLink('')).toBeNull();
    expect(spaceCardLink(null)).toBeNull();
    expect(spaceCardLink('a b')).toBeNull();
    expect(spaceCardLink('x&focus=next')).toBeNull();
    expect(spaceCardLink('x'.repeat(161))).toBeNull();
  });
});
