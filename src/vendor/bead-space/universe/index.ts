// GENERATED from @aitherium/bead-space 0.2.0 by vendor_bead_space.py -- edit the package and re-run.
/**
 * `@aitherium/bead-space/universe` — the universe model, pure: levels, deterministic
 * layout, the shared selection reducer, search, verbs and card attachment.
 * No DOM, no React, no three.
 */
export { childrenOf, indexUniverse, parentOf, pathTo, visibleAt } from './levels';
export type { UniverseIndex, VisibleSet } from './levels';
export {
  GALAXY_DISTANCE,
  RING_2D,
  RING_BASE,
  extent2d,
  hashFrac,
  layout2d,
  layout3d,
  ringRadius,
} from './layout';
export {
  createSelectionReducer,
  initialSelection,
  reduceSelection,
  search,
} from './selection';
export type { SearchHit, SelectionAction, SelectionState } from './selection';
export {
  MAX_SECONDARY_VERBS,
  allAsks,
  exploreFor,
  glowCounts,
  isUrgent,
  primaryAction,
  topAskOf,
  verbsFor,
} from './verbs';
export type { NodeVerbs, PrimaryAction } from './verbs';
export { ID_PATTERN, attachCards, subjectIndex, subjectOf } from './attach';
export type { AttachOptions, Subject, SubjectIndex } from './attach';
export type {
  BeadAsk,
  BeadAskOption,
  BeadExplore,
  BeadHealth,
  BeadHealthState,
  BeadLevel,
  BeadVerb,
  DeskCard,
  UniverseData,
  UniverseLink,
  UniverseNode,
  UniverseRel,
} from '../types';
