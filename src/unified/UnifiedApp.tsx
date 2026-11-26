import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { AvatarOrb } from './AvatarOrb';
import { BrowserPaneChrome } from './BrowserPaneChrome';
import { ChatWorkbench } from './ChatWorkbench';
import { CircularActionRail } from './CircularActionRail';
import { FairyOrbCluster } from './FairyOrbCluster';
import { LeftRail } from './LeftRail';
import { WhisperCard } from './WhisperCard';
import type {
  AutomationItem,
  AwshSessionRow,
  Conversation,
  DecisionsSnapshot,
  DownloadRow,
  LibrarySnapshot,
  MorphMode,
  ShellState,
  StagesSnapshot,
  SwarmsSnapshot,
  TabsSnapshot,
  VrmModelInfo,
} from './types';

// Lazy-loaded so Three.js + @pixiv/three-vrm are ZERO bytes & ZERO WebGL in default Fairy Orb mode!
const LazyVrmStage = lazy(() => import('./VrmStage').then((m) => ({ default: m.VrmStage })));

const FALLBACK_STATE: ShellState = {
  mode: 'workbench',
  previousMode: 'workbench',
  homeUrl: 'https://aithr.net',
  avatarRenderer: 'orb2d',
  selectedVrm: 'model-avreg-aither-v2.vrm',
  windowCount: 1,
  layout: {
    railWidth: 248,
    railCollapsed: false,
    chatRatio: 0.44,
    showChat: true,
    showBrowser: true,
    browserSplit: false,
    desktopDockOpen: true,
  },
  computed: {
    mode: 'workbench',
    shell: { x: 0, y: 0, width: 1440, height: 900 },
    titlebar: { x: 0, y: 0, width: 1440, height: 36 },
    rail: { x: 0, y: 36, width: 248, height: 864 },
    chat: { x: 252, y: 36, width: 520, height: 864 },
    browserChrome: { x: 776, y: 36, width: 664, height: 76 },
    browserOuter: { x: 776, y: 36, width: 664, height: 864 },
    browserViews: [{ x: 776, y: 112, width: 664, height: 788 }],
    dividers: [],
  },
};

const FALLBACK_TABS: TabsSnapshot = {
  homeUrl: 'https://aithr.net',
  activeTabId: 'tab-1',
  secondaryTabId: null,
  attachedViewCount: 1,
  tabs: [
    {
      id: 'tab-1',
      url: 'https://aithr.net',
      title: 'AitherNet · live',
      workspace: '',
      partition: 'persist:aither-owner',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      pinned: true,
    },
  ],
};

const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;

