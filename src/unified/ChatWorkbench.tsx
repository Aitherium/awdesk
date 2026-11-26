import React, { useMemo, useState } from 'react';
import { MarkdownBody } from './MarkdownBody';
import type { BrowserTab, Conversation, DecisionCard, MorphMode } from './types';

interface ChatWorkbenchProps {
  conversation: Conversation | null;
  decisions: DecisionCard[];
  models?: string[];
  openTabs?: BrowserTab[];
  sending: boolean;
  showBrowser: boolean;
  onSend: (text: string, model: string) => void;
  onAnswerDecision: (id: string, optionKey: string) => void;
  onDismissDecision: (id: string) => void;
  onSubmitCredential?: (id: string, secretValue: string) => Promise<{ ok: boolean; error?: string } | undefined>;
  onOpenUrlInBrowser: (url: string) => void;
  onToggleBrowser: () => void;
  onMorph?: (mode: MorphMode) => void;
  onToggleSplit?: () => void;
  onToggleRenderer?: () => void;
  onNewConversation?: () => void;
}

const DEFAULT_MODELS = [
  'aither-orchestrator',
  'deepseek-v4-flash-pool',
  'bonsai-27b-local',
];

const SLASH_COMMANDS = [
  { cmd: '/avatar', desc: 'Shrink into floating Avatar + Circular Rail (Alt+1)' },
  { cmd: '/workbench', desc: '3-pane Antigravity Workbench (Alt+2)' },
  { cmd: '/desktop', desc: 'Blow up to AitherOS Living Desktop (Alt+3)' },
  { cmd: '/split', desc: 'Toggle 2-pane side-by-side browser split' },
  { cmd: '/vrm', desc: 'Toggle 3D VRM Avatar / 0% GPU Fairy Orb' },
  { cmd: '/new', desc: 'Start a fresh conversation' },
  { cmd: '/open https://aithr.net', desc: 'Open aithr.net in the right browser pane' },
];

const AGENTS = ['@atlas', '@demiurge', '@lyra', '@iris', '@hera', '@vera'];

