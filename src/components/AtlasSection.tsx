import { useCallback, useEffect, useState } from 'react';

import { openDeskUrl } from '../deck/session-context';
import { atlasViewFromAnswer, type AtlasView } from '../deck/atlas-view';

/**
 * The Atlas section — the program-manager board (Genesis
 * `GET /atlas/issues/board`, platform-gated) on the Inbox, read through the one
 * gateway MCP door like every other desk data plane.
 *
 * Main serves `window.deskBridge.atlas.board()` -> `{ok:true, board}` or
 * `{ok:false, error}` (electron/atlas-client.cjs). An undeployed gateway tool
 * arrives as `{ok:false, error:"...unknown tool..."}`: the section renders that
 * as its own unavailable state, and the "Send digest now" button posts
 * `atlas_digest` through the same door.
 */

interface AtlasBridge {
  board?: () => Promise<unknown>;
  digest?: () => Promise<unknown>;
}

function atlasBridge(): AtlasBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { deskBridge?: { atlas?: AtlasBridge } }).deskBridge;
  return bridge?.atlas ?? null;
}

function reasonText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.slice(0, 300) || 'no answer';
}

function AtlasIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19V6a2 2 0 0 1 2-2h9l5 5v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="M14 4v6h6M8 13h8M8 17h5" />
    </svg>
  );
}

export function AtlasBoardView({
  view,
  busy,
  digestBusy,
  digestNote,
  onRefresh,
  onDigest,
  onOpen,
}: {
  view: AtlasView | null;
  busy: boolean;
  digestBusy: boolean;
  digestNote: string;
  onRefresh: () => void;
  onDigest: () => void;
  /** Opens a row link in Aither Browser (main's deck:deck-open-url). */
  onOpen?: (url: string) => void;
}) {
  const total = view?.ok ? view.counts.reduce((sum, entry) => sum + entry.count, 0) : 0;
  const updated = view?.ok
    ? view.updated
      ? `Board updated ${view.updated === 'just now' ? view.updated : `${view.updated} ago`}`
      : 'Board has no timestamp'
    : '';
  return (
    <section className="deck-section" aria-label="Atlas">
      <h2 className="deck-section-head">
        <span className="deck-section-icon"><AtlasIcon /></span>
        Atlas
        {view?.ok && total > 0 ? <span className="deck-section-count">{total}</span> : null}
        <button
          className="deck-chip deck-head-chip"
          title="Re-read the Atlas board"
          onClick={onRefresh}
          disabled={busy}
        >
          {busy ? '…' : 'Refresh'}
        </button>
      </h2>
      {view === null ? <p className="deck-empty">Reading the board…</p> : null}
      {view && !view.ok ? (
        <p className="deck-empty deck-atlas-error" title={view.error}>
          Atlas unavailable — {view.error}
        </p>
      ) : null}
      {view?.ok ? (
        <>
          {view.counts.length > 0 ? (
            <div className="deck-chips deck-atlas-counts">
              {view.counts.map((entry) => (
                <span className="deck-chip deck-atlas-count" key={entry.stage} title={`${entry.count} in ${entry.stage}`}>
                  <strong>{entry.count}</strong> {entry.stage}
                </span>
              ))}
            </div>
          ) : (
            <p className="deck-empty">No stage counts on the board.</p>
          )}
          {view.rows.length === 0 ? (
            <p className="deck-empty">No Atlas work on the board.</p>
          ) : (
            view.rows.map((row) => (
              <div className="deck-row deck-row-static deck-atlas-row" key={row.key}>
                <span className="deck-row-label" title={[row.title, row.detail].filter(Boolean).join(' — ') || undefined}>
                  {row.number ? <span className="deck-atlas-number">{row.number}</span> : null}
                  {row.number && row.title ? ' ' : ''}
                  {row.title}
                  {row.stage ? <span className="deck-card-age deck-atlas-stage"> · {row.stage}</span> : null}
                </span>
                {row.age ? <span className="deck-card-age deck-atlas-age" title={row.ageTitle}>{row.age}</span> : null}
                {row.prUrl ? (
                  <a
                    className="deck-atlas-link"
                    href={row.prUrl}
                    title={`Open the pull request ${row.prLabel}`}
                    onClick={(event) => {
                      if (!onOpen) return;
                      event.preventDefault();
                      onOpen(row.prUrl);
                    }}
                  >
                    PR {row.prLabel}
                  </a>
                ) : null}
                {row.threadUrl ? (
                  <a
                    className="deck-atlas-link"
                    href={row.threadUrl}
                    title="Open the thread"
                    onClick={(event) => {
                      if (!onOpen) return;
                      event.preventDefault();
                      onOpen(row.threadUrl);
                    }}
                  >
                    thread
                  </a>
                ) : null}
              </div>
            ))
          )}
          {view.text ? (
            <details className="deck-fold">
              <summary>Last digest</summary>
              <p className="deck-atlas-digest-text">{view.text}</p>
            </details>
          ) : null}
          <p className="deck-empty deck-atlas-updated" title={view.updatedTitle || undefined}>
            {updated}
          </p>
          <div className="deck-atlas-digest">
            <button
              className="deck-chip"
              title="Send the Atlas digest to the owner now"
              onClick={onDigest}
              disabled={digestBusy}
            >
              {digestBusy ? 'Sending…' : 'Send digest now'}
            </button>
            {digestNote ? <span className="deck-card-age deck-atlas-note">{digestNote}</span> : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

export function AtlasSection() {
  const [view, setView] = useState<AtlasView | null>(null);
  const [busy, setBusy] = useState(false);
  const [digestBusy, setDigestBusy] = useState(false);
  const [digestNote, setDigestNote] = useState('');

  const load = useCallback(() => {
    const api = atlasBridge();
    if (typeof api?.board !== 'function') {
      setView({ ok: false, error: 'This Aither build cannot read Atlas yet.' });
      return;
    }
    setBusy(true);
    void Promise.resolve()
      .then(() => api.board!())
      .then((raw) => setView(atlasViewFromAnswer(raw)))
      .catch((error: unknown) => setView({ ok: false, error: reasonText(error) }))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const sendDigest = useCallback(() => {
    const api = atlasBridge();
    if (typeof api?.digest !== 'function') {
      setDigestNote('this build cannot send digests yet');
      return;
    }
    setDigestBusy(true);
    setDigestNote('sending…');
    void Promise.resolve()
      .then(() => api.digest!())
      .then((raw) => {
        const answer = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        if (answer.ok === false) {
          setDigestNote(String(answer.error ?? answer.reason ?? 'the digest did not send').slice(0, 300));
          return;
        }
        const result = (answer.result && typeof answer.result === 'object')
          ? (answer.result as Record<string, unknown>)
          : {};
        const messageId = typeof result.message_id === 'string' ? result.message_id : '';
        setDigestNote(messageId ? `digest sent (${messageId})` : 'digest sent');
        // The board keeps the digest it just sent; re-read so updated_at moves.
        load();
      })
      .catch((error: unknown) => setDigestNote(reasonText(error)))
      .finally(() => setDigestBusy(false));
  }, [load]);

  const openLink = useCallback((url: string) => {
    void openDeskUrl(url);
  }, []);

  return (
    <AtlasBoardView
      view={view}
      busy={busy}
      digestBusy={digestBusy}
      digestNote={digestNote}
      onRefresh={load}
      onDigest={sendDigest}
      onOpen={openLink}
    />
  );
}
