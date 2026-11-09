import { describe, expect, it } from 'vitest';
import { crewFairy, fairyFor, normalizeAgent, rgba } from './agent-fairy';

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

  it('rgba converts a hex colour', () => {
    expect(rgba('#38bdf8', 0.5)).toBe('rgba(56,189,248,0.5)');
  });
});
