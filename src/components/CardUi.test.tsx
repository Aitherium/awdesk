import { afterEach, describe, expect, it } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { DeckDecision } from '../deck/deck-types';
import { checkCardUiTree, drawableCardUi, type CardUiNode } from '../deck/card-ui-tree';
import { CardUi } from './CardUi';
import { DecisionRow } from './Deck';

/**
 * The Inbox draws a card's generated UI (the render tree main built from an
 * A2UI v0.9 surface, electron/card-ui.cjs) and falls back to its own buttons on
 * anything it cannot vouch for. Rendered without a DOM.
 */

const NOW = Date.parse('2026-11-08T12:00:00Z');
const LONG = 'Relaunch all sixteen runners under the org runner group, using the owner-tenant env';

const TREE: CardUiNode = {
  type: 'column',
  align: 'stretch',
  children: [
    { type: 'text', text: 'Relaunch the AWS runners?', variant: 'h3' },
    { type: 'row', justify: 'spaceBetween', children: [
      { type: 'text', text: 'ghosts', variant: 'caption' },
      { type: 'text', text: '16', variant: 'body' },
    ] },
    { type: 'button', text: LONG, key: 'relaunch', variant: 'primary' },
    { type: 'button', text: 'Hold', key: 'hold', variant: 'borderless' },
  ],
};

function card(overrides: Partial<DeckDecision> = {}): DeckDecision {
  return {
    id: 'd-ui1',
    title: 'Relaunch the AWS runners?',
    summary: '16 runners are ghosts.',
    kind: 'decision',
    urgency: 'normal',
    createdAt: NOW / 1000 - 600,
    options: [
      { key: 'relaunch', label: LONG, recommended: false },
      { key: 'hold', label: 'Hold', recommended: true },
    ],
    defaultKey: 'hold',
    tab: '',
    cwd: '',
    agent: '',
    uiTree: TREE,
    uiCurrent: true,
    ...overrides,
  };
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

/** Expand hook-free function components and collect every <button>'s props. */
function buttons(node: ReactNode): Array<{ children: unknown; onClick: () => void }> {
  const out: Array<{ children: unknown; onClick: () => void }> = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!isValidElement(n)) return;
    const el = n as ReactElement<Record<string, unknown>>;
    if (typeof el.type === 'function') {
      walk((el.type as (p: unknown) => ReactNode)(el.props));
      return;
    }
    if (el.type === 'button') out.push(el.props as { children: unknown; onClick: () => void });
    walk(el.props.children as ReactNode);
  };
  walk(node);
  return out;
}

describe('card UI tree guard', () => {
  it('accepts the subset and counts answer buttons', () => {
    expect(checkCardUiTree(TREE, ['relaunch', 'hold'])).toBe(2);
  });
  it('refuses an unknown node, a key the card lacks, or more than 30 nodes', () => {
    expect(checkCardUiTree({ type: 'html', text: '<b>x</b>' }, ['hold'])).toBe(-1);
    expect(checkCardUiTree(TREE, ['hold'])).toBe(-1);
    const wide: CardUiNode = { type: 'column', children: Array.from({ length: 31 }, () => ({ type: 'text', text: '.' })) };
    expect(checkCardUiTree(wide, [])).toBe(-1);
  });
  it('never draws on a credential card or without a button', () => {
    expect(drawableCardUi(card({ kind: 'credential' }))).toBeNull();
    expect(drawableCardUi(card({ uiTree: { type: 'column', children: [{ type: 'text', text: 'x' }] } }))).toBeNull();
    expect(drawableCardUi(card({ uiTree: null }))).toBeNull();
  });
});

describe('CardUi', () => {
  it('a button answers with its option key', () => {
    const answered: string[] = [];
    const found = buttons(CardUi({ tree: TREE, optionKeys: ['relaunch', 'hold'], onAnswer: (k) => answered.push(k) }));
    expect(found.map((b) => b.children)).toEqual([`1. ${LONG}`, '2. Hold']);
    found[0].onClick();
    found[1].onClick();
    expect(answered).toEqual(['relaunch', 'hold']);
  });

  it('renders text escaped, full labels, and skips text the row already shows', () => {
    const html = renderToStaticMarkup(
      <CardUi
        tree={{ type: 'column', children: [
          { type: 'text', text: 'Relaunch the AWS runners?', variant: 'h3' },
          { type: 'text', text: '<img src=x onerror=alert(1)>', variant: 'body' },
          { type: 'row', children: [{ type: 'text', text: 'last seen 11-07', variant: 'caption' }] },
          { type: 'button', text: LONG, key: 'relaunch', variant: 'primary' },
        ] }}
        shown={['Relaunch the AWS runners?', 'last seen 11-07']}
        optionKeys={['relaunch', 'hold']}
        onAnswer={() => {}}
      />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain(LONG);
    expect(html).toContain('deck-btn-primary');
    expect(html).not.toContain('Relaunch the AWS runners?</div>');
    expect(html).not.toContain('last seen 11-07');
  });
});

describe('DecisionRow with a generated UI', () => {
  it('draws the card UI in place of the stock buttons', () => {
    const html = renderToStaticMarkup(<DecisionRow card={card()} nowMs={NOW} onAnswer={() => {}} />);
    expect(html).toContain('data-testid="card-ui"');
    expect(html).toContain('card-ui-j-spaceBetween');
    expect(html).not.toContain('deck-card-actions');
  });

  it('falls back to the stock buttons when the tree is absent or names a key the card lacks', () => {
    for (const uiTree of [null, { ...TREE, children: [{ type: 'button', text: 'x', key: 'nope' }] } as CardUiNode]) {
      const html = renderToStaticMarkup(<DecisionRow card={card({ uiTree })} nowMs={NOW} onAnswer={() => {}} />);
      expect(html).not.toContain('data-testid="card-ui"');
      expect(html).toContain('deck-card-actions');
    }
  });
});
