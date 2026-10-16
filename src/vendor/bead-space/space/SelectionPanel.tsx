// GENERATED from @aitherium/bead-space 0.2.0 by vendor_bead_space.py -- edit the package and re-run.
/**
 * What you see when you click a thing: who it is, the one question it has for you, what
 * you can do to it, and "Explore with Aither". At most five blocks, never a list.
 *
 * The package executes nothing: every action is a host callback that returns a promise.
 * A credential is read from an UNCONTROLLED input (a ref, never React state), handed to
 * the host once, and the field is cleared in the same tick.
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import type { BeadAsk, BeadVerb, UniverseNode } from '../types';
import { topAskOf, verbsFor } from '../universe/verbs';
import { FONTS, PALETTE } from './palette';
import { CONFIRM_WINDOW_MS, stateSentence } from './panel-text';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface VerbResult extends ActionResult {
  /** The host accepted it and is still working. */
  pending?: boolean;
}

export interface ExploreResult extends ActionResult {
  text?: string;
}

export interface SpaceActions {
  onVerb?: (node: UniverseNode, verb: BeadVerb, opts: { confirmed: boolean }) => Promise<VerbResult>;
  onAnswer?: (cardId: string, key: string) => Promise<ActionResult>;
  /** Store a credential. The value is passed once; the panel keeps no copy. */
  onCredential?: (cardId: string, value: string) => Promise<ActionResult>;
  onExplore?: (node: UniverseNode, prompt: string) => Promise<ExploreResult>;
  onOpenChat?: (node: UniverseNode) => void;
}

export interface SelectionPanelProps extends SpaceActions {
  node: UniverseNode;
  /** A verb a search phrase named: it takes the primary slot. */
  preArmVerbId?: string | null;
  /** Fired with the node id while an explore is in flight, then null. */
  onExploring?: (id: string | null) => void;
  /**
   * A host-written line under the name (how it is doing, where it sits, what it
   * touches). Replaces the bare state sentence and is shown even with an ask open.
   */
  context?: string;
  className?: string;
  style?: CSSProperties;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'pending'; note?: string }
  | { kind: 'ok'; note: string }
  | { kind: 'error'; note: string };

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'failed';
}

const S = {
  panel: {
    width: 340,
    boxSizing: 'border-box',
    background: `${PALETTE.surface}F2`,
    border: `1px solid ${PALETTE.hairline}`,
    borderRadius: 14,
    padding: '14px 16px',
    color: PALETTE.ink,
    fontFamily: FONTS.name,
    fontWeight: FONTS.nameWeight,
    fontSize: 13,
    lineHeight: 1.45,
    boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
    pointerEvents: 'auto',
  } as CSSProperties,
  block: { marginTop: 12 } as CSSProperties,
  name: { fontSize: 18, letterSpacing: 0.2, margin: 0, fontWeight: FONTS.nameWeight } as CSSProperties,
  metric: { fontFamily: FONTS.metric, fontSize: 11, color: PALETTE.quiet, marginTop: 2 } as CSSProperties,
  big: (color: string): CSSProperties => ({
    display: 'block',
    width: '100%',
    padding: '10px 12px',
    marginTop: 8,
    border: 'none',
    borderRadius: 10,
    background: color,
    color: PALETTE.void,
    fontFamily: FONTS.name,
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
  }),
  /** Every secondary action: one look, one row. A ghost outline read as a heading. */
  ghost: (color: string): CSSProperties => ({
    padding: '7px 12px',
    marginTop: 8,
    marginRight: 6,
    border: `1px solid ${color === PALETTE.ink || color === PALETTE.quiet ? '#2B3D50' : `${color}99`}`,
    borderRadius: 8,
    background: PALETTE.raised,
    color: color === PALETTE.quiet ? PALETTE.ink : color,
    fontFamily: FONTS.name,
    fontSize: 13,
    cursor: 'pointer',
  }),
  note: (color: string): CSSProperties => ({ marginTop: 6, fontSize: 12, color }),
};

