/**
 * Bottom-centre: the owner's one call to action. A filled gold pill says how many things
 * need him and names the one it flies to; beside it, one chip per ask names WHERE it is
 * from the level on screen ("Core › Pulse"), so a second ask is never hidden behind a
 * counter. A click on the pill flies to the next ask; a click on a chip flies to that one.
 */
import type { UniverseData } from '../vendor/bead-space/types';
import { FONTS, PALETTE } from '../vendor/bead-space/space/palette';
import { MAX_ASK_CHIPS, askTargets } from './asks';
import type { BeadLevelData } from './bead-level';

export interface AsksBarProps {
  data: UniverseData;
  level: BeadLevelData | null;
  /** Which ask the pill names (wraps). */
  index: number;
  onNext: () => void;
  onFly: (index: number) => void;
}

export function AsksBar({ data, level, index, onNext, onFly }: AsksBarProps) {
  const targets = askTargets(data, level);
  const n = targets.length;
  const at = n ? ((index % n) + n) % n : 0;
  const base = {
    fontFamily: FONTS.name,
    fontSize: 16,
    lineHeight: '20px',
    borderRadius: 999,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    pointerEvents: 'auto' as const,
  };
  if (!n) {
    return (
      <div data-space-asks style={{ position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)' }}>
        <button type="button" disabled style={{
          ...base, padding: '10px 20px', border: `1px solid ${PALETTE.hairline}`,
          background: `${PALETTE.surface}E6`, color: PALETTE.quiet, cursor: 'default',
        }}>
          Nothing needs you
        </button>
      </div>
    );
  }
  const top = targets[at];
  return (
    <div data-space-asks style={{
      position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)', maxWidth: '86%',
      display: 'flex', gap: 10, alignItems: 'center',
    }}>
      <button type="button" onClick={onNext} data-space-asks-next
        title={n > 1 ? 'Fly to it (click again for the next one)' : 'Fly to it'}
        style={{
          ...base, padding: '10px 22px', border: 'none', background: PALETTE.gold, color: '#0B0F14',
          fontWeight: 600, cursor: 'pointer', maxWidth: 560, boxShadow: '0 6px 24px rgba(234,181,50,0.35)',
        }}>
        {`${n} thing${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you · ${top.title}`}
      </button>
      {targets.slice(0, MAX_ASK_CHIPS).map((t, i) => (
        <button key={`${t.nodeId}:${i}`} type="button" onClick={() => onFly(i)} data-space-ask-target={t.nodeId}
          aria-current={i === at ? 'true' : undefined} title={t.title}
          style={{
            ...base, padding: '9px 16px', maxWidth: 260, cursor: 'pointer',
            border: `1.5px solid ${PALETTE.gold}`,
            background: i === at ? `${PALETTE.gold}33` : `${PALETTE.surface}E6`,
            color: PALETTE.gold, fontWeight: i === at ? 600 : 400,
          }}>
          {t.where}
        </button>
      ))}
      {n > MAX_ASK_CHIPS ? (
        <span style={{ ...base, color: PALETTE.gold, fontSize: 14 }}>+{n - MAX_ASK_CHIPS}</span>
      ) : null}
    </div>
  );
}
