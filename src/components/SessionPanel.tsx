import { Fragment, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import type { DeckDecision } from '../deck/deck-types';
import {
  DeckLinks,
  canOpenFile,
  forgetSessionContext,
  openSessionFile,
  loadSessionContext,
  peekSessionContext,
  runSessionAct,
  type SessionActResult,
  type SessionResult,
} from '../deck/session-context';
import {
  agoLabel,
  baseName,
  isLongText,
  isWebUrl,
  linkTokens,
  parseBlocks,
  parseInline,
  replyEffectLine,
  sessionStatusLine,
  type MdBlock,
} from '../deck/session-text';

/**
 * The Inbox SESSION PANEL (owner, 2026-11-08, looking at an expanded card:
 * "not enough info, no easy way to interact or dive deeper or engage with those
 * sessions"). A card raised by a coding session used to be one clipped blob of
 * "Needs: ... You asked: ... Claude last said: ..." and two buttons. This panel
 * says whether that session is still open, what it was asked, what it last
 * said, and gives a door to it: Go to it (live), Resume (ended), and a Reply box
 * that is always visible.
 *
 * Every piece of session / card text goes through LinkedText or Markdown, which
 * build React nodes from parsed tokens -- never HTML -- so transcript text can
 * not inject markup.
 */

/** Plain text with card ids, PR references and URLs turned into buttons. */
export function LinkedText({ text }: { text: string }) {
  const links = useContext(DeckLinks);
  const tokens = linkTokens(text, links.repo);
  return (
    <>
      {tokens.map((token, i) => {
        if (token.kind === 'text') return <Fragment key={i}>{token.text}</Fragment>;
        if (token.kind === 'card') {
          const focus = links.focusCard;
          if (!focus || (links.hasCard && !links.hasCard(token.id))) {
            return (
              <span key={i} className="deck-inline-id" title={`${token.id} is not waiting in the Inbox (answered or closed)`}>
                {token.text}
              </span>
            );
          }
          return (
            <button
              key={i}
              type="button"
              className="deck-inline-link deck-inline-card"
              title={`Show card ${token.id} in the Inbox`}
              onClick={(event) => {
                event.stopPropagation();
                focus(token.id);
              }}
            >
              {token.text}
            </button>
          );
        }
        const open = links.openUrl;
        if (!open) {
          return <span key={i} className="deck-inline-url" title={token.url}>{token.text}</span>;
        }
        return (
          <button
            key={i}
            type="button"
            className="deck-inline-link"
            title={`Open ${token.url} in Aither Browser`}
            onClick={(event) => {
              event.stopPropagation();
              open(token.url);
            }}
          >
            {token.text}
          </button>
        );
      })}
    </>
  );
}

function Inline({ text }: { text: string }) {
  const links = useContext(DeckLinks);
  return (
    <>
      {parseInline(text).map((node, i) => {
        if (node.type === 'code') return <code key={i} className="deck-md-code"><LinkedText text={node.text} /></code>;
        if (node.type === 'bold') return <strong key={i}><LinkedText text={node.text} /></strong>;
        if (node.type === 'link') {
          const open = links.openUrl;
          if (!open || !isWebUrl(node.url)) return <span key={i} title={node.url}>{node.text}</span>;
          return (
            <button
              key={i}
              type="button"
              className="deck-inline-link"
              title={`Open ${node.url} in Aither Browser`}
              onClick={(event) => {
                event.stopPropagation();
                open(node.url);
              }}
            >
              {node.text}
            </button>
          );
        }
        return <LinkedText key={i} text={node.text} />;
      })}
    </>
  );
}

function MdBlockView({ block }: { block: MdBlock }) {
  switch (block.type) {
    case 'h':
      return <p className="deck-md-h"><Inline text={block.text} /></p>;
    case 'pre':
      return <pre className="deck-md-pre"><LinkedText text={block.text} /></pre>;
    case 'list': {
      const items = block.items.map((item, i) => <li key={i}><Inline text={item} /></li>);
      return block.ordered ? <ol className="deck-md-list">{items}</ol> : <ul className="deck-md-list">{items}</ul>;
    }
    case 'table':
      return (
        <div className="deck-md-table-wrap">
          <table className="deck-md-table">
            <thead>
              <tr>{block.header.map((cell, i) => <th key={i}><Inline text={cell} /></th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>{row.map((cell, c) => <td key={c}><Inline text={cell} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return <p className="deck-md-p"><Inline text={block.text} /></p>;
  }
}

/** Light markdown: paragraphs, headings, lists, pipe tables, `code`, **bold**. */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={`deck-md ${className}`.trim()}>
      {blocks.map((block, i) => <MdBlockView key={i} block={block} />)}
    </div>
  );
}

/**
 * Folds long content to `lines` lines with a "Show all" toggle. `expandOnClick`
 * also opens it when the text itself is clicked (links inside stop the click).
 */
export function Clamp({
  lines,
  text,
  children,
  expandOnClick = false,
}: {
  lines: number;
  /** The raw text, to judge whether it is long enough to fold. */
  text: string;
  children: ReactNode;
  expandOnClick?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const long = isLongText(text, lines);
  const folded = long && !open;
  const style = { '--deck-clamp-lines': lines } as CSSProperties;
  return (
    <div className="deck-clamp-wrap">
      <div
        className={`deck-clamp${folded ? ' deck-clamp-folded' : ''}${folded && expandOnClick ? ' deck-clamp-clickable' : ''}`}
        style={style}
        title={folded && expandOnClick ? 'Click to read all of it' : undefined}
        onClick={folded && expandOnClick ? () => setOpen(true) : undefined}
      >
        {children}
      </div>
      {long ? (
        <button type="button" className="deck-clamp-toggle" onClick={() => setOpen((value) => !value)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      ) : null}
    </div>
  );
}

/** How long after a reply/resume the panel re-reads the session. */
const REFRESH_AFTER_ACT_MS = 2500;

/**
 * The session behind one card. Fetched when the row opens (30 s cache per card
 * in session-context.ts); every verb answers with main's own `note`.
 */
export function SessionPanel({ card, nowMs }: { card: DeckDecision; nowMs: number }) {
  const [result, setResult] = useState<SessionResult | null>(() => peekSessionContext(card.id));
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [acting, setActing] = useState<'focus' | 'resume' | null>(null);
  const [actNote, setActNote] = useState<SessionActResult | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [replyNote, setReplyNote] = useState<SessionActResult | null>(null);
  const alive = useRef(true);
  const refreshTimer = useRef<number | null>(null);
  const outerLinks = useContext(DeckLinks);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    };
  }, []);

  useEffect(() => {
    let current = true;
    const cached = peekSessionContext(card.id);
    if (cached) {
      setResult(cached);
      return undefined;
    }
    setLoading(true);
    void loadSessionContext(card.id).then((next) => {
      if (!current) return;
      setResult(next);
      setLoading(false);
    });
    return () => {
      current = false;
    };
  }, [card.id, reload]);

  const refreshSoon = () => {
    forgetSessionContext(card.id);
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      if (alive.current) setReload((n) => n + 1);
    }, REFRESH_AFTER_ACT_MS);
  };

  const ctx = result && result.ok ? result : null;
  // The fetched session is the truth; the card's own `session` (deck feed) fills
  // in while it loads or when the read failed.
  const live: boolean | null = ctx ? ctx.live !== null : card.session ? card.session.live : null;
  const name = ctx?.name || card.session?.name || '';
  const statusText = ctx
    ? sessionStatusLine(ctx.live, ctx.updatedAt, nowMs)
    : card.session
      ? sessionStatusLine(card.session.live ? { status: card.session.status } : null, 0, nowMs)
      : 'Session';
  const status = ctx?.live?.status ?? card.session?.status ?? '';
  const tone = live === null ? 'unknown' : !live ? 'ended' : status === 'busy' ? 'busy' : 'idle';

  const act = (action: 'focus' | 'resume') => {
    if (acting) return;
    setActing(action);
    setActNote(null);
    void runSessionAct(card.id, action).then((answer) => {
      if (!alive.current) return;
      setActing(null);
      setActNote(answer);
      if (answer.ok && action === 'resume') refreshSoon();
    });
  };

  const send = () => {
    const body = reply.trim();
    if (!body || sending) return;
    setSending(true);
    setReplyNote(null);
    void runSessionAct(card.id, 'reply', body).then((answer) => {
      if (!alive.current) return;
      setSending(false);
      setReplyNote(answer);
      if (answer.ok) {
        setReply('');
        refreshSoon();
      }
    });
  };

  const showThen = Boolean(ctx && ctx.lastAsk && ctx.lastAsk.trim() !== ctx.firstAsk.trim());

  return (
    <DeckLinks.Provider value={{ ...outerLinks, repo: ctx?.repo || outerLinks.repo }}>
      <section className="deck-session" aria-label="Session">
        <div className="deck-session-status">
          <span className={`deck-session-dot deck-session-dot-${tone}`} aria-hidden="true" />
          <span className="deck-session-state">{statusText}</span>
          {name ? <span className="deck-session-name" title={name}>{name}</span> : null}
          <span className="deck-session-go">
            {live === true ? (
              <button
                type="button"
                className="deck-btn deck-btn-xs deck-btn-primary"
                disabled={acting !== null}
                title="Bring this session's terminal tab to the front"
                onClick={() => act('focus')}
              >
                {acting === 'focus' ? 'Going…' : 'Go to it'}
              </button>
            ) : live === false ? (
              <button
                type="button"
                className="deck-btn deck-btn-xs deck-btn-primary"
                disabled={acting !== null}
                title="Reopen this ended session in a new terminal tab"
                onClick={() => act('resume')}
              >
                {acting === 'resume' ? 'Resuming…' : 'Resume'}
              </button>
            ) : null}
          </span>
        </div>
        {actNote ? (
          <p className={`deck-session-note${actNote.ok ? '' : ' deck-session-note-bad'}`} role="status">{actNote.note}</p>
        ) : null}
        {loading && !ctx ? <p className="deck-session-quiet">Reading the session…</p> : null}
        {result && !result.ok ? (
          <p className="deck-session-note deck-session-note-bad" role="status">
            {result.error}{' '}
            <button
              type="button"
              className="deck-clamp-toggle"
              onClick={() => {
                setResult(null);
                setReload((n) => n + 1);
              }}
            >
              Try again
            </button>
          </p>
        ) : null}

        {ctx ? (
          <>
            {ctx.firstAsk ? (
              <div className="deck-session-field">
                <span className="deck-session-label">Asked</span>
                <Clamp lines={2} text={ctx.firstAsk} expandOnClick>
                  <p className="deck-session-text"><LinkedText text={ctx.firstAsk} /></p>
                </Clamp>
              </div>
            ) : null}
            {showThen ? (
              <div className="deck-session-field">
                <span className="deck-session-label">Then</span>
                <Clamp lines={2} text={ctx.lastAsk} expandOnClick>
                  <p className="deck-session-text"><LinkedText text={ctx.lastAsk} /></p>
                </Clamp>
              </div>
            ) : null}
            {ctx.lastSaid ? (
              <div className="deck-session-field">
                <span className="deck-session-label">It said</span>
                <Clamp lines={8} text={ctx.lastSaid}>
                  <Markdown text={ctx.lastSaid} className="deck-session-said" />
                </Clamp>
              </div>
            ) : null}
            {ctx.turns.length > 0 ? (
              <details className="deck-fold deck-session-turns">
                <summary>Last {ctx.turns.length} turn{ctx.turns.length === 1 ? '' : 's'}</summary>
                {ctx.turns.map((turn, i) => (
                  <div className={`deck-session-turn deck-session-turn-${turn.role}`} key={i}>
                    <div className="deck-session-turn-head">
                      <span className="deck-session-turn-role">{turn.role === 'user' ? 'You' : 'Session'}</span>
                      {turn.at ? <time className="deck-session-turn-at">{agoLabel(turn.at, nowMs)}</time> : null}
                    </div>
                    <Clamp lines={4} text={turn.text}>
                      <Markdown text={turn.text} />
                    </Clamp>
                  </div>
                ))}
              </details>
            ) : null}
            {ctx.files.length > 0 ? (
              <div className="deck-session-field">
                <span className="deck-session-label">Edited</span>
                <div className="deck-session-files">
                  {ctx.files.map((file) => (
                    canOpenFile() ? (
                      <button
                        key={file}
                        type="button"
                        className="deck-chip deck-session-file"
                        title={`Show in Explorer: ${file}`}
                        onClick={() => void openSessionFile(card.id, file)}
                      >
                        {baseName(file)}
                      </button>
                    ) : (
                      <span key={file} className="deck-chip deck-session-file" title={file}>{baseName(file)}</span>
                    )
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        <div className="deck-session-reply">
          <textarea
            className="deck-session-reply-input"
            rows={2}
            placeholder="Tell this session what to do…"
            aria-label="Reply to this session"
            value={reply}
            disabled={sending}
            onChange={(event) => {
              setReply(event.target.value);
              if (replyNote) setReplyNote(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                send();
              }
            }}
          />
          <button
            type="button"
            className="deck-btn deck-btn-primary"
            disabled={sending || !reply.trim()}
            title="Send to this session (Ctrl+Enter)"
            onClick={send}
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
        <p className="deck-session-effect">{replyEffectLine(live)}</p>
        {replyNote ? (
          <p className={`deck-session-note${replyNote.ok ? '' : ' deck-session-note-bad'}`} role="status">{replyNote.note}</p>
        ) : null}
        {ctx && ctx.transcript ? (
          <p className="deck-session-meta">
            {ctx.sessionId ? <span>session {ctx.sessionId.slice(0, 8)} · </span> : null}
            <span className="deck-session-path" title={ctx.transcript}>{ctx.transcript}</span>
          </p>
        ) : null}
      </section>
    </DeckLinks.Provider>
  );
}