function StatusLine({ status }: { status: Status }) {
  if (status.kind === 'idle') return null;
  if (status.kind === 'pending') {
    return <div style={S.note(PALETTE.quiet)}>{status.note ?? 'working…'}</div>;
  }
  if (status.kind === 'ok') {
    return <div style={S.note(PALETTE.healthy)}>✓ {status.note}</div>;
  }
  return <div role="alert" style={S.note(PALETTE.danger)}>{status.note}</div>;
}

function AskBlock({ ask, onAnswer, onCredential, children }: {
  ask: BeadAsk;
  onAnswer?: SpaceActions['onAnswer'];
  onCredential?: SpaceActions['onCredential'];
  /** The node's own verbs, demoted: they share the ask's one row of secondary chips. */
  children?: ReactNode;
}) {
  const secretRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [more, setMore] = useState(false);
  const busy = status.kind === 'pending';

  const options = ask.options ?? [];
  const recommended = options.find((o) => o.recommended) ?? options[0] ?? null;
  const rest = options.filter((o) => o !== recommended);
  const chips = rest.slice(0, 2);
  const hidden = rest.slice(2);

  const answer = async (key: string) => {
    if (!onAnswer || busy) return;
    setStatus({ kind: 'pending', note: 'sending…' });
    try {
      const result = await onAnswer(ask.cardId, key);
      if (result && result.ok === true) setStatus({ kind: 'ok', note: 'answered' });
      else setStatus({ kind: 'error', note: result?.error || 'not answered' });
    } catch (err) {
      setStatus({ kind: 'error', note: errorText(err) });
    }
  };

  const store = async () => {
    const field = secretRef.current;
    if (!onCredential || !field || busy) return;
    const value = field.value;
    if (!value) {
      setStatus({ kind: 'error', note: 'Type the value first.' });
      return;
    }
    setStatus({ kind: 'pending', note: 'storing…' });
    const call = onCredential(ask.cardId, value);
    field.value = '';
    try {
      const result = await call;
      // Only an explicit {ok:true} is success: a vault write that could not close the
      // card is NOT done, and saying so in green is how a silent failure happens.
      if (result && result.ok === true) setStatus({ kind: 'ok', note: 'stored · card closed' });
      else setStatus({ kind: 'error', note: result?.error || 'not stored' });
    } catch (err) {
      setStatus({ kind: 'error', note: errorText(err) });
    }
  };

  const color = PALETTE.gold;
  return (
    <div style={S.block} data-block="ask">
      <div style={{ color, fontSize: 15, fontWeight: 500, lineHeight: 1.35 }} data-ask-title>{ask.title}</div>
      {ask.credential ? (
        <>
          <input
            ref={secretRef}
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={ask.secretName ? `Value for ${ask.secretName}` : 'Secret value'}
            placeholder={ask.secretName || 'secret value'}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') void store();
            }}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              marginTop: 8,
              padding: '8px 10px',
              borderRadius: 8,
              border: `1px solid ${PALETTE.hairline}`,
              background: PALETTE.raised,
              color: PALETTE.ink,
              fontFamily: FONTS.metric,
              fontSize: 12,
            }}
          />
          <button type="button" disabled={busy} style={S.big(color)} onClick={() => void store()}>
            Store in vault
          </button>
          {children ? <div>{children}</div> : null}
        </>
      ) : (
        <>
          {recommended ? (
            <button
              type="button"
              disabled={busy}
              style={S.big(color)}
              onClick={() => void answer(recommended.key)}
            >
              {recommended.label}
            </button>
          ) : null}
          <div>
            {chips.map((o) => (
              <button key={o.key} type="button" disabled={busy} style={S.ghost(PALETTE.quiet)} onClick={() => void answer(o.key)}>
                {o.label}
              </button>
            ))}
            {hidden.length && !more ? (
              <button type="button" style={S.ghost(PALETTE.quiet)} onClick={() => setMore(true)}>
                other…
              </button>
            ) : null}
            {more
              ? hidden.map((o) => (
                <button key={o.key} type="button" disabled={busy} style={S.ghost(PALETTE.quiet)} onClick={() => void answer(o.key)}>
                  {o.label}
                </button>
              ))
              : null}
            {children}
          </div>
        </>
      )}
      <StatusLine status={status} />
    </div>
  );
}

