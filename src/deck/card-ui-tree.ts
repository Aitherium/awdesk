/**
 * The render tree main builds from a decision card's generated UI (A2UI v0.9
 * subset: Column/Row/Text/Button) -- electron/card-ui.cjs `buildTree`. Plain,
 * inert data: no HTML, no URL, no handler; a button carries only an option key.
 *
 * `checkCardUiTree` re-checks a tree that crossed the IPC boundary before the
 * Inbox draws it (the same rules as card-ui.cjs `checkTree`): any surprise and
 * the row draws the card exactly as it did before generated UI existed.
 */

export type CardUiNode =
  | { type: 'text'; text: string; variant?: string }
  | { type: 'button'; text: string; key: string; variant?: string }
  | { type: 'row'; justify?: string; children: CardUiNode[] }
  | { type: 'column'; align?: string; children: CardUiNode[] };

const MAX_NODES = 30;
const MAX_DEPTH = 8;

/** Number of answer buttons when `tree` is safe to draw for these keys, else -1. */
export function checkCardUiTree(tree: unknown, optionKeys: readonly string[]): number {
  let nodes = 0;
  let buttons = 0;
  const ok = (n: unknown, depth: number): boolean => {
    nodes += 1;
    if (!n || typeof n !== 'object' || Array.isArray(n) || depth > MAX_DEPTH || nodes > MAX_NODES) return false;
    const node = n as Record<string, unknown>;
    if (node.type === 'text') return typeof node.text === 'string';
    if (node.type === 'button') {
      buttons += 1;
      return typeof node.text === 'string' && typeof node.key === 'string' && optionKeys.includes(node.key);
    }
    if (node.type === 'row' || node.type === 'column') {
      return Array.isArray(node.children) && node.children.every((c) => ok(c, depth + 1));
    }
    return false;
  };
  return ok(tree, 0) ? buttons : -1;
}

/** The tree to draw for a card, or null (absent, stale, invalid, credential, no buttons). */
export function drawableCardUi(card: {
  kind?: string;
  uiTree?: unknown;
  options: ReadonlyArray<{ key: string }>;
}): CardUiNode | null {
  if (card.kind === 'credential' || !card.uiTree) return null;
  const keys = card.options.map((o) => o.key);
  return checkCardUiTree(card.uiTree, keys) > 0 ? (card.uiTree as CardUiNode) : null;
}
