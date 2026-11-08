import type { CardUiNode } from '../deck/card-ui-tree';
import './CardUi.css';

/**
 * Draws a decision card's generated UI (the render tree from electron/card-ui.cjs,
 * already re-checked by `drawableCardUi`). Text is React text (escaped), there is
 * no link or HTML anywhere, and a Button can only call `onAnswer(key)` -- the
 * key main validates against the card's options on the way to the store.
 * Buttons are full width and wrap: a long label is never cut off.
 */
const TEXT_VARIANTS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'body', 'caption']);
const ALIGNS = new Set(['start', 'center', 'end', 'stretch']);
const JUSTIFIES = new Set(['start', 'center', 'end', 'spaceBetween']);

function UiNode({ node, onAnswer, numberOf }: {
  node: CardUiNode;
  onAnswer: (key: string) => void;
  numberOf: (key: string) => number;
}) {
  if (node.type === 'text') {
    const variant = node.variant && TEXT_VARIANTS.has(node.variant) ? node.variant : 'body';
    return <div className={`card-ui-text card-ui-${variant}`}>{node.text}</div>;
  }
  if (node.type === 'button') {
    const n = numberOf(node.key);
    return (
      <button
        type="button"
        className={`deck-btn card-ui-btn${node.variant === 'primary' ? ' deck-btn-primary' : ''}`}
        title={`Answer "${node.text}" — recorded, and the asking session is told right away`}
        onClick={() => onAnswer(node.key)}
      >
        {n > 0 ? `${n}. ${node.text}` : node.text}
      </button>
    );
  }
  // Index keys: the tree is static per render and carries no ids.
  const children = node.children.map((child, i) => (
    <UiNode key={i} node={child} onAnswer={onAnswer} numberOf={numberOf} />
  ));
  if (node.type === 'row') {
    const justify = node.justify && JUSTIFIES.has(node.justify) ? node.justify : 'start';
    return <div className={`card-ui-row card-ui-j-${justify}`}>{children}</div>;
  }
  const align = node.align && ALIGNS.has(node.align) ? node.align : 'stretch';
  return <div className={`card-ui-col card-ui-a-${align}`}>{children}</div>;
}

/**
 * `shown`: what the row already prints (its title, summary, facts). A top-level
 * Text -- or a Row of only such Texts -- that repeats one is not drawn twice.
 */
export function CardUi({ tree, optionKeys, onAnswer, shown = [] }: {
  tree: CardUiNode;
  optionKeys: readonly string[];
  onAnswer: (key: string) => void;
  shown?: readonly string[];
}) {
  const numberOf = (key: string) => optionKeys.indexOf(key) + 1;
  const seen = new Set(shown.map((t) => t.trim()).filter(Boolean));
  const repeats = (n: CardUiNode): boolean =>
    n.type === 'text' ? seen.has(n.text.trim())
      : n.type === 'row' ? n.children.length > 0 && n.children.every(repeats)
        : false;
  const visible: CardUiNode = tree.type === 'column' && seen.size
    ? { ...tree, children: tree.children.filter((c) => !repeats(c)) }
    : tree;
  return (
    <div className="card-ui" data-testid="card-ui">
      <UiNode node={visible} onAnswer={onAnswer} numberOf={numberOf} />
    </div>
  );
}