function VerbBlock({ node, preArmVerbId, onVerb, demote = false }: {
  node: UniverseNode;
  preArmVerbId?: string | null;
  onVerb?: SpaceActions['onVerb'];
  /** An ask holds the one big button; the verbs become secondary chips. */
  demote?: boolean;
}) {
  const { primary, secondary } = verbsFor(node, preArmVerbId);
  const [armed, setArmed] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  if (!primary || !onVerb) return null;

  const run = async (verb: BeadVerb) => {
    if (status.kind === 'pending') return;
    const confirmed = verb.danger === 'confirm';
    if (confirmed && armed !== verb.id) {
      setArmed(verb.id);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setArmed(null), CONFIRM_WINDOW_MS);
      return;
    }
    setArmed(null);
    if (timer.current) clearTimeout(timer.current);
    setStatus({ kind: 'pending' });
    try {
      const result = await onVerb(node, verb, { confirmed });
      if (result && result.ok === true) {
        setStatus(result.pending ? { kind: 'pending', note: `${verb.label}: under way` } : { kind: 'ok', note: `${verb.label}: done` });
      } else {
        setStatus({ kind: 'error', note: result?.error || `${verb.label} failed` });
      }
    } catch (err) {
      setStatus({ kind: 'error', note: errorText(err) });
    }
  };

  const labelOf = (verb: BeadVerb) => (armed === verb.id ? `Click again to ${verb.label.toLowerCase()}` : verb.label);
  const tint = (verb: BeadVerb) => (verb.danger === 'confirm' ? PALETTE.danger : PALETTE.ink);

  if (demote) {
    // display:contents -- the chips flow on in the ask's row (AskBlock children).
    return (
      <div style={{ display: 'contents' }} data-block="verbs">
        {[primary, ...secondary].map((verb) => (
          <button
            key={verb.id}
            type="button"
            style={S.ghost(tint(verb))}
            data-armed={armed === verb.id ? 'true' : undefined}
            onClick={() => void run(verb)}
          >
            {labelOf(verb)}
          </button>
        ))}
        <StatusLine status={status} />
      </div>
    );
  }

  return (
    <div style={S.block} data-block="verbs">
      <button
        type="button"
        style={{
          ...S.big(primary.danger === 'confirm' ? PALETTE.danger : PALETTE.raised),
          color: primary.danger === 'confirm' ? PALETTE.void : PALETTE.ink,
          border: `1px solid ${primary.danger === 'confirm' ? PALETTE.danger : PALETTE.hairline}`,
        }}
        data-armed={armed === primary.id ? 'true' : undefined}
        onClick={() => void run(primary)}
      >
        {labelOf(primary)}
      </button>
      <div>
        {secondary.map((verb) => (
          <button
            key={verb.id}
            type="button"
            style={S.ghost(tint(verb))}
            data-armed={armed === verb.id ? 'true' : undefined}
            onClick={() => void run(verb)}
          >
            {labelOf(verb)}
          </button>
        ))}
      </div>
      <StatusLine status={status} />
    </div>
  );
}

