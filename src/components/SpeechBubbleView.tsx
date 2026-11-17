import { useEffect, useRef } from 'react';
import { BUBBLE_FADE_MS, clampIntoViewport, stackOffset, type SpeechBubble } from '../speech-bubble';

/** Every live bubble's NATURAL box getter, in arrival order, so a newer one can stack over an older one
 *  instead of covering it (owner 2026-11-16: bubbles stack and fade without covering each other). */
const live: { id: number; natural: () => { left: number; top: number; right: number; bottom: number } | null }[] = [];
let nextId = 0;

/** One caption, kept inside the window.
 *
 *  It is positioned by its parent (drei's <Html>, which tracks the avatar's head
 *  every frame), so where it WANTS to be keeps moving -- a drag, an arrangement, a
 *  head tilt. The nudge is therefore re-measured on each animation frame rather
 *  than once on mount: a one-shot correction would be right until the first thing
 *  moved. The cost is one getBoundingClientRect per visible bubble per frame.
 *
 *  This renders inside <Html>'s own DOM root, where react-three-fiber's hooks do
 *  not exist -- hence requestAnimationFrame, not useFrame. */
export function SpeechBubbleView({ bubble }: { bubble: SpeechBubble }) {
  const nudgeRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    let dx = 0;
    let dy = 0;
    const me = { id: (nextId += 1), natural: () => null as { left: number; top: number; right: number; bottom: number } | null };
    me.natural = () => {
      const box = boxRef.current;
      if (!box) return null;
      const r = box.getBoundingClientRect();
      // The NATURAL box: the nudge already applied is subtracted so two bubbles never chase each other.
      return { left: r.left - dx, top: r.top - dy, right: r.right - dx, bottom: r.bottom - dy };
    };
    live.push(me);
    const tick = () => {
      const nudge = nudgeRef.current;
      const box = boxRef.current;
      if (nudge && box) {
        const r = box.getBoundingClientRect();
        // Subtract the nudge already applied to recover the NATURAL box; clamping
        // the nudged box instead would ratchet the bubble and never let it return
        // when the avatar moves back into open space.
        const natural = { left: r.left - dx, top: r.top - dy, right: r.right - dx, bottom: r.bottom - dy };
        const older = live.filter((o) => o.id < me.id).map((o) => o.natural()).filter((b): b is NonNullable<typeof b> => b !== null);
        const lift = stackOffset(natural, older);
        const lifted = { ...natural, top: natural.top + lift, bottom: natural.bottom + lift };
        const next = clampIntoViewport(lifted, { width: window.innerWidth, height: window.innerHeight });
        const wantDy = lift + next.dy;
        if (next.dx !== dx || wantDy !== dy) {
          dx = next.dx;
          dy = wantDy;
          nudge.style.transform = `translate(${dx}px, ${dy}px)`;
        }
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
      const i = live.indexOf(me);
      if (i >= 0) live.splice(i, 1);
    };
  }, []);

  return (
    <div ref={nudgeRef} className="speech-bubble-nudge">
      <div
        ref={boxRef}
        className={bubble.muted ? 'speech-bubble speech-bubble--muted' : 'speech-bubble'}
        role="status"
        aria-live="polite"
        style={{ ['--bubble-life' as string]: `${Math.max(0, (bubble.lifeMs ?? 0) - BUBBLE_FADE_MS)}ms` }}
      >
        {bubble.muted ? (
          <svg className="speech-bubble__mute" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="muted">
            <path d="M11 5 6 9H2v6h4l5 4V5z" />
            <path d="m22 9-6 6M16 9l6 6" />
          </svg>
        ) : null}
        {bubble.text}
      </div>
    </div>
  );
}
