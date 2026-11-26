import React, { useEffect, useState } from 'react';
import type { FairyLead } from './types';

interface FairyOrbClusterProps {
  fairies: FairyLead[];
  waitingCount: number;
  thinking?: boolean;
  onCoreClick: () => void;
  onWaitingClick?: () => void;
}

const DEFAULT_FAIRIES: FairyLead[] = [
  { id: 'atlas', label: 'Atlas', color: '#4ade80', role: 'Planner', active: false },
  { id: 'demiurge', label: 'Demiurge', color: '#f87171', role: 'Builder', active: false },
  { id: 'lyra', label: 'Lyra', color: '#60a5fa', role: 'Research', active: false },
  { id: 'iris', label: 'Iris', color: '#c084fc', role: 'Visuals', active: false },
  { id: 'hera', label: 'Hera', color: '#fbbf24', role: 'Watch', active: false },
  { id: 'vera', label: 'Vera', color: '#2dd4bf', role: 'Docs', active: false },
];

/**
 * Unified Aither Orb + Orbiting Sovereign Fairies cluster.
 * Pure CSS GPU-composited (zero WebGL context, zero readPixels) and automatically
 * freezes animations when the window/tab is hidden for 0% idle GPU usage.
 */
export const FairyOrbCluster: React.FC<FairyOrbClusterProps> = ({
  fairies,
  waitingCount,
  thinking = false,
  onCoreClick,
  onWaitingClick,
}) => {
  const [hidden, setHidden] = useState(
    typeof document !== 'undefined' ? document.hidden : false,
  );

  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const list = fairies.length > 0 ? fairies : DEFAULT_FAIRIES;
  const radius = 64;

  return (
    <div
      className={`ab-cluster ${hidden ? 'is-paused' : ''} ${thinking ? 'is-thinking' : ''}`}
      aria-label="Aither fairy orb cluster"
    >
      <div className="ab-cluster__ring">
        {list.map((f, idx) => {
          const angle = (idx / list.length) * Math.PI * 2 - Math.PI / 2;
          const x = Math.round(Math.cos(angle) * radius);
          const y = Math.round(Math.sin(angle) * radius);
          return (
            <span
              key={f.id}
              className={`ab-fairy-dot ${f.active ? 'is-active' : ''}`}
              style={{
                transform: `translate(${x}px, ${y}px)`,
                background: f.color,
                boxShadow: `0 0 ${f.active ? 16 : 10}px ${f.color}`,
              }}
              title={`${f.label} (${f.role})${f.active ? ' · active in swarm' : ''}`}
            />
          );
        })}
      </div>

      <button
        type="button"
        className={`ab-cluster__core ${waitingCount > 0 ? 'is-waiting' : ''}`}
        onClick={onCoreClick}
        title="Click to expand to AitherBrowser · Middle-drag anywhere to move"
      >
        <span className="ab-cluster__halo" />
        <span className="ab-cluster__sun" />
      </button>

      {waitingCount > 0 && (
        <button
          type="button"
          className="ab-cluster__waiting-pill"
          onClick={onWaitingClick || onCoreClick}
          title={`${waitingCount} decision${waitingCount === 1 ? '' : 's'} waiting`}
        >
          <span className="ab-cluster__waiting-count">{waitingCount} ›</span>
          <span className="ab-cluster__waiting-label">WAITING</span>
        </button>
      )}
    </div>
  );
};
