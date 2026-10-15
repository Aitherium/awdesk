// GENERATED from @aitherium/bead-space 0.2.0 by vendor_bead_space.py -- edit the package and re-run.
/**
 * `@aitherium/bead-space/space` — the explorable 3D/2D universe for React.
 * `three` and `@react-three/fiber` are optional peers: only this entry needs them.
 * Nothing here is re-exported from the package root.
 */
export { SpaceSwitch } from './SpaceSwitch';
export type { SpaceMode, SpaceSwitchProps } from './SpaceSwitch';
export { Space3D } from './Space3D';
export type { FallbackReason, Space3DProps } from './Space3D';
export { Space2D } from './Space2D';
export type { Space2DProps } from './Space2D';
export { SelectionPanel } from './SelectionPanel';
export { CONFIRM_WINDOW_MS, stateSentence } from './panel-text';
export type {
  ActionResult,
  ExploreResult,
  SelectionPanelProps,
  SpaceActions,
  VerbResult,
} from './SelectionPanel';
export { ModePill, NextPill, SearchLine } from './Hud';
export type { ModePillProps, NextPillProps, SearchLineProps } from './Hud';
export { FONTS, PALETTE, galaxyTint, healthColor, hexToRgb, isHollow, isQuiet } from './palette';
export { BODY_RADIUS, askGlow, bodyRadius, buildInstances, positionOf, positions3d } from './scene';
export type { AskGlow, Beacon, BuildOptions, Positions, SceneInstances } from './scene';
export { FLY_MS, easeOutCubic, hasWebGL, spaceGestureAllowed } from './gesture';
