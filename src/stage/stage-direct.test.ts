import { describe, expect, it } from 'vitest';
import { POSITION_BOUND } from '../hooks/useAvatarLayout';
import { dropTarget, groupCentre, handleLabel, sanitizeGroups, shiftGroup } from './stage-direct';

const spot = (slotId: string, x: number, z = 0) => ({ slotId, x, z });

describe('dropTarget: a body dropped on another joins it', () => {
  it('picks the body it landed on', () => {
    expect(dropTarget(spot('slot1', 0.3), [spot('slot0', 0), spot('slot2', 1.6)])).toBe('slot0');
  });
  it('picks the nearest when two are in reach', () => {
    expect(dropTarget(spot('slot1', 0.5), [spot('slot0', 0), spot('slot2', 0.9)])).toBe('slot2');
  });
  it('is nobody when it landed in the open', () => {
    expect(dropTarget(spot('slot1', 1.0), [spot('slot0', -1.5), spot('slot2', 2)])).toBeNull();
  });
  it('never targets itself', () => {
    expect(dropTarget(spot('slot1', 0), [spot('slot1', 0)])).toBeNull();
  });
  it('a body well behind another is not "on" it', () => {
    expect(dropTarget(spot('slot1', 0, 0), [spot('slot0', 0, 1.6)])).toBeNull();
  });
});

describe('stage groups from main', () => {
  it('keeps groups of two or more known bodies, drops junk', () => {
    const groups = sanitizeGroups([
      { id: 'stage1', slots: ['slot0', 'slot1', 'slot1'], members: ['aither', 'lyra'], locked: true },
      { id: 'stage2', slots: ['slot2'], members: [] },
      { id: 7, slots: ['a', 'b'] },
      null,
    ], ['slot0', 'slot1', 'slot2']);
    expect(groups).toEqual([{ id: 'stage1', slots: ['slot0', 'slot1'], members: ['aither', 'lyra'], locked: true }]);
    expect(sanitizeGroups('nope')).toEqual([]);
  });
  it('a body that is not on this stage does not count towards a group', () => {
    expect(sanitizeGroups([{ id: 'stage1', slots: ['slot0', 'ghost'] }], ['slot0'])).toEqual([]);
  });
  it('labels the handle', () => {
    expect(handleLabel({ id: 'stage2', slots: ['a', 'b', 'c'], members: [], locked: false })).toBe('Stage 2 · 3 bodies');
    expect(handleLabel({ id: 'stage1', slots: ['a', 'b'], members: [], locked: true })).toContain('locked');
  });
});

describe('moving a stage by its handle', () => {
  const start: Record<string, [number, number, number]> = { slot0: [-0.6, 0, 0], slot1: [0.6, 0, 0] };
  it('finds the centre of the group', () => {
    expect(groupCentre(['slot0', 'slot1'], start)).toEqual({ x: 0, z: 0 });
    expect(groupCentre(['gone'], start)).toBeNull();
  });
  it('moves every body by the same amount and keeps y', () => {
    const moved = shiftGroup({ slot0: [-0.6, 0.1, 0], slot1: [0.6, 0.1, 0] }, 0.5);
    expect(moved.slot0).toEqual([-0.1, 0.1, 0]);
    expect(moved.slot1).toEqual([1.1, 0.1, 0]);
  });
  it('stops when the first body reaches the bound: the group keeps its shape', () => {
    const moved = shiftGroup(start, 50);
    expect(moved.slot1[0]).toBe(POSITION_BOUND);
    expect(moved.slot1[0] - moved.slot0[0]).toBeCloseTo(1.2, 4);
    const left = shiftGroup(start, -50);
    expect(left.slot0[0]).toBe(-POSITION_BOUND);
  });
  it('an empty group is nothing', () => {
    expect(shiftGroup({}, 1)).toEqual({});
  });
});
