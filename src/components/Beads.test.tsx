import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { hintClosesOn } from '../hooks/clickThrough';
import { Beads } from './Beads';

/**
 * The gestures help ("Left-drag a body to move it ... Esc cancels a drag. Stages: ...").
 * Owner screenshot 2026-11-16: it stayed open while the Inbox opened on top of it, its text
 * running under the Inbox and cut mid-word ("put th...", "handle a..."). One popover at a
 * time: it closes on Esc, on a press anywhere else, and when the window loses focus; it
 * fits the window or scrolls. Rendered without a DOM.
 */

const g = globalThis as unknown as { window?: unknown };
afterEach(() => { delete g.window; });

function withStorage(dismissed: boolean) {
  g.window = { localStorage: { getItem: () => (dismissed ? '1' : null), setItem() {}, removeItem() {} } };
}

describe('the gestures help is a popover: one at a time', () => {
  it('closes on Esc, on a press outside it (a bead, a body), and when the window loses focus', () => {
    expect(hintClosesOn({ type: 'keydown', key: 'Escape' })).toBe(true);
    expect(hintClosesOn({ type: 'keydown', key: 'a' })).toBe(false);
    expect(hintClosesOn({ type: 'pointerdown', insideHint: false })).toBe(true); // the Inbox bead, a body
    expect(hintClosesOn({ type: 'pointerdown', insideHint: true })).toBe(false); // reading or scrolling it
    expect(hintClosesOn({ type: 'pointerdown', onToggle: true })).toBe(false); // "?" toggles it instead
    expect(hintClosesOn({ type: 'blur' })).toBe(true); // the Inbox, or any app, took the focus
    expect(hintClosesOn({ type: 'focus' })).toBe(false);
  });

  it('renders open on first run, labelled, with the "?" bead saying so', () => {
    withStorage(false);
    const html = renderToStaticMarkup(<Beads />);
    expect(html).toContain('class="bead-hint"');
    expect(html).toContain('aria-label="Gestures help"');
    expect(html).toMatch(/aria-expanded="true"[^>]*data-hint-toggle=""/);
  });

  it('once dismissed it is gone, and "?" says it is closed', () => {
    withStorage(true);
    const html = renderToStaticMarkup(<Beads />);
    expect(html).not.toContain('bead-hint');
    expect(html).toMatch(/aria-expanded="false"/);
  });
  // Fitting the window (the column's max-height, the help's scroll) is pinned on the CSS side
  // by electron/avatar-dock.test.cjs, which reads src/styles.css.
});
