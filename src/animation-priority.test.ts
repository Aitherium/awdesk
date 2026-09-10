import { describe, expect, it } from 'vitest';
import {
  finishBodyAnimationOverride,
  resolveBodyAnimation,
  type BodyAnimationOverride,
} from './animation-priority';

describe('MCP body animation priority', () => {
  it('keeps the override visible while voice state changes, then restores voice state', () => {
    const override: BodyAnimationOverride = {
      animation: 'DANCE',
      requestId: 1,
    };

    expect(resolveBodyAnimation('IDLE', override)).toBe('DANCE');
    expect(resolveBodyAnimation('TALK', override)).toBe('DANCE');

    const finished = finishBodyAnimationOverride(override, 1);
    expect(resolveBodyAnimation('TALK', finished)).toBe('TALK');
  });

  it('ignores completion from an override replaced by a newer MCP request', () => {
    const newerOverride: BodyAnimationOverride = {
      animation: 'FINGER_GUN',
      requestId: 2,
    };

    expect(finishBodyAnimationOverride(newerOverride, 1)).toBe(newerOverride);
    expect(resolveBodyAnimation('IDLE', newerOverride)).toBe('FINGER_GUN');
    expect(finishBodyAnimationOverride(newerOverride, 2)).toBeNull();
  });
});
