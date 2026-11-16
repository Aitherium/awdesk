import { useEffect, useRef, useState } from 'react';
import {
  getPickState,
  hexToRgb,
  maskBounds,
  outlineOf,
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
 * time), drawn just outside it: white and thin while hovered, the agent's own colour and thicker
 * while selected, with a name tag over the head. It is a click-through overlay; it never owns a
 * pointer. Redrawn at ~10 Hz only while something is hovered or selected, so an idle desk pays
 * nothing.
 */

const REDRAW_MS = 100;
const SCALE = 0.5;

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

  // Escape clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void import('../hooks/avatarPick').then((m) => m.setSelected(null));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
    const draw = () => {
      const w = Math.max(8, Math.round(window.innerWidth * SCALE));
      const h = Math.max(8, Math.round(window.innerHeight * SCALE));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.clearRect(0, 0, w, h);
      const nextTags: Tag[] = [];
      const jobs: Array<{ slot: string; selected: boolean }> = [];
      if (pick.selected) jobs.push({ slot: pick.selected, selected: true });
      if (pick.hover && pick.hover !== pick.selected) jobs.push({ slot: pick.hover, selected: false });
      for (const job of jobs) {
        const sil = silhouetteOf(job.slot, SCALE);
        if (!sil) continue;
        const look = slotLook(job.slot);
        const rgb = job.selected ? hexToRgb(look.color) : ([255, 255, 255] as [number, number, number]);
        const px = outlineOf(sil.alpha, sil.width, sil.height, rgb, job.selected ? 2 : 1);
        const image = new ImageData(px, sil.width, sil.height);
        // putImageData ignores compositing: paint into a scratch canvas, then draw it over.
        const scratch = document.createElement('canvas');
        scratch.width = sil.width;
        scratch.height = sil.height;
        scratch.getContext('2d')?.putImageData(image, 0, 0);
        ctx.drawImage(scratch, 0, 0, w, h);
        const b = maskBounds(sil.alpha, sil.width, sil.height);
        if (b) {
          nextTags.push({
            key: `${job.slot}:${job.selected ? 's' : 'h'}`,
            label: look.label,
            color: job.selected ? look.color : '#ffffff',
            selected: job.selected,
            left: (b.x + b.w / 2) / SCALE,
            top: Math.max(4, b.y / SCALE - 26),
          });
        }
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
