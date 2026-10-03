import { describe, expect, it } from 'vitest';
import { easeExpressions, moodToExpression, NEUTRAL_WEIGHTS, setAeonMood } from './aeonMood';

describe('moodToExpression', () => {
  it('maps anxious to a sad/surprised tint, never a full mask', () => {
    const w = moodToExpression('anxious');
    expect(w.sad).toBeGreaterThan(0);
    expect(w.surprised).toBeGreaterThan(0);
    for (const v of Object.values(w)) expect(v).toBeLessThanOrEqual(0.6);
  });

  it('an unknown or empty mood is neutral', () => {
    expect(moodToExpression('???')).toEqual(NEUTRAL_WEIGHTS);
    expect(moodToExpression(null)).toEqual(NEUTRAL_WEIGHTS);
  });

  it('is case-insensitive', () => {
    expect(moodToExpression('Serene')).toEqual(moodToExpression('serene'));
  });
});

describe('easeExpressions', () => {
  it('eases toward the mood and writes only presets the model has', () => {
    const written: Record<string, number> = {};
    const vrm = {
      expressionManager: {
        getExpression: (n: string) => (n === 'happy' || n === 'relaxed' ? {} : null),
        setValue: (n: string, v: number) => { written[n] = v; },
      },
    } as never;
    setAeonMood('content');
    const once = easeExpressions(vrm, NEUTRAL_WEIGHTS, 0.1);
    expect(once.happy).toBeGreaterThan(0);
    expect(once.happy).toBeLessThan(0.2);
    expect(Object.keys(written).sort()).toEqual(['happy', 'relaxed']);
    let w = once;
    for (let i = 0; i < 100; i += 1) w = easeExpressions(vrm, w, 0.1);
    expect(w.happy).toBeCloseTo(0.2, 3);
  });

  it('does nothing without an expression manager', () => {
    expect(easeExpressions(null, NEUTRAL_WEIGHTS, 0.1)).toBe(NEUTRAL_WEIGHTS);
  });
});
