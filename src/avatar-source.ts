/**
 * The resident body's source, as main decided it (electron/vam-avatar.cjs
 * resolveSource): the VRM model, or a live picture of Virt-A-Mate.
 *
 * Main probes the frame server's /health; the renderer adds the one thing only
 * it can see -- the <img> stream itself failing (VaM closed between probes).
 * Either failure keeps the VRM on screen WITH the reason, never a blank window.
 */

export type AvatarSourceKind = 'vrm' | 'vam';

export interface AvatarSource {
  requested: AvatarSourceKind;
  source: AvatarSourceKind;
  streamUrl: string | null;
  reason: string | null;
}

export const VRM_SOURCE: AvatarSource = {
  requested: 'vrm',
  source: 'vrm',
  streamUrl: null,
  reason: null,
};

/** Only a loopback frame server may be shown: the CSP allows exactly this
 *  origin for images, and a stream from anywhere else is not "the avatar". */
const FRAME_ORIGIN = 'http://127.0.0.1:9341';

/** Sanitise main's `avatar-source` event; anything malformed is the VRM. */
export function avatarSourceFromEvent(event: unknown): AvatarSource {
  if (!event || typeof event !== 'object') return VRM_SOURCE;
  const e = event as Record<string, unknown>;
  const requested: AvatarSourceKind = e.requested === 'vam' ? 'vam' : 'vrm';
  const reason = typeof e.reason === 'string' && e.reason ? e.reason : null;
  const url = typeof e.streamUrl === 'string' ? e.streamUrl : '';
  if (e.source === 'vam' && url.startsWith(`${FRAME_ORIGIN}/`)) {
    return { requested, source: 'vam', streamUrl: url, reason: null };
  }
  if (requested === 'vam') {
    return {
      requested,
      source: 'vrm',
      streamUrl: null,
      reason: reason ?? (e.source === 'vam' ? `stream not on ${FRAME_ORIGIN}` : 'VaM unavailable'),
    };
  }
  return VRM_SOURCE;
}

export interface AvatarView {
  /** Render the VaM picture in place of the resident VRM. */
  showVam: boolean;
  /** The visible fallback line, or null when nothing is wrong. */
  badge: string | null;
}

/** What the window shows, given main's verdict and whether the <img> errored. */
export function avatarView(src: AvatarSource, streamError: string | null): AvatarView {
  if (src.requested !== 'vam') return { showVam: false, badge: null };
  if (src.source === 'vam' && src.streamUrl && !streamError) return { showVam: true, badge: null };
  const why = streamError ?? src.reason ?? 'VaM unavailable';
  return { showVam: false, badge: `VaM avatar off — showing VRM (${why})` };
}
