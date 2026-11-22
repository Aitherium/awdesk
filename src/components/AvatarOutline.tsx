import { useEffect, useRef, useState } from 'react';
import {
  getPickState,
  hexToRgb,
  maskBounds,
  outlineRing,
  outlineScale,
  ringRect,
  setSelected,
  silhouetteOf,
  slotLook,
  subscribePick,
  type PickState,
} from '../hooks/avatarPick';

/**
 * The hover outline and the selection state (owner 2026-11-16: "show a clear hover outline and
 * selection state so the user knows which one a click will hit").
 *
 * The outline is the body's REAL silhouette (the same id render the pick uses, one body at a
 * time), drawn just outside it: a thin, soft, translucent white line while hovered, the agent's
 * own colour and a little wider while selected, with a name tag over the head. It is a
 * click-through overlay; it never owns a pointer. Redrawn at ~10 Hz only while something is
 * hovered or selected, so an idle desk pays nothing.
 *
 * Thin and smooth (owner screenshots, the same day: a hard, stair-stepped WHITE band around the
 * body on the desktop and in the browser rail). The band was a binary ring from a half-resolution
 * mask, stretched; now the mask is read at the window's own resolution with MSAA, the ring is
 * antialiased on both edges (hooks/avatarPick.ts outlineRing) and painted at device resolution.
 *
 * A selection lasts only while it is one: Esc clears it, and so does the window losing focus
 * (a click on another app, the browser, the desktop). It used to stay forever after any press
 * on a body -- clicks on empty space pass through this window, so nothing else could clear it,
 * and the "selected" band became a permanent part of the avatar.
 */

const REDRAW_MS = 100;
/** Ring width in CSS px, and opacity: hover is a hint, a selection is a statement. */
const HOVER = { ring: 1.25, alpha: 0.7 };
const SELECTED = { ring: 2, alpha: 0.95 };

interface Tag {
  key: string;
  label: string;
  color: string;
  selected: boolean;
  left: number;
  top: number;
}

export function AvatarOutline() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pick, setPick] = useState<PickState>(getPickState());
  const [tags, setTags] = useState<Tag[]>([]);

  useEffect(() => subscribePick(setPick), []);

  // Escape clears the selection, and so does the window losing focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null);
    };
    const onBlur = () => { setSelected(null); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    const clear = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      setTags((t) => (t.length ? [] : t));
    };
    if (!pick.hover && !pick.selected) {
      clear();
      return undefined;
    }
    const scratch = document.createElement('canvas');
    const draw = () => {
      // The overlay is painted at DEVICE resolution, so the ring is not stretched again.
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const w = Math.max(8, Math.round(window.innerWidth * dpr));
      const h = Math.max(8, Math.round(window.innerHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      const scale = outlineScale(window.innerWidth, window.innerHeight);
      const nextTags: Tag[] = [];
      const jobs: Array<{ slot: string; selected: boolean }> = [];
      if (pick.selected) jobs.push({ slot: pick.selected, selected: true });
      if (pick.hover && pick.hover !== pick.selected) jobs.push({ slot: pick.hover, selected: false });
      for (const job of jobs) {
        const sil = silhouetteOf(job.slot, scale);
        if (!sil) continue;
        const b = maskBounds(sil.alpha, sil.width, sil.height);
        if (!b) continue;
        const look = slotLook(job.slot);
        const style = job.selected ? SELECTED : HOVER;
        const rgb = job.selected ? hexToRgb(look.color) : ([255, 255, 255] as [number, number, number]);
        const ring = style.ring * scale; // CSS px -> mask px
        const rect = ringRect(b, sil.width, sil.height, ring);
        if (!rect.w || !rect.h) continue;
        const px = outlineRing(sil.alpha, sil.width, sil.height, rect, rgb, ring);
        // putImageData ignores compositing and transforms: paint the ring into a scratch canvas,
        // then draw it over, scaled to device pixels with smoothing.
        scratch.width = rect.w;
        scratch.height = rect.h;
        scratch.getContext('2d')?.putImageData(new ImageData(px, rect.w, rect.h), 0, 0);
        const kx = w / sil.width;
        const ky = h / sil.height;
        ctx.globalAlpha = style.alpha;
        ctx.drawImage(scratch, rect.x * kx, rect.y * ky, rect.w * kx, rect.h * ky);
        ctx.globalAlpha = 1;
        nextTags.push({
          key: `${job.slot}:${job.selected ? 's' : 'h'}`,
          label: look.label,
          color: job.selected ? look.color : '#ffffff',
          selected: job.selected,
          left: (b.x + b.w / 2) / scale,
          top: Math.max(4, b.y / scale - 26),
        });
      }
      setTags(nextTags);
    };
    draw();
    const id = window.setInterval(draw, REDRAW_MS);
    return () => window.clearInterval(id);
  }, [pick.hover, pick.selected]);

  return (
    <div
      data-testid="avatar-outline"
      data-hover={pick.hover ?? ''}
      data-selected={pick.selected ?? ''}
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 20 }}
    >
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      />
      {tags.map((t) => (
        <div
          key={t.key}
          style={{
            position: 'absolute',
            left: t.left,
            top: t.top,
            transform: 'translateX(-50%)',
            padding: '2px 9px',
            borderRadius: 999,
            font: '600 12px/1.4 system-ui, sans-serif',
            color: '#0b0f14',
            background: t.color,
            boxShadow: t.selected ? '0 0 0 2px rgba(0,0,0,.45), 0 2px 10px rgba(0,0,0,.5)' : '0 1px 6px rgba(0,0,0,.5)',
            opacity: t.selected ? 1 : 0.85,
            whiteSpace: 'nowrap',
          }}
        >
          {t.selected ? '● ' : ''}{t.label}
        </div>
      ))}
    </div>
  );
}
