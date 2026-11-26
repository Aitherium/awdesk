import React from 'react';
import type { AvatarRendererMode, MorphMode } from './types';

interface CircularActionRailProps {
  waitingCount: number;
  cardsOpen: boolean;
  avatarRenderer: AvatarRendererMode;
  onToggleCards: () => void;
  onOpenSwarms: () => void;
  onMorph: (mode: MorphMode) => void;
  onFocusAsk: () => void;
  onToggleRenderer: () => void;
}

/**
 * Unified vertical circular action rail (same single BaseWindow — moves with
 * middle-mouse drag as one cohesive unit with the Orb/Avatar and Whisper Card).
 */
export const CircularActionRail: React.FC<CircularActionRailProps> = ({
  waitingCount,
  cardsOpen,
  avatarRenderer,
  onToggleCards,
  onOpenSwarms,
  onMorph,
  onFocusAsk,
  onToggleRenderer,
}) => (
  <nav className="ab-circle-rail" aria-label="Quick actions">
    <button
      type="button"
      className={`ab-circle-btn ${cardsOpen ? 'is-active' : ''}`}
      onClick={onToggleCards}
      title={waitingCount > 0 ? `${waitingCount} decisions waiting` : 'Decision cards'}
      aria-label="Decisions"
    >
      <span>🔔</span>
      {waitingCount > 0 && <span className="ab-circle-btn__badge">{waitingCount}</span>}
    </button>

    <button
      type="button"
      className="ab-circle-btn"
      onClick={onOpenSwarms}
      title="Open Swarms & Workspaces in Workbench"
      aria-label="Swarms and apps"
    >
      <span>⊞</span>
    </button>

    <button
      type="button"
      className="ab-circle-btn"
      onClick={() => onMorph('workbench')}
      title="Expand to AitherBrowser Workbench (Alt+2)"
      aria-label="Open AitherBrowser"
    >
      <span>🌐</span>
    </button>

    <button
      type="button"
      className="ab-circle-btn"
      onClick={onFocusAsk}
      title="Quick ask Aither"
      aria-label="Chat with Aither"
    >
      <span>💬</span>
    </button>

    <button
      type="button"
      className="ab-circle-btn"
      onClick={() => onMorph('desktop')}
      title="Blow up to AitherOS Living Desktop (Alt+3)"
      aria-label="Living Desktop"
    >
      <span>🖥</span>
    </button>

    <button
      type="button"
      className={`ab-circle-btn ${avatarRenderer === 'vrm-ondemand' ? 'is-active' : ''}`}
      onClick={onToggleRenderer}
      title={
        avatarRenderer === 'vrm-ondemand'
          ? 'Switch to 0% GPU Fairy Orb'
          : 'Pop out 3D VRM Avatar (auto-framed, zero readPixels)'
      }
      aria-label="Toggle 3D Avatar"
    >
      <span>{avatarRenderer === 'vrm-ondemand' ? '✦' : '3D'}</span>
    </button>
  </nav>
);