export const ChatWorkbench: React.FC<ChatWorkbenchProps> = ({
  conversation,
  decisions,
  models = DEFAULT_MODELS,
  openTabs = [],
  sending,
  showBrowser,
  onSend,
  onAnswerDecision,
  onDismissDecision,
  onSubmitCredential,
  onOpenUrlInBrowser,
  onToggleBrowser,
  onMorph,
  onToggleSplit,
  onToggleRenderer,
  onNewConversation,
}) => {
  const modelList = models.length > 0 ? models : DEFAULT_MODELS;
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState(conversation?.model || modelList[0]);
  const [credDrafts, setCredDrafts] = useState<Record<string, string>>({});
  const [credNote, setCredNote] = useState<Record<string, string>>({});

  const activePopup = useMemo(() => {
    const trimmed = draft.trimStart();
    if (trimmed.startsWith('/')) {
      const q = trimmed.toLowerCase();
      const hits = SLASH_COMMANDS.filter((c) => c.cmd.toLowerCase().includes(q));
      return hits.length > 0 ? { kind: 'slash' as const, items: hits } : null;
    }
    const atMatch = /(?:^|\s)@([a-z0-9._-]*)$/i.exec(draft);
    if (atMatch) {
      const q = atMatch[1].toLowerCase();
      const tabMentions = openTabs.map((t) => ({ label: `@tab:${t.title}`, insert: `${t.url} ` }));
      const agentMentions = AGENTS.map((a) => ({ label: a, insert: `${a} ` }));
      const all = [...agentMentions, ...tabMentions].filter((x) => x.label.toLowerCase().includes(q));
      return all.length > 0 ? { kind: 'mention' as const, items: all.slice(0, 6) } : null;
    }
    return null;
  }, [draft, openTabs]);

  const executeSlash = (raw: string): boolean => {
    const cmd = raw.trim();
    if (cmd === '/avatar') { onMorph?.('avatar'); return true; }
    if (cmd === '/workbench') { onMorph?.('workbench'); return true; }
    if (cmd === '/desktop') { onMorph?.('desktop'); return true; }
    if (cmd === '/split') { onToggleSplit?.(); return true; }
    if (cmd === '/vrm' || cmd === '/orb') { onToggleRenderer?.(); return true; }
    if (cmd === '/new') { onNewConversation?.(); return true; }
    if (cmd.startsWith('/open ')) {
      const target = cmd.slice(6).trim();
      if (target) onOpenUrlInBrowser(target);
      return true;
    }
    return false;
  };

  const submit = () => {
    const trimmed = draft.trim();
    if (!trimmed || sending) return;
    setDraft('');
    if (trimmed.startsWith('/') && executeSlash(trimmed)) return;
    onSend(trimmed, model);
  };

  return (
    <section className="ab-chat" aria-label="Agent workbench">
      <header className="ab-chat__header">
        <div className="ab-chat__title">{conversation?.title || 'Aither Workbench'}</div>
        <div className="ab-chat__actions">
          <button
            type="button"
            className="ab-chip"
            onClick={() => onOpenUrlInBrowser('https://aithr.net')}
            title="Open aithr.net in browser pane"
          >
            aithr.net
          </button>
          <button
            type="button"
            className={`ab-chip ${showBrowser ? 'is-active' : ''}`}
            onClick={onToggleBrowser}
            title="Toggle side-by-side browser pane"
          >
            {showBrowser ? 'Hide Browser' : 'Show Browser'}
          </button>
        </div>
      </header>

      {decisions.length > 0 && (
        <div className="ab-decisions" aria-label="Pending decisions">
          {decisions.slice(0, 3).map((card) => (
            <div key={card.id} className="ab-decision-card">
              <div className="ab-decision-card__head">
                <span className="ab-decision-card__badge">NEEDS YOU</span>
                <span className="ab-decision-card__title">{card.title}</span>
                <button
                  type="button"
                  className="ab-icon-btn"
                  onClick={() => onDismissDecision(card.id)}
                  title="Dismiss card"
                >
                  ×
                </button>
              </div>
              {card.summary && <p className="ab-decision-card__summary">{card.summary}</p>}
              {card.kind === 'credential' ? (
                <form
                  className="ab-cred-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const val = credDrafts[card.id] || '';
                    if (!val || !onSubmitCredential) return;
                    setCredDrafts((prev) => ({ ...prev, [card.id]: '' }));
                    const res = await onSubmitCredential(card.id, val);
                    setCredNote((prev) => ({
                      ...prev,
                      [card.id]: res?.ok ? 'Stored securely in vault.' : (res?.error || 'Vault write failed.'),
                    }));
                  }}
                >
                  <input
                    type="password"
                    className="ab-avatar-ask__input"
                    value={credDrafts[card.id] || ''}
                    onChange={(e) => setCredDrafts((prev) => ({ ...prev, [card.id]: e.target.value }))}
                    placeholder={`Paste ${card.secretName || 'secret'} (never logged)…`}
                    aria-label={`Secret for ${card.title}`}
                    autoComplete="off"
                  />
                  <button type="submit" className="ab-decision-opt is-primary" disabled={!credDrafts[card.id]}>
                    Store in Vault
                  </button>
                  {credNote[card.id] && <div className="ab-whisper__note">{credNote[card.id]}</div>}
                </form>
              ) : (
                <div className="ab-decision-card__options">
                  {card.options.length > 0 ? (
                    card.options.map((opt) => (
                      <button
                        key={opt.key}
                        type="button"
                        className={`ab-decision-opt ${opt.recommended ? 'is-primary' : ''}`}
                        onClick={() => onAnswerDecision(card.id, opt.key)}
                        title={opt.consequence || opt.label}
                      >
                        {opt.label}
                      </button>
                    ))
                  ) : (
                    <button
                      type="button"
                      className="ab-decision-opt is-primary"
                      onClick={() => onAnswerDecision(card.id, 'ack')}
                    >
                      Acknowledge
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="ab-chat__stream">
        {(conversation?.messages || []).length === 0 ? (
          <div className="ab-chat__empty">
            <div className="ab-chat__empty-title">What should we build?</div>
            <div className="ab-chat__empty-sub">
              One window · live browser on the right (`aithr.net`) · type `/` for commands or `@` to mention agents &amp; open tabs.
            </div>
          </div>
        ) : (
          (conversation?.messages || []).map((msg) => (
            <article key={msg.id} className={`ab-msg ab-msg--${msg.role}`}>
              <div className="ab-msg__role">{msg.role === 'user' ? 'You' : 'Aither'}</div>
              <div className="ab-msg__body">
                {msg.role === 'assistant' ? (
                  <MarkdownBody content={msg.content} onOpenUrl={onOpenUrlInBrowser} />
                ) : (
                  msg.content
                )}
              </div>
            </article>
          ))
        )}
      </div>

      <footer className="ab-composer">
        {activePopup && (
          <div className="ab-composer-menu" role="listbox" aria-label="Composer suggestions">
            {activePopup.kind === 'slash'
              ? activePopup.items.map((item) => (
                  <button
                    key={item.cmd}
                    type="button"
                    className="ab-composer-menu__item"
                    onClick={() => {
                      setDraft('');
                      executeSlash(item.cmd);
                    }}
                  >
                    <span className="ab-composer-menu__cmd">{item.cmd}</span>
                    <span className="ab-composer-menu__desc">{item.desc}</span>
                  </button>
                ))
              : activePopup.items.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    className="ab-composer-menu__item"
                    onClick={() => {
                      setDraft((prev) => prev.replace(/@[a-z0-9._-]*$/i, item.insert));
                    }}
                  >
                    <span className="ab-composer-menu__cmd">{item.label}</span>
                  </button>
                ))}
          </div>
        )}
        <textarea
          className="ab-composer__input"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask anything, @ to mention agents/tabs, / for actions (Enter to send)..."
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="ab-composer__bar">
          <select
            className="ab-composer__model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            aria-label="Model selector"
          >
            {modelList.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ab-composer__send"
            disabled={sending || !draft.trim()}
            onClick={submit}
          >
            {sending ? 'Streaming…' : 'Send ↵'}
          </button>
        </div>
      </footer>
    </section>
  );
};
