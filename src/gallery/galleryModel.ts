/** The rogues gallery's page model: the state gallery-host.cjs sends, and the pure filters. */

export type Tier = 'everyone' | 'teen' | 'mature' | 'unrated';

export interface AvatarConfig {
  nickname: string;
  scale: number;
  idle: string;
  voice: string;
  physics: string;
}

export interface GalleryAvatar {
  name: string;
  display: string;
  nickname: string;
  tier: Tier;
  /** Who decided the rating, in his words: "VRoid Hub R18", "vision guess", "VRM licence: ...". */
  ratingSource?: string;
  origin: string;
  licence: string;
  assignedTo: string[];
  thumb: boolean;
  config: AvatarConfig;
}

export interface GalleryPersona {
  id: string;
  character: string;
  hiddenBody: boolean;
  voice: string;
  tier: Tier | null;
  rotation: { every: string; set: string[]; hidden: number } | null;
}

export interface GalleryProposal {
  id: string;
  persona: string;
  character: string;
  hiddenBody: boolean;
  by: string;
  why: string;
  at: string;
}

export interface GalleryState {
  ok: true;
  profile: 'hearth' | 'work' | 'personal';
  profiles: Record<string, Tier>;
  profileLabels: Record<string, string>;
  safeMode: boolean;
  autoSafe: boolean;
  sharing: string[];
  shareWatch?: string;
  notDetectable: string[];
  cap: Tier;
  standIn: string;
  avatars: GalleryAvatar[];
  hidden: Partial<Record<Tier, number>>;
  personas: GalleryPersona[];
  proposals: GalleryProposal[];
  studio: { installed: boolean; exe?: string | null; downloadUrl?: string };
  choices: { idle: string[]; physics: string[]; every: string[]; tiers: Tier[] };
}

export interface GalleryFilter {
  q: string;
  tiers: Tier[];
  origin: string;
  assigned: 'all' | 'assigned' | 'unassigned';
  persona: string;
}

export const EMPTY_FILTER: GalleryFilter = { q: '', tiers: [], origin: '', assigned: 'all', persona: '' };

/** The avatars a filter keeps, in display order. Pure (gallery.test.ts). */
export function filterAvatars(avatars: GalleryAvatar[], f: GalleryFilter): GalleryAvatar[] {
  const q = f.q.trim().toLowerCase();
  return avatars.filter((a) => {
    if (q && !`${a.display} ${a.name} ${a.nickname} ${a.origin} ${a.assignedTo.join(' ')}`.toLowerCase().includes(q)) return false;
    if (f.tiers.length && !f.tiers.includes(a.tier)) return false;
    if (f.origin && a.origin !== f.origin) return false;
    if (f.assigned === 'assigned' && a.assignedTo.length === 0) return false;
    if (f.assigned === 'unassigned' && a.assignedTo.length > 0) return false;
    if (f.persona && !a.assignedTo.includes(f.persona)) return false;
    return true;
  });
}

/** How many bodies the profile hides, in one sentence. */
export function hiddenSummary(hidden: Partial<Record<Tier, number>>, cap: Tier): string {
  const parts = (['teen', 'mature', 'unrated'] as Tier[])
    .filter((t) => (hidden[t] || 0) > 0)
    .map((t) => `${hidden[t]} ${t}`);
  if (!parts.length) return '';
  return `${parts.join(', ')} hidden: this desk is showing ${cap === 'everyone' ? 'everyone-rated bodies only' : `up to ${cap}`}.`;
}

/** Next index for arrow-key navigation in a grid of `count` items, `cols` wide. */
export function gridStep(index: number, key: string, cols: number, count: number): number {
  if (count === 0) return -1;
  const i = index < 0 ? 0 : index;
  const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
  const next = i + (step[key] ?? 0);
  return Math.max(0, Math.min(count - 1, next));
}

export const TIER_LABEL: Record<Tier, string> = { everyone: 'Everyone', teen: 'Teen', mature: 'Mature', unrated: 'Unrated' };
