import React, { useState } from 'react';
import { AvatarOrb } from './AvatarOrb';
import type {
  AutomationItem,
  AvatarRendererMode,
  AwshSessionRow,
  Conversation,
  DownloadRow,
  LibrarySnapshot,
  MorphMode,
  SwarmItem,
  VrmModelInfo,
} from './types';

interface LeftRailProps {
  width: number;
  collapsed: boolean;
  conversations: Conversation[];
  activeConversationId: string | null;
  automations: AutomationItem[];
  swarms: SwarmItem[];
  swarmsOffline: boolean;
  awshSessions?: AwshSessionRow[];
  awshOffline?: boolean;
  library?: LibrarySnapshot;
  downloads?: DownloadRow[];
  vrmModels: VrmModelInfo[];
  selectedVrm: string;
  waitingCount: number;
  avatarRenderer: AvatarRendererMode;
  initialSection?: 'conversations' | 'sessions' | 'automations' | 'swarms' | 'library' | 'projects';
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => void;
  onToggleCollapse: () => void;
  onMorph: (mode: MorphMode) => void;
  onOpenHome: () => void;
  onOpenUrl: (url: string, title?: string) => void;
  onOpenDownload?: (filePath: string, mode?: 'open' | 'folder') => void;
  onClearDownloads?: () => void;
  onToggleAvatarRenderer: () => void;
  onSelectVrm: (vrmId: string) => void;
}

function formatAge(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}