function ExploreBlock({ node, onExplore, onOpenChat, onExploring }: {
  node: UniverseNode;
  onExplore?: SpaceActions['onExplore'];
  onOpenChat?: SpaceActions['onOpenChat'];
  onExploring?: (id: string | null) => void;
}) {
  const { explore } = verbsFor(node);
  const [pending, setPending] = useState(false);
  const [reply, setReply] = useState<{ ok: boolean; text: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  if (!onExplore && !onOpenChat) return null;

  const go = async () => {
    if (!onExplore || pending) return;
    setPending(true);
    setReply(null);
    onExploring?.(node.id);
    try {
      const result = await onExplore(node, explore.prompt);
      if (!alive.current) return;
      if (result && result.ok === true) setReply({ ok: true, text: result.text || '' });
      else setReply({ ok: false, text: result?.error || 'Aither did not answer.' });
    } catch (err) {
      if (alive.current) setReply({ ok: false, text: errorText(err) });
    } finally {
      onExploring?.(null);
      if (alive.current) setPending(false);
    }
  };

  return (
    <div style={S.block} data-block="explore">
      {onExplore ? (
        <button
          type="button"
          style={{ ...S.ghost(PALETTE.aitherium), marginRight: 0 }}
          disabled={pending}
          onClick={() => void go()}
        >
          {pending ? 'Aither is looking…' : 'Explore with Aither'}
        </button>
      ) : null}
      {reply ? (
        <div
          style={{
            marginTop: 8,
            padding: '8px 10px',
            borderLeft: `2px solid ${reply.ok ? PALETTE.aitherium : PALETTE.danger}`,
            background: PALETTE.raised,
            color: reply.ok ? PALETTE.ink : PALETTE.danger,
            whiteSpace: 'pre-wrap',
            maxHeight: 180,
            overflowY: 'auto',
            fontSize: 12,
          }}
        >
          {reply.text}
        </div>
      ) : null}
      {onOpenChat ? (
        <div style={{ marginTop: 6 }}>
          <a
            href="#"
            style={{ color: PALETTE.aitherium, fontSize: 12, textDecoration: 'none' }}
            onClick={(e) => {
              e.preventDefault();
              onOpenChat(node);
            }}
          >
            Open full chat
          </a>
        </div>
      ) : null}
    </div>
  );
}

export function SelectionPanel(props: SelectionPanelProps) {
  const { node, className, style } = props;
  const ask = topAskOf(node);
  const metric = typeof node.meta?.metric === 'string' || typeof node.meta?.metric === 'number'
    ? String(node.meta.metric)
    : '';
  const impact = typeof node.meta?.impact === 'string' ? node.meta.impact : '';
  // With an ask on screen, "Healthy" next to "restart it?" contradicts it: say only
  // what is wrong, and let the ask be the headline.
  const healthy = node.health == null || node.health.state === 'ok' || node.health.state === 'unknown';
  const showState = !ask || !healthy;
  return (
    <div
      className={className}
      style={{ ...S.panel, ...style }}
      data-node={node.id}
      onKeyDown={(e) => {
        // Keys typed into the panel belong to the panel, not the space's shortcuts.
        if (e.key !== 'Escape') e.stopPropagation();
      }}
    >
      <div data-block="name">
        <h3 style={S.name}>{node.title}</h3>
        {metric ? <div style={S.metric}>{metric}</div> : null}
        {props.context ? (
          <div style={{ marginTop: 4, color: '#9AA6B2', fontSize: 13 }} data-state data-context>{props.context}</div>
        ) : showState ? <div style={{ marginTop: 4, color: '#9AA6B2' }} data-state>{stateSentence(node)}</div> : null}
      </div>
      {ask ? (
        <AskBlock key={ask.cardId} ask={ask} onAnswer={props.onAnswer} onCredential={props.onCredential}>
          <VerbBlock node={node} preArmVerbId={props.preArmVerbId} onVerb={props.onVerb} demote />
        </AskBlock>
      ) : (
        <VerbBlock node={node} preArmVerbId={props.preArmVerbId} onVerb={props.onVerb} />
      )}
      <ExploreBlock node={node} onExplore={props.onExplore} onOpenChat={props.onOpenChat} onExploring={props.onExploring} />
      {impact ? <div style={{ ...S.block, color: PALETTE.quiet, fontSize: 12 }} data-block="impact">{impact}</div> : null}
    </div>
  );
}
