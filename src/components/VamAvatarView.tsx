import type { AvatarView } from '../avatar-source';

/**
 * The `vam` avatar source on screen: the DarkLink frame server's MJPEG stream
 * (127.0.0.1:9341/stream.mjpg) as the resident body, or -- when VaM is wanted
 * but not there -- a one-line badge over the VRM saying why.
 *
 * Presentational: App.tsx owns the verdict (avatarView) so the same value that
 * shows this picture is the one that hides the resident VRM -- the window never
 * shows both bodies and never shows neither.
 */
export function VamAvatarView({
  view,
  streamUrl,
  onStreamError,
}: {
  view: AvatarView;
  streamUrl: string | null;
  onStreamError: (reason: string) => void;
}) {
  if (view.showVam && streamUrl) {
    return (
      <img
        className="vam-avatar"
        src={streamUrl}
        alt="VaM avatar"
        draggable={false}
        onError={() => onStreamError('the frame stream stopped')}
      />
    );
  }
  if (view.badge) {
    return (
      <div className="avatar-source-badge" role="status" title={view.badge}>
        {view.badge}
      </div>
    );
  }
  return null;
}
