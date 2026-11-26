import React, { useEffect, useState } from 'react';
import type { AvatarRendererMode } from './types';

interface AvatarOrbProps {
  size?: 'sm' | 'md' | 'lg';
  status?: 'idle' | 'thinking' | 'waiting';
  waitingCount?: number;
  renderer?: AvatarRendererMode;
  onClick?: () => void;
  title?: string;
}

/**
 * Zero-readPixels, 0%-idle-GPU Aither companion orb.
 * Pure CSS GPU-composited radial glow that automatically pauses animations
 * when the document is hidden/minimized (never touches gl.readPixels).
 */
export const AvatarOrb: React.FC<AvatarOrbProps> = ({
  size = 'md',
  status = 'idle',
  waitingCount = 0,
  renderer = 'orb2d',
  onClick,
  title = 'Aither — click to toggle mode',
}) => {
  const [hidden, setHidden] = useState(
    typeof document !== 'undefined' ? document.hidden : false,
  );

  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const dim = size === 'sm' ? 32 : size === 'lg' ? 76 : 46;

  return (
    <button
      type="button"
      className={`ab-orb ab-orb--${size} ab-orb--${status} ${hidden ? 'ab-orb--paused' : ''}`}
      style={{ width: dim, height: dim }}
      onClick={onClick}
      title={title}
      aria-label={title}
      data-renderer={renderer}
    >
      <span className="ab-orb__halo" />
      <span className="ab-orb__core" />
      {waitingCount > 0 && (
        <span className="ab-orb__badge" aria-label={`${waitingCount} decisions waiting`}>
          {waitingCount}
        </span>
      )}
    </button>
  );
};
