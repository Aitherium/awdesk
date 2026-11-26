import React, { useEffect, useRef, useState } from 'react';
import type { StagesSnapshot, TabsSnapshot } from './types';

interface BrowserPaneChromeProps {
  tabs: TabsSnapshot;
  stages?: StagesSnapshot;
  splitEnabled: boolean;
  isBookmarked?: boolean;
  findOpen?: boolean;
  focusUrlSignal?: number;
  onActivateTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onOpenTab: (url?: string) => void;
  onNavigate: (url: string) => void;
  onNavAction: (action: 'back' | 'forward' | 'reload' | 'home') => void;
  onToggleSplit: () => void;
  onToggleBookmark?: () => void;
  onToggleDevTools?: () => void;
  onSwitchStage?: (id: string) => void;
  onCreateStage?: () => void;
  onFind?: (query: string, forward: boolean) => void;
  onCloseFind?: () => void;
}

export const BrowserPaneChrome: React.FC<BrowserPaneChromeProps> = ({
  tabs,
  stages,
  splitEnabled,
  isBookmarked = false,
  findOpen = false,
  focusUrlSignal = 0,
  onActivateTab,
  onCloseTab,
  onOpenTab,
  onNavigate,
  onNavAction,
  onToggleSplit,
  onToggleBookmark,
  onToggleDevTools,
  onSwitchStage,
  onCreateStage,
  onFind,
  onCloseFind,
}) => {
  const activeTab = tabs.tabs.find((t) => t.id === tabs.activeTabId) || tabs.tabs[0] || null;
  const [urlInput, setUrlInput] = useState(activeTab?.url || tabs.homeUrl || 'https://aithr.net');
  const [findQuery, setFindQuery] = useState('');
  const urlRef = useRef<HTMLInputElement | null>(null);
  const findRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (activeTab?.url) setUrlInput(activeTab.url);
  }, [activeTab?.id, activeTab?.url]);

  useEffect(() => {
    if (focusUrlSignal > 0) {
      urlRef.current?.focus();
      urlRef.current?.select();
    }
  }, [focusUrlSignal]);

  useEffect(() => {
    if (findOpen) {
      findRef.current?.focus();
      findRef.current?.select();
    }
  }, [findOpen]);

  return (
    <div className="ab-browser-chrome" aria-label="Browser navigation">
      <div className="ab-tabs">
        {stages && stages.stages.length > 0 && (
          <div className="ab-stage-switcher">
            <select
              className="ab-stage-select"
              aria-label="Browser stage"
              value={stages.activeId || stages.stages[0]?.id || ''}
              onChange={(e) => {
                if (e.target.value === '__new__') onCreateStage?.();
                else onSwitchStage?.(e.target.value);
              }}
            >
              {stages.stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}{s.workspace ? ` (${s.workspace})` : ''}
                </option>
              ))}
              <option value="__new__">+ New Stage…</option>
            </select>
          </div>
        )}

        {tabs.tabs.map((tab) => (
          <div
            key={tab.id}
            className={`ab-tab ${tab.id === tabs.activeTabId ? 'is-active' : ''}`}
            role="tab"
            aria-selected={tab.id === tabs.activeTabId}
            tabIndex={0}
            onClick={() => onActivateTab(tab.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onActivateTab(tab.id);
            }}
            title={`${tab.title} — ${tab.url}`}
          >
            <span className="ab-tab__title">
              {tab.loading ? '◌ ' : ''}
              {tab.title}
            </span>
            <button
              type="button"
              className="ab-tab__close"
              aria-label={`Close ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="ab-tab-add"
          onClick={() => onOpenTab(tabs.homeUrl)}
          title="New tab (Ctrl+T · aithr.net)"
        >
          +
        </button>
      </div>

      {findOpen ? (
        <form
          className="ab-urlbar ab-findbar"
          onSubmit={(e) => {
            e.preventDefault();
            onFind?.(findQuery, true);
          }}
        >
          <span className="ab-findbar__label">Find</span>
          <input
            ref={findRef}
            className="ab-urlbar__input"
            value={findQuery}
            onChange={(e) => {
              setFindQuery(e.target.value);
              onFind?.(e.target.value, true);
            }}
            placeholder="Find in page (Enter = next, Esc = close)…"
            aria-label="Find in page"
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCloseFind?.();
            }}
          />
          <button type="button" className="ab-icon-btn" onClick={() => onFind?.(findQuery, false)} title="Previous match">
            ↑
          </button>
          <button type="button" className="ab-icon-btn" onClick={() => onFind?.(findQuery, true)} title="Next match">
            ↓
          </button>
          <button type="button" className="ab-icon-btn" onClick={onCloseFind} title="Close find (Esc)">
            ×
          </button>
        </form>
      ) : (
        <form
          className="ab-urlbar"
          onSubmit={(e) => {
            e.preventDefault();
            onNavigate(urlInput);
          }}
        >
          <button type="button" className="ab-icon-btn" onClick={() => onNavAction('back')} title="Back">
            ←
          </button>
          <button type="button" className="ab-icon-btn" onClick={() => onNavAction('forward')} title="Forward">
            →
          </button>
          <button type="button" className="ab-icon-btn" onClick={() => onNavAction('reload')} title="Reload (Ctrl+R)">
            ↻
          </button>
          <button type="button" className="ab-icon-btn" onClick={() => onNavAction('home')} title="Home (aithr.net)">
            ⌂
          </button>
          <input
            ref={urlRef}
            className="ab-urlbar__input"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://aithr.net or http://127.0.0.1:8765"
            aria-label="Address bar"
          />
          <button
            type="button"
            className={`ab-icon-btn ${isBookmarked ? 'is-starred' : ''}`}
            onClick={onToggleBookmark}
            title={isBookmarked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)'}
            aria-label="Bookmark"
          >
            {isBookmarked ? '★' : '☆'}
          </button>
          <button
            type="button"
            className="ab-icon-btn"
            onClick={onToggleDevTools}
            title="Toggle DevTools (F12)"
            aria-label="DevTools"
          >
            {'</>'}
          </button>
          <button
            type="button"
            className={`ab-chip ${splitEnabled ? 'is-active' : ''}`}
            onClick={onToggleSplit}
            title="Split browser pane into 2 views"
          >
            Split
          </button>
        </form>
      )}
    </div>
  );
};
