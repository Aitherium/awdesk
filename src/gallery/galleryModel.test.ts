import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER, filterAvatars, gridStep, hiddenSummary, type GalleryAvatar } from './galleryModel';

const a = (name: string, over: Partial<GalleryAvatar> = {}): GalleryAvatar => ({
  name, display: name, nickname: '', tier: 'everyone', origin: 'Imported', licence: '', assignedTo: [], thumb: false,
  config: { nickname: '', scale: 1, idle: 'default', voice: '', physics: 'default' }, ...over,
});
const list = [
  a('atlas', { origin: 'Avatar factory', assignedTo: ['atlas'] }),
  a('herta', { tier: 'teen', origin: 'VRoid Hub', assignedTo: ['iris'] }),
  a('fresh', { tier: 'unrated', origin: 'VRoid Studio' }),
];

describe('filterAvatars', () => {
  it('search, rating, source, assigned and persona all narrow', () => {
    expect(filterAvatars(list, { ...EMPTY_FILTER, q: 'IRIS' }).map((x) => x.name)).toEqual(['herta']);
    expect(filterAvatars(list, { ...EMPTY_FILTER, tiers: ['unrated'] }).map((x) => x.name)).toEqual(['fresh']);
    expect(filterAvatars(list, { ...EMPTY_FILTER, origin: 'Avatar factory' }).map((x) => x.name)).toEqual(['atlas']);
    expect(filterAvatars(list, { ...EMPTY_FILTER, assigned: 'unassigned' }).map((x) => x.name)).toEqual(['fresh']);
    expect(filterAvatars(list, { ...EMPTY_FILTER, persona: 'atlas' }).map((x) => x.name)).toEqual(['atlas']);
    expect(filterAvatars(list, EMPTY_FILTER)).toHaveLength(3);
  });
});

describe('hiddenSummary', () => {
  it('says how many and why, without names', () => {
    expect(hiddenSummary({ mature: 3, unrated: 2 }, 'everyone')).toBe('3 mature, 2 unrated hidden: this desk is showing everyone-rated bodies only.');
    expect(hiddenSummary({}, 'mature')).toBe('');
  });
});

describe('gridStep', () => {
  it('arrows move within bounds', () => {
    expect(gridStep(0, 'ArrowRight', 4, 10)).toBe(1);
    expect(gridStep(1, 'ArrowDown', 4, 10)).toBe(5);
    expect(gridStep(8, 'ArrowDown', 4, 10)).toBe(9);
    expect(gridStep(0, 'ArrowLeft', 4, 10)).toBe(0);
    expect(gridStep(-1, 'ArrowRight', 4, 0)).toBe(-1);
  });
});
