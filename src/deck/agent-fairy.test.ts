import { describe, expect, it } from 'vitest';
import { colorForName, crewFairy, fairyFor, normalizeAgent, rgba } from './agent-fairy';
import palette from '../../electron/agent-fairies.json';

interface DeskFairy {
  fairyFor: (n: string) => Record<string, unknown>;
  crewFairy: (n: string) => Record<string, unknown>;
  normalizeAgent: (n: string) => string;
}
// The desk fairy's own reader: the deck mark must agree with it name for name.
async function deskFairy(): Promise<DeskFairy> {
  // @ts-expect-error -- a CommonJS module with no type declarations (allowJs is off)
  const mod = await import('../../electron/agent-fairy.cjs');
  return (mod.default ?? mod) as DeskFairy;
}

describe('agent-fairy (deck)', () => {
  const names = ['aither', 'Atlas', 'demi', 'Demiurge', 'lyra review', 'iris', 'saga', 'vera', 'hera', 'claude-code', '',
    'gargbot', 'Plutus', 'chaos', 'viviane'];

  it('agrees with electron/agent-fairy.cjs for every name', async () => {
    const desk = await deskFairy();
    for (const n of names) {
      expect(normalizeAgent(n)).toBe(desk.normalizeAgent(n));
      expect(fairyFor(n)).toEqual(desk.fairyFor(n));
      expect(crewFairy(n)).toEqual(desk.crewFairy(n));
    }
  });

  it('wears the Discord colours', () => {
    expect(fairyFor('lyra').color).toBe('#8b5cf6');
    expect(fairyFor('demi').color).toBe('#06b6d4');
    expect(fairyFor('hera').wings).toBe('swept');
    expect(fairyFor('Desktop canvas').known).toBe(false);
  });

  it('crew colours reproduce the shared vectors', () => {
    const vectors = (palette as { crewColor?: { vectors?: Record<string, string> } }).crewColor?.vectors ?? {};
    expect(Object.keys(vectors).length).toBeGreaterThanOrEqual(5);
    for (const [name, color] of Object.entries(vectors)) expect(colorForName(name)).toBe(color);
  });

  it('rgba converts a hex colour', () => {
    expect(rgba('#38bdf8', 0.5)).toBe('rgba(56,189,248,0.5)');
  });
});