export const LeftRail: React.FC<LeftRailProps> = ({
  width,
  collapsed,
  conversations,
  activeConversationId,
  automations,
  swarms,
  swarmsOffline,
  awshSessions = [],
  awshOffline = true,
  library,
  downloads = [],
  vrmModels,
  selectedVrm,
  waitingCount,
  avatarRenderer,
  initialSection = 'conversations',
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  onToggleCollapse,
  onMorph,
  onOpenHome,
  onOpenUrl,
  onOpenDownload,
  onClearDownloads,
  onToggleAvatarRenderer,
  onSelectVrm,
}) => {
  const [section, setSection] = useState<'conversations' | 'sessions' | 'automations' | 'swarms' | 'library' | 'projects'>(
    initialSection,
  );
  const activeDlCount = downloads.filter((d) => d.state === 'progressing').length;

  if (collapsed) {
    return (
      <aside className="ab-rail ab-rail--collapsed" style={{ width }} aria-label="Sidebar">
        <AvatarOrb
          size="sm"
          status={waitingCount > 0 ? 'waiting' : 'idle'}
          waitingCount={waitingCount}
          renderer={avatarRenderer}
          onClick={() => onMorph('avatar')}
          title="Shrink to Avatar mode (Alt+1)"
        />
        <button type="button" className="ab-icon-btn" onClick={onNewConversation} title="New Conversation">
          +
        </button>
        <button type="button" className="ab-icon-btn" onClick={onOpenHome} title="Open aithr.net">
          ◈
        </button>
        <button type="button" className="ab-icon-btn" onClick={() => onMorph('desktop')} title="Living Desktop (Alt+3)">
          ⤢
        </button>
        <button type="button" className="ab-icon-btn ab-rail__expand" onClick={onToggleCollapse} title="Expand sidebar">
          »
        </button>
      </aside>
    );
  }

  return (
    <aside className="ab-rail" style={{ width }} aria-label="Workspace sidebar">
      <div className="ab-rail__avatar-card">
        <AvatarOrb
          size="md"
          status={waitingCount > 0 ? 'waiting' : 'idle'}
          waitingCount={waitingCount}
          renderer={avatarRenderer}
          onClick={() => onMorph('avatar')}
          title="Click to shrink to Avatar mode (Alt+1)"
        />
        <div className="ab-rail__avatar-meta">
          <div className="ab-rail__brand">Aither</div>
          <div className="ab-rail__sub">
            {waitingCount > 0 ? `${waitingCount} waiting on you` : '0% idle GPU · ready'}
          </div>
        </div>
        <button type="button" className="ab-icon-btn" onClick={onToggleCollapse} title="Collapse sidebar">
          «
        </button>
      </div>

      <div className="ab-rail__primary">
        <button type="button" className="ab-rail__new-btn" onClick={onNewConversation}>
          <span>+</span> New Conversation
        </button>
        <button
          type="button"
          className={`ab-rail__nav-item ${section === 'sessions' ? 'is-active' : ''}`}
          onClick={() => setSection(section === 'sessions' ? 'conversations' : 'sessions')}
        >
          <span>⌘</span> Harness Sessions
          {awshSessions.length > 0 && <span className="ab-pill">{awshSessions.length}</span>}
        </button>
        <button
          type="button"
          className={`ab-rail__nav-item ${section === 'swarms' ? 'is-active' : ''}`}
          onClick={() => setSection(section === 'swarms' ? 'conversations' : 'swarms')}
        >
          <span>✦</span> Swarms
          {swarms.length > 0 && <span className="ab-pill">{swarms.length}</span>}
        </button>
        <button
          type="button"
          className={`ab-rail__nav-item ${section === 'automations' ? 'is-active' : ''}`}
          onClick={() => setSection(section === 'automations' ? 'conversations' : 'automations')}
        >
          <span>⏱</span> Automations
          {automations.length > 0 && <span className="ab-pill">{automations.length}</span>}
        </button>
        <button
          type="button"
          className={`ab-rail__nav-item ${section === 'library' ? 'is-active' : ''}`}
          onClick={() => setSection(section === 'library' ? 'conversations' : 'library')}
        >
          <span>★</span> Library &amp; Downloads
          {(activeDlCount > 0 || downloads.length > 0) && (
            <span className="ab-pill">{activeDlCount > 0 ? `${activeDlCount}↓` : downloads.length}</span>
          )}
        </button>
        <button
          type="button"
          className={`ab-rail__nav-item ${section === 'projects' ? 'is-active' : ''}`}
          onClick={() => setSection(section === 'projects' ? 'conversations' : 'projects')}
        >
          <span>◫</span> Workspaces &amp; Avatar
        </button>
      </div>

      {section === 'sessions' ? (
        <div className="ab-rail__list">
          <div className="ab-rail__section-title">awsh Harness Sessions</div>
          {awshSessions.length === 0 ? (
            <div className="ab-rail__empty">
              {awshOffline
                ? 'awsh daemon offline (:8362). Start with `adk shell serve`.'
                : 'No active harness sessions.'}
            </div>
          ) : (
            awshSessions.map((s) => (
              <div key={s.id} className="ab-rail__row">
                <span className={`ab-dot ${s.status === 'running' ? 'is-on' : ''}`} />
                <div className="ab-rail__row-main">
                  <div className="ab-rail__row-title">{s.title || s.id}</div>
                  <div className="ab-rail__row-meta">
                    {[s.harness, s.status].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      ) : section === 'library' ? (
        <div className="ab-rail__list">
          <div className="ab-rail__section-title">Bookmarks ({library?.bookmarks.length || 0})</div>
          {(library?.bookmarks || []).length === 0 ? (
            <div className="ab-rail__empty">Press ☆ or Ctrl+D in the browser bar to save bookmarks.</div>
          ) : (
            (library?.bookmarks || []).slice(0, 15).map((b, i) => (
              <button
                key={`${b.url}-${i}`}
                type="button"
                className="ab-rail__conv"
                onClick={() => onOpenUrl(b.url, b.title)}
                title={b.url}
              >
                <span className="ab-rail__conv-title">★ {b.title || b.url}</span>
              </button>
            ))
          )}

          <div className="ab-rail__section-title">
            Downloads ({downloads.length})
            {downloads.length > 0 && (
              <button type="button" className="ab-whisper__link" style={{ marginLeft: 8 }} onClick={onClearDownloads}>
                Clear
              </button>
            )}
          </div>
          {downloads.length === 0 ? (
            <div className="ab-rail__empty">No downloads in this session.</div>
          ) : (
            downloads.slice(0, 10).map((d) => (
              <button
                key={d.id}
                type="button"
                className="ab-rail__conv"
                onClick={() => d.path && onOpenDownload?.(d.path, 'folder')}
                title={`${d.filename} (${d.state})`}
              >
                <span className="ab-rail__conv-title">↓ {d.filename}</span>
                <span className="ab-rail__conv-age">
                  {d.state === 'progressing' && d.total > 0
                    ? `${Math.round((d.received / d.total) * 100)}%`
                    : d.state}
                </span>
              </button>
            ))
          )}

          <div className="ab-rail__section-title">Recent History</div>
          {(library?.history || []).slice(0, 12).map((h, i) => (
            <button
              key={`${h.url}-${i}`}
              type="button"
              className="ab-rail__conv"
              onClick={() => onOpenUrl(h.url, h.title)}
              title={h.url}
            >
              <span className="ab-rail__conv-title">{h.title || h.url}</span>
              <span className="ab-rail__conv-age">{formatAge(h.at)}</span>
            </button>
          ))}
        </div>
      ) : section === 'swarms' ? (
        <div className="ab-rail__list">
          <div className="ab-rail__section-title">Active Swarms</div>
          {swarms.length === 0 ? (
            <div className="ab-rail__empty">
              {swarmsOffline
                ? 'SwarmBoard offline (set AWDESK_SWARM_API_URL or start gateway :8182).'
                : 'No active swarms running.'}
            </div>
          ) : (
            swarms.map((s) => (
              <button
                key={s.id}
                type="button"
                className="ab-rail__conv"
                onClick={() => onOpenUrl(s.url, s.title)}
                title={`Open ${s.title} in right browser pane`}
              >
                <span className={`ab-dot ${s.status === 'running' ? 'is-on' : ''}`} />
                <span className="ab-rail__conv-title">{s.title}</span>
                <span className="ab-rail__conv-age">{s.memberCount || s.status}</span>
              </button>
            ))
          )}
        </div>
      ) : section === 'automations' ? (
        <div className="ab-rail__list">
          <div className="ab-rail__section-title">Scheduled Wakes (awrise)</div>
          {automations.length === 0 ? (
            <div className="ab-rail__empty">No local wakes found in ~/.aither/wakes.json.</div>
          ) : (
            automations.map((a) => (
              <div key={a.id} className="ab-rail__row">
                <span className={`ab-dot ${a.enabled ? 'is-on' : ''}`} />
                <div className="ab-rail__row-main">
                  <div className="ab-rail__row-title">{a.name}</div>
                  <div className="ab-rail__row-meta">{a.schedule || a.lastStatus}</div>
                </div>
              </div>
            ))
          )}
        </div>
      ) : section === 'projects' ? (
        <div className="ab-rail__list">
          <div className="ab-rail__section-title">Surfaces &amp; Avatar</div>
          <button type="button" className="ab-rail__conv" onClick={onOpenHome}>
            <span className="ab-rail__conv-title">aithr.net · AitherNet Live</span>
            <span className="ab-rail__conv-age">Home</span>
          </button>
          <button type="button" className="ab-rail__conv" onClick={() => onMorph('desktop')}>
            <span className="ab-rail__conv-title">Blow Up → Living Desktop</span>
            <span className="ab-rail__conv-age">Alt+3</span>
          </button>
          <button type="button" className="ab-rail__conv" onClick={() => onMorph('avatar')}>
            <span className="ab-rail__conv-title">Shrink → Avatar + Rail</span>
            <span className="ab-rail__conv-age">Alt+1</span>
          </button>
          <button type="button" className="ab-rail__conv" onClick={onToggleAvatarRenderer}>
            <span className="ab-rail__conv-title">
              Engine: {avatarRenderer === 'orb2d' ? 'Fairy Orb (0% GPU)' : '3D VRM (On-Demand)'}
            </span>
            <span className="ab-rail__conv-age">Toggle</span>
          </button>
          {vrmModels.length > 0 && (
            <div className="ab-rail__vrm-pick">
              <label className="ab-rail__section-title" htmlFor="ab-rail-vrm-select">
                VRM Character
              </label>
              <select
                id="ab-rail-vrm-select"
                className="ab-composer__model"
                value={selectedVrm}
                onChange={(e) => onSelectVrm(e.target.value)}
              >
                {vrmModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      ) : (
        <div className="ab-rail__list">
          <div className="ab-rail__section-title">Conversations</div>
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`ab-rail__conv ${c.id === activeConversationId ? 'is-active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelectConversation(c.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onSelectConversation(c.id);
              }}
            >
              <span className="ab-rail__conv-title">{c.title}</span>
              <span className="ab-rail__conv-age">{formatAge(c.updatedAt)}</span>
              {conversations.length > 1 && (
                <button
                  type="button"
                  className="ab-rail__conv-del"
                  title="Delete conversation"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteConversation(c.id);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="ab-rail__footer">
        <button type="button" className="ab-chip" onClick={() => onMorph('avatar')} title="Shrink to Avatar (Alt+1)">
          Avatar
        </button>
        <button type="button" className="ab-chip" onClick={() => onMorph('desktop')} title="Expand to Living Desktop (Alt+3)">
          Desktop ⤢
        </button>
      </div>
    </aside>
  );
};
