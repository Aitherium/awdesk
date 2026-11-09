import type { CSSProperties } from 'react';
import { crewFairy, rgba } from '../deck/agent-fairy';

/**
 * A small fairy in an agent's colours: the same design as the desk fairy
 * (orb.html) and the Discord avatars, drawn in CSS. A crew agent with no palette
 * entry gets its hashed colour (never hidden); a generic harness name
 * (claude-code, session) renders nothing.
 */
export function FairyMark({ agent, size = 14 }: { agent: string | null | undefined; size?: number }) {
  const f = crewFairy(agent);
  if (!f.known && !f.crew) return null;
  const style = {
    '--fm-size': `${size}px`,
    '--fm-core': f.core,
    '--fm-color': rgba(f.color, 0.95),
    '--fm-glow': rgba(f.glow, 0.6),
    '--fm-wing': rgba(f.color, 0.42),
  } as CSSProperties;
  const cls = `fairy-mark${f.wings === 'swept' ? ' fairy-mark-swept' : ''}${f.ring ? ' fairy-mark-ring' : ''}`;
  return (
    <span className={cls} style={style} title={f.label} aria-label={`${f.label} fairy`} role="img" data-agent={f.agent} />
  );
}