export const UnifiedApp: React.FC = () => {
  const api = typeof window !== 'undefined' ? window.aitherUnified : undefined;
  const [shell, setShell] = useState<ShellState>(FALLBACK_STATE);
  const [tabs, setTabs] = useState<TabsSnapshot>(FALLBACK_TABS);
  const [decisions, setDecisions] = useState<DecisionsSnapshot>({ ok: true, count: 0, cards: [] });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [automations, setAutomations] = useState<AutomationItem[]>([]);
  const [swarms, setSwarms] = useState<SwarmsSnapshot>({ ok: false, offline: true, swarms: [], fairies: [] });
  const [awshSessions, setAwshSessions] = useState<AwshSessionRow[]>([]);
  const [awshOffline, setAwshOffline] = useState(true);
  const [models, setModels] = useState<string[]>(['aither-orchestrator', 'deepseek-v4-flash-pool', 'bonsai-27b-local']);
  const [vrmModels, setVrmModels] = useState<VrmModelInfo[]>([]);
  const [stages, setStages] = useState<StagesSnapshot>({ activeId: null, stages: [] });
  const [library, setLibrary] = useState<LibrarySnapshot>({ bookmarks: [], history: [], isBookmarked: false });
  const [downloads, setDownloads] = useState<DownloadRow[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [focusUrlSignal, setFocusUrlSignal] = useState(0);
  const [sending, setSending] = useState(false);
  const [avatarDraft, setAvatarDraft] = useState('');
  const [whisperOpen, setWhisperOpen] = useState(false);

  const askInputRef = useRef<HTMLInputElement | null>(null);
  const draggingRef = useRef(false);
  const resizingRef = useRef(false);
  const splitDragRef = useRef<'rail' | 'chat' | null>(null);

  useEffect(() => {
    if (!api) return;
    api.getState().then((init) => {
      if (init.state) setShell(init.state);
      if (init.tabs) setTabs(init.tabs);
      if (init.stages) setStages(init.stages);
      if (init.library) setLibrary(init.library);
      if (init.downloads) setDownloads(init.downloads);
      if (init.decisions) {
        setDecisions(init.decisions);
        if (init.decisions.count > 0) setWhisperOpen(true);
      }
      if (init.conversations) {
        setConversations(init.conversations);
        setActiveConvId((prev) => prev || init.conversations[0]?.id || null);
      }
      if (init.automations) setAutomations(init.automations);
    });
    api.listVrmModels?.().then((m) => Array.isArray(m) && setVrmModels(m)).catch(() => {});
    api.listSwarms?.().then((s) => s && setSwarms(s)).catch(() => {});
    api.listModels?.().then((res) => res?.models?.length && setModels(res.models)).catch(() => {});
    api.listAwshSessions?.().then((res) => {
      if (res) {
        setAwshSessions(Array.isArray(res.sessions) ? res.sessions : []);
        setAwshOffline(Boolean(res.offline));
      }
    }).catch(() => {});

    const swarmPoll = setInterval(() => {
      api.listSwarms?.().then((s) => s && setSwarms(s)).catch(() => {});
      api.listAwshSessions?.().then((res) => {
        if (res) {
          setAwshSessions(Array.isArray(res.sessions) ? res.sessions : []);
          setAwshOffline(Boolean(res.offline));
        }
      }).catch(() => {});
    }, 10000);

    const offState = api.onState((s) => setShell(s));
    const offTabs = api.onTabs((t) => {
      setTabs(t);
      const active = t.tabs.find((x) => x.id === t.activeTabId);
      api.getLibrary?.(active?.url || t.homeUrl).then((lib) => lib && setLibrary(lib)).catch(() => {});
    });
    const offDec = api.onDecisions((d) => setDecisions(d));
    const offDl = api.onDownloads?.((rows) => Array.isArray(rows) && setDownloads(rows)) || (() => {});
    const offShortcut = api.onShortcutUi?.(({ action }) => {
      if (action === 'focus-url') setFocusUrlSignal((n) => n + 1);
      else if (action === 'toggle-find') setFindOpen((v) => !v);
      else if (action === 'refresh-library') {
        api.getLibrary?.().then((lib) => lib && setLibrary(lib)).catch(() => {});
      }
    }) || (() => {});
    const offChunk = api.onChatChunk(({ conversationId, messageId, delta }) => {
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== conversationId) return c;
          const has = c.messages.some((m) => m.id === messageId);
          if (has) {
            return {
              ...c,
              messages: c.messages.map((m) => (m.id === messageId ? { ...m, content: m.content + delta } : m)),
            };
          }
          return {
            ...c,
            messages: [...c.messages, { id: messageId, role: 'assistant', content: delta, createdAt: Date.now() }],
          };
        }),
      );
    });
    return () => {
      clearInterval(swarmPoll);
      offState();
      offTabs();
      offDec();
      offDl();
      offShortcut();
      offChunk();
    };
  }, [api]);

  // Global middle-mouse drag + frameless resize + live workbench split dividers
  useEffect(() => {
    if (!api) return;
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1 && shell.mode !== 'desktop') {
        e.preventDefault();
        draggingRef.current = true;
        api.dragStart(e.screenX, e.screenY);
      }
    };
    const onMouseMove = (e: MouseEvent) => {
      if (draggingRef.current) {
        api.dragMove(e.screenX, e.screenY);
      } else if (resizingRef.current) {
        api.resizeMove(e.screenX, e.screenY);
      } else if (splitDragRef.current === 'rail') {
        const nextW = Math.max(180, Math.min(420, Math.round(e.clientX)));
        api.updateLayout({ railWidth: nextW, railCollapsed: false });
      } else if (splitDragRef.current === 'chat') {
        const railW = shell.computed.rail?.width || 248;
        const totalRem = Math.max(400, (shell.computed.shell.width || window.innerWidth) - railW - 8);
        const ratio = Math.max(0.22, Math.min(0.75, (e.clientX - railW - 4) / totalRem));
        api.updateLayout({ chatRatio: ratio });
      }
    };
    const onMouseUp = () => {
      if (draggingRef.current) {
        draggingRef.current = false;
        api.dragEnd();
      }
      if (resizingRef.current) {
        resizingRef.current = false;
        api.resizeEnd();
      }
      if (splitDragRef.current) {
        splitDragRef.current = null;
      }
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [api, shell.mode, shell.computed.rail?.width, shell.computed.shell.width]);

  const startHeaderDrag = (e: React.MouseEvent) => {
    if (e.button !== 0 || shell.mode === 'desktop') return;
    if ((e.target as HTMLElement).closest('button, input, select, textarea')) return;
    draggingRef.current = true;
    api?.dragStart(e.screenX, e.screenY);
  };

  const startEdgeResize = (edge: string) => (e: React.MouseEvent) => {
    if (e.button !== 0 || shell.mode === 'desktop') return;
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = true;
    api?.resizeStart(edge, e.screenX, e.screenY);
  };

  const setMode = useCallback(
    async (mode: MorphMode) => {
      if (api) {
        const next = await api.setMode(mode);
        if (next) setShell(next);
      } else {
        setShell((prev) => ({ ...prev, previousMode: prev.mode, mode }));
      }
    },
    [api],
  );

  const toggleAvatarRenderer = useCallback(async () => {
    const nextRenderer = shell.avatarRenderer === 'orb2d' ? 'vrm-ondemand' : 'orb2d';
    if (api) {
      const next = await api.setAvatarRenderer(nextRenderer);
      if (next) setShell(next);
    } else {
      setShell((prev) => ({ ...prev, avatarRenderer: nextRenderer }));
    }
  }, [api, shell.avatarRenderer]);

  const selectVrm = useCallback(
    async (vrmId: string) => {
      if (api) {
        const next = await api.setSelectedVrm(vrmId);
        if (next) setShell(next);
      } else {
        setShell((prev) => ({ ...prev, selectedVrm: vrmId }));
      }
    },
    [api],
  );

  const handleSend = async (text: string, model: string) => {
    if (!text.trim()) return;
    setSending(true);
    try {
      if (api) {
        let targetId = activeConvId;
        if (!targetId) {
          const created = await api.createConversation({ title: text.slice(0, 48), model });
          targetId = created.id;
          setActiveConvId(targetId);
        }
        const res = await api.sendChat({ conversationId: targetId, text, model });
        if (res?.conversation) {
          setConversations((prev) => {
            const exists = prev.some((c) => c.id === res.conversation.id);
            return exists
              ? prev.map((c) => (c.id === res.conversation.id ? res.conversation : c))
              : [res.conversation, ...prev];
          });
          setActiveConvId(res.conversation.id);
        }
      } else {
        const now = Date.now();
        const convId = activeConvId || 'local-1';
        setConversations((prev) => {
          const existing = prev.find((c) => c.id === convId);
          const nextMsg = { id: `m-${now}`, role: 'user' as const, content: text, createdAt: now };
          if (!existing) {
            return [{ id: convId, title: text.slice(0, 40), project: 'AitherOS', model, updatedAt: now, messages: [nextMsg] }, ...prev];
          }
          return prev.map((c) => (c.id === convId ? { ...c, updatedAt: now, messages: [...c.messages, nextMsg] } : c));
        });
        setActiveConvId(convId);
      }
    } finally {
      setSending(false);
    }
  };

  const activeConversation = conversations.find((c) => c.id === activeConvId) || conversations[0] || null;

  // --- MODE 1: SHRUNK AVATAR + CIRCULAR ACTION RAIL + WHISPER CARD (ONE UNIFIED WINDOW!) ---
  if (shell.mode === 'avatar') {
    return (
      <div className="ab-root ab-root--avatar" data-mode="avatar">
        {RESIZE_EDGES.map((edge) => (
          <div key={edge} className={`ab-resize ab-resize--${edge}`} onMouseDown={startEdgeResize(edge)} />
        ))}
        <header className="ab-avatar-bar" onMouseDown={startHeaderDrag}>
          <span className="ab-avatar-bar__title">Aither · Middle-drag to move · Drag edge to resize</span>
          <div className="ab-avatar-bar__btns">
            <button type="button" className="ab-chip" onClick={() => setMode('workbench')} title="Expand to AitherBrowser (Alt+2)">
              Browser
            </button>
            <button type="button" className="ab-chip" onClick={() => setMode('desktop')} title="Blow up to Living Desktop (Alt+3)">
              Desktop ⤢
            </button>
          </div>
        </header>

        <div className="ab-avatar-workspace">
          <div className="ab-avatar-main">
            {shell.avatarRenderer === 'vrm-ondemand' ? (
              <Suspense fallback={<div className="ab-vrm-stage__overlay">Loading 3D engine…</div>}>
                <LazyVrmStage
                  selectedVrm={shell.selectedVrm}
                  models={vrmModels}
                  onSelectVrm={selectVrm}
                  onFallbackOrb={toggleAvatarRenderer}
                />
              </Suspense>
            ) : (
              <div className="ab-avatar-stage">
                <FairyOrbCluster
                  fairies={swarms.fairies}
                  waitingCount={decisions.count}
                  thinking={sending}
                  onCoreClick={() => setMode('workbench')}
                  onWaitingClick={() => setWhisperOpen((v) => !v)}
                />
                <div className="ab-avatar-status">
                  {decisions.count > 0
                    ? `${decisions.count} waiting · Click pill or 🔔`
                    : '0% idle GPU · Click 3D on rail for VRM avatar'}
                </div>
              </div>
            )}

            {whisperOpen && (
              <div className="ab-avatar-whisper-wrap">
                <WhisperCard
                  cards={decisions.cards}
                  onAnswer={(id, key) => api?.answerDecision(id, key)}
                  onDismiss={(id) => api?.cancelDecision(id)}
                  onSubmitCredential={(id, val) => api ? api.submitCredential(id, val) : Promise.resolve(undefined)}
                  onOpenInBrowser={() => {
                    setWhisperOpen(false);
                    setMode('workbench');
                  }}
                  onClose={() => setWhisperOpen(false)}
                />
              </div>
            )}
          </div>

          <CircularActionRail
            waitingCount={decisions.count}
            cardsOpen={whisperOpen}
            avatarRenderer={shell.avatarRenderer}
            onToggleCards={() => setWhisperOpen((v) => !v)}
            onOpenSwarms={() => setMode('workbench')}
            onMorph={setMode}
            onFocusAsk={() => askInputRef.current?.focus()}
            onToggleRenderer={toggleAvatarRenderer}
          />
        </div>

        <form
          className="ab-avatar-ask"
          onSubmit={(e) => {
            e.preventDefault();
            const q = avatarDraft.trim();
            if (!q) return;
            setAvatarDraft('');
            setMode('workbench').then(() => handleSend(q, 'aither-orchestrator'));
          }}
        >
          <input
            ref={askInputRef}
            className="ab-avatar-ask__input"
            value={avatarDraft}
            onChange={(e) => setAvatarDraft(e.target.value)}
            placeholder="Ask Aither (Enter expands to Workbench)…"
          />
          <button type="submit" className="ab-composer__send">
            ↵
          </button>
        </form>
      </div>
    );
  }

  // --- MODE 3: EXPANDED LIVING DESKTOP MODE ---
  if (shell.mode === 'desktop') {
    return (
      <div className="ab-root ab-root--desktop" data-mode="desktop">
        <header className="ab-desktop-bar">
          <div className="ab-desktop-bar__left">
            <AvatarOrb
              size="sm"
              status={decisions.count > 0 ? 'waiting' : 'idle'}
              waitingCount={decisions.count}
              renderer={shell.avatarRenderer}
              onClick={() => setMode('avatar')}
              title="Shrink to Avatar (Alt+1)"
            />
            <span className="ab-desktop-bar__title">AitherOS Living Desktop · aithr.net</span>
          </div>
          <div className="ab-desktop-bar__right">
            {decisions.count > 0 && (
              <button type="button" className="ab-chip is-alert" onClick={() => setMode('workbench')}>
                {decisions.count} Waiting
              </button>
            )}
            <button type="button" className="ab-chip" onClick={() => setMode('workbench')} title="Shrink to 3-Pane Workbench (Alt+2)">
              Workbench (Alt+2)
            </button>
            <button type="button" className="ab-chip" onClick={() => setMode('avatar')} title="Shrink to Avatar (Alt+1)">
              Shrink to Avatar (Alt+1)
            </button>
          </div>
        </header>
        <div className="ab-desktop-canvas-slot" aria-label="Living Desktop WebContentsView host" />
      </div>
    );
  }

  // --- MODE 2: ANTIGRAVITY-STYLE 3-PANE WORKBENCH (DEFAULT) ---
  const railRect = shell.computed.rail;
  const chatRect = shell.computed.chat;
  const browserOuter = shell.computed.browserOuter;

  return (
    <div className="ab-root ab-root--workbench" data-mode="workbench">
      {RESIZE_EDGES.map((edge) => (
        <div key={edge} className={`ab-resize ab-resize--${edge}`} onMouseDown={startEdgeResize(edge)} />
      ))}

      <header className="ab-titlebar" onMouseDown={startHeaderDrag}>
        <div className="ab-titlebar__left">
          <span className="ab-titlebar__brand">AitherBrowser</span>
          <span className="ab-titlebar__meta">
            1 window · {tabs.attachedViewCount} view{tabs.attachedViewCount === 1 ? '' : 's'}
            {shell.bridgePort ? ` · :${shell.bridgePort}` : ''}
            {shell.memoryMb ? ` · ${shell.memoryMb} MB` : ''}
          </span>
        </div>
        <div className="ab-titlebar__modes" role="group" aria-label="Morph mode">
          <button type="button" className="ab-mode-btn" onClick={() => setMode('avatar')} title="Shrink to Avatar (Alt+1)">
            Avatar
          </button>
          <button type="button" className="ab-mode-btn is-active" onClick={() => setMode('workbench')} title="Workbench (Alt+2)">
            Workbench
          </button>
          <button type="button" className="ab-mode-btn" onClick={() => setMode('desktop')} title="Blow up to Living Desktop (Alt+3)">
            Living Desktop ⤢
          </button>
        </div>
        <div className="ab-titlebar__win">
          <button type="button" className="ab-win-btn" onClick={() => api?.windowAction('minimize')} aria-label="Minimize">
            ─
          </button>
          <button type="button" className="ab-win-btn" onClick={() => api?.windowAction('maximize')} aria-label="Maximize">
            □
          </button>
          <button type="button" className="ab-win-btn is-close" onClick={() => api?.windowAction('close')} aria-label="Close">
            ×
          </button>
        </div>
      </header>

      <main className="ab-workbench-body">
        {railRect && (
          <>
            <div
              className="ab-pane-slot"
              style={{ left: railRect.x, top: railRect.y, width: railRect.width, height: railRect.height }}
            >
              <LeftRail
                width={railRect.width}
                collapsed={shell.layout.railCollapsed}
                conversations={conversations}
                activeConversationId={activeConversation?.id || null}
                automations={automations}
                swarms={swarms.swarms}
                swarmsOffline={swarms.offline}
                awshSessions={awshSessions}
                awshOffline={awshOffline}
                library={library}
                downloads={downloads}
                vrmModels={vrmModels}
                selectedVrm={shell.selectedVrm}
                waitingCount={decisions.count}
                avatarRenderer={shell.avatarRenderer}
                onSelectConversation={(id) => setActiveConvId(id)}
                onNewConversation={async () => {
                  if (api) {
                    const created = await api.createConversation({ title: 'New Conversation' });
                    setConversations((prev) => [created, ...prev]);
                    setActiveConvId(created.id);
                  }
                }}
                onDeleteConversation={async (id) => {
                  if (api) {
                    await api.deleteConversation(id);
                    const next = await api.listConversations();
                    setConversations(next);
                    setActiveConvId(next[0]?.id || null);
                  }
                }}
                onToggleCollapse={() => api?.updateLayout({ railCollapsed: !shell.layout.railCollapsed })}
                onMorph={setMode}
                onOpenHome={() => api?.openTab({ url: shell.homeUrl, title: 'AitherNet', activate: true })}
                onOpenUrl={(url, title) => api?.openTab({ url, title, activate: true })}
                onOpenDownload={(filePath, mode) => api?.openDownload(filePath, mode)}
                onClearDownloads={async () => {
                  if (api) {
                    const next = await api.clearDownloads();
                    setDownloads(next);
                  }
                }}
                onToggleAvatarRenderer={toggleAvatarRenderer}
                onSelectVrm={selectVrm}
              />
            </div>
            {!shell.layout.railCollapsed && (
              <div
                className="ab-split-divider"
                style={{ left: railRect.x + railRect.width, top: railRect.y, height: railRect.height }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  splitDragRef.current = 'rail';
                }}
                title="Drag to resize sidebar"
              />
            )}
          </>
        )}

        {chatRect && (
          <>
            <div
              className="ab-pane-slot"
              style={{ left: chatRect.x, top: chatRect.y, width: chatRect.width, height: chatRect.height }}
            >
              <ChatWorkbench
                conversation={activeConversation}
                decisions={decisions.cards}
                models={models}
                openTabs={tabs.tabs}
                sending={sending}
                showBrowser={shell.layout.showBrowser}
                onSend={handleSend}
                onAnswerDecision={(id, key) => api?.answerDecision(id, key)}
                onDismissDecision={(id) => api?.cancelDecision(id)}
                onSubmitCredential={(id, val) => api ? api.submitCredential(id, val) : Promise.resolve(undefined)}
                onOpenUrlInBrowser={(url) => api?.openTab({ url, activate: true })}
                onToggleBrowser={() => api?.updateLayout({ showBrowser: !shell.layout.showBrowser })}
                onMorph={setMode}
                onToggleSplit={() => api?.updateLayout({ browserSplit: !shell.layout.browserSplit })}
                onToggleRenderer={toggleAvatarRenderer}
                onNewConversation={async () => {
                  if (api) {
                    const created = await api.createConversation({ title: 'New Conversation' });
                    setConversations((prev) => [created, ...prev]);
                    setActiveConvId(created.id);
                  }
                }}
              />
            </div>
            {browserOuter && (
              <div
                className="ab-split-divider"
                style={{ left: chatRect.x + chatRect.width, top: chatRect.y, height: chatRect.height }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  splitDragRef.current = 'chat';
                }}
                title="Drag to resize chat / browser split"
              />
            )}
          </>
        )}

        {browserOuter && (
          <div
            className="ab-pane-slot ab-browser-slot"
            style={{ left: browserOuter.x, top: browserOuter.y, width: browserOuter.width, height: browserOuter.height }}
          >
            <BrowserPaneChrome
              tabs={tabs}
              stages={stages}
              splitEnabled={shell.layout.browserSplit}
              isBookmarked={library.isBookmarked}
              findOpen={findOpen}
              focusUrlSignal={focusUrlSignal}
              onActivateTab={(id) => api?.activateTab(id)}
              onCloseTab={(id) => api?.closeTab(id)}
              onOpenTab={(url) => api?.openTab({ url: url || shell.homeUrl, activate: true })}
              onNavigate={(url) => api?.navigateTab(tabs.activeTabId, url)}
              onNavAction={(action) => api?.tabNav(tabs.activeTabId, action)}
              onToggleSplit={() => api?.updateLayout({ browserSplit: !shell.layout.browserSplit })}
              onToggleBookmark={async () => {
                const active = tabs.tabs.find((t) => t.id === tabs.activeTabId);
                if (api && active) {
                  await api.toggleBookmark(active.url, active.title);
                  const lib = await api.getLibrary(active.url);
                  if (lib) setLibrary(lib);
                }
              }}
              onToggleDevTools={() => api?.toggleDevTools(tabs.activeTabId)}
              onSwitchStage={async (id) => {
                if (!api) return;
                const res = await api.switchStage(id);
                if (res) {
                  setStages(res.stages);
                  setTabs(res.tabs);
                }
              }}
              onCreateStage={async () => {
                if (!api) return;
                const name = `Stage ${stages.stages.length + 1}`;
                const res = await api.createStage({ name });
                if (res) {
                  setStages(res.stages);
                  setTabs(res.tabs);
                }
              }}
              onFind={(q, forward) => api?.findInPage(tabs.activeTabId, q, { forward })}
              onCloseFind={() => {
                setFindOpen(false);
                api?.stopFindInPage(tabs.activeTabId);
              }}
            />
            {!api && (
              <div className="ab-browser-preview-fallback">
                Live Chromium `WebContentsView` mounts here (`{tabs.tabs.find((t) => t.id === tabs.activeTabId)?.url || 'https://aithr.net'}`).
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
};
