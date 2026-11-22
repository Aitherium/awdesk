// GENERATED from @aitherium/bead-space 0.2.0 by vendor_bead_space.py -- edit the package and re-run.
/**
 * Data contract for the bead-space universe.
 *
 * Deliberately tiny — every AitherOS adapter (work graph, fleet topology, codegraph,
 * memory graph) normalises down to exactly this shape. See `src/adapters/`.
 */

/** Canonical lifecycle vocabulary the renderer understands. */
export type BeadStatus = 'open' | 'in_progress' | 'blocked' | 'deferred' | 'done';

/** Relationship kinds. `parent-child` is solid; the other two render dashed. */
export type BeadLinkKind = 'parent-child' | 'blocks' | 'related';

export interface BeadNode {
  /** Stable unique id. Rendered as the tooltip heading. */
  id: string;
  /** Human label. */
  title: string;
  /**
   * Grouping key — each distinct cluster becomes its own constellation with its own
   * anchor point, so independent work streams do not collapse into one blob.
   */
  cluster: string;
  status: BeadStatus;
  /** Owner currently working this node. Drives ship spawning and planet tint. */
  assignee?: string | null;
  /** ISO timestamp. Radial distance from the cluster core encodes this (older = inner). */
  createdAt: string;
  /** ISO timestamp the node entered its current status. Drives orbit speed. */
  stateStartedAt?: string | null;
  /** Optional deep link; the host decides what to do with it via `onSelect`. */
  href?: string;
  /** Adapter-specific passthrough (severity, health, port, module path, …). */
  meta?: Record<string, unknown>;
}

export interface BeadLink {
  source: string;
  target: string;
  kind: BeadLinkKind;
}

export interface BeadData {
  nodes: BeadNode[];
  links: BeadLink[];
}

/** Live counts, emitted on every data change so the host can render its own chrome. */
export interface BeadStats {
  nodes: number;
  links: number;
  clusters: number;
  active: number;
  /** Owners spread across >1 active node (they get a patrolling ship). */
  patrols: number;
  /** Owners on exactly one active node (they get an orbiting ship). */
  orbits: number;
  /** Active but unassigned nodes (they get a slow station). */
  stations: number;
}

export interface BeadSpaceOptions {
  /**
   * Where the sprite PNGs live, no trailing slash. Defaults to `/assets/kenney-simple-space`.
   * Next.js hosts should copy `assets/kenney-simple-space/` into `public/`.
   */
  assetRoot?: string;
  /** Colour cycle assigned to owners by stable hash. */
  ownerPalette?: string[];
  /**
   * Colour cycle for planets that have NO owner, assigned by cluster in size order.
   * Without this a universe of unowned nodes (debt rows, services, modules) renders as
   * hundreds of identical white dots.
   */
  clusterPalette?: string[];
  /**
   * Pin the cluster→colour assignment order. REQUIRED for ordinal clusters (severity,
   * priority, layer): the default order is by cluster size, which for a debt ledger paints
   * the biggest bucket with the most alarming colour rather than the most severe one.
   * Names not listed here fall in afterwards, by size.
   */
  clusterOrder?: string[];
  /**
   * Zoom the camera to fit the whole universe once the layout settles, instead of sitting at
   * scale 1 while the graph spills off every edge. Default true.
   */
  fitToContent?: boolean;
  /**
   * Explicit cluster anchor points as normalised `[x, y]` in `0..1`. Omit to derive
   * anchors automatically — clusters are laid out on a ring, largest first.
   */
  clusterAnchors?: Record<string, [number, number]>;
  /** Render the parallax starfield. Default true. */
  starfield?: boolean;
  /**
   * Text drawn under each planet. Default: `title`, truncated.
   * Return an empty string to omit a label for that node.
   */
  nodeLabel?: (node: BeadNode) => string;
  /**
   * Labels are hidden on a crowded map and appear once you zoom past this scale, so a
   * 500-node universe stays legible instead of turning into a wall of text. Default 1.6.
   */
  labelZoom?: number;
  /**
   * …but a small universe should just be readable immediately. At or below this node
   * count labels are always on. Default 60.
   */
  labelsAlwaysBelow?: number;
  /**
   * Force-disable animation. Defaults to honouring `prefers-reduced-motion`.
   * When motion is off, ships are pinned at their first waypoint (still legible, no rAF loop).
   */
  reducedMotion?: boolean;
  /**
   * Start with the ship animation loop paused (see `BeadSpaceHandle.setPaused`). The loop
   * also pauses on its own while the document is hidden.
   */
  paused?: boolean;
  /** Fired when a planet is selected (click / Enter / Space), or `null` on reset. */
  onSelect?: (node: BeadNode | null) => void;
  /** Fired when a ship is followed by the camera, or `null` when following stops. */
  onFollow?: (owner: string | null) => void;
  /** Fired whenever the dataset changes, so the host can render a summary line. */
  onStats?: (stats: BeadStats) => void;

  // ── Semantic zoom (ADD-ONLY, 2026-10-22) ────────────────────────────────────
  // A host that shows ONE level of a hierarchy at a time (universe → galaxy → system)
  // needs bodies sized and lit by meaning, pinned where the level puts them, labels that
  // never pile up, and camera moves it can chain into a level change. All optional; a
  // host that sets none of these renders exactly as before.

  /** Body radius in world px. Return null/undefined for the engine's degree-based size. */
  nodeRadius?: (node: BeadNode) => number | null | undefined;
  /** Planet tint. Return null/undefined for the owner/cluster colour. */
  nodeColor?: (node: BeadNode) => string | null | undefined;
  /** Extra classes on the planet group (e.g. `bs-busy`, `bs-cold`, `bs-coming`). */
  nodeClass?: (node: BeadNode) => string | null | undefined;
  /**
   * Pin a node: world-px offset `[dx, dy]` from the centre of the view. Pinned nodes do
   * not drift with the force layout and spring back after a drag. null = force layout.
   */
  fixedPosition?: (node: BeadNode) => [number, number] | null | undefined;
  /** The hover/selection tooltip (id, title, status). Default true; a host with its own sheet turns it off. */
  tooltips?: boolean;
  /** Hide labels whose screen boxes collide; the most important body keeps its label. */
  labelCollision?: boolean;
  /** A plain wheel zooms (use inside an app window; on a long page leave it off). */
  wheelZoom?: boolean;
  /** Camera zoom limits. Default `[0.3, 5]`. */
  scaleExtent?: [number, number];
  /** Two starfield layers drift at different rates with the camera. */
  parallax?: boolean;
  /**
   * Every camera change. `fitK` is the scale that frames the level; `user` is false for
   * programmatic moves (flights, fits), so a host can act on gestures only.
   */
  onZoom?: (view: { k: number; fitK: number; user: boolean }) => void;
  /** Right-click, or a ~0.5 s long-press on touch, on a planet. */
  onContextMenu?: (node: BeadNode, at: { clientX: number; clientY: number }) => void;
}

/** How `update()` brings a new level on screen. */
export interface BeadUpdateOptions {
  /**
   * `in`: the new level grows out of the centre (you flew INTO something).
   * `out`: the camera starts close on `anchorId` and pulls back (you came OUT of it).
   * Omitted: a normal in-place refresh.
   */
  enter?: 'in' | 'out';
  anchorId?: string | null;
}

export interface BeadSpaceHandle {
  /**
   * Replace the dataset. Existing nodes keep their positions; the sim restarts gently.
   * With `opts.enter` the data is a NEW LEVEL: full settle, and an animated arrival.
   */
  update(data: BeadData, opts?: BeadUpdateOptions): void;
  /**
   * Fly the camera to centre `id` at `scale` (default 3x the current zoom). Resolves when
   * the flight lands (at once when motion is reduced or the id is unknown).
   */
  flyTo(id: string, opts?: { scale?: number; duration?: number }): Promise<void>;
  /** Zoom about the view centre by `factor`, animated. Resolves when it lands. */
  zoomBy(factor: number, opts?: { duration?: number }): Promise<void>;
  /** The node drawn closest to the centre of the view, or null on an empty level. */
  nodeNearCenter(): BeadNode | null;
  /**
   * Activity as motion: a ring flares out of `id` (a live event touched it). `color`
   * defaults to the body's tint. No-op for an unknown id or when motion is reduced.
   */
  pulse(id: string, opts?: { color?: string; strength?: number }): void;
  /**
   * A packet travels from one body to another (an LLM call agent -> MicroScheduler, a job
   * routine -> worker). Returns false when either end is not on this level, so the host
   * can aggregate it one level up. Reduced motion: both ends pulse instead.
   */
  packet(fromId: string, toId: string, opts?: { color?: string; duration?: number }): boolean;
  /** A probe body (the world-model explorer) glides to `id`; null hides it. */
  probe(id: string | null, opts?: { color?: string; label?: string }): void;
  /** Screen position (container px) of a body, or null when it is not on this level. */
  screenPosition(id: string): { x: number; y: number } | null;
  /** Programmatically select a node (or clear with `null`). */
  select(id: string | null): void;
  /** Programmatically follow an owner's ship (or stop with `null`). */
  follow(owner: string | null): void;
  /** Reset selection, following and camera to home. */
  reset(): void;
  /** Zoom the camera to frame the whole universe. */
  fit(): void;
  /** Clusters in render order with their assigned tint — for drawing a legend. */
  clusters(): Array<{ name: string; color: string; count: number }>;
  /** Re-measure the container. Called automatically by a ResizeObserver. */
  resize(): void;
  stats(): BeadStats;
  /**
   * Pause or resume the rAF loop and the force simulation. A paused universe keeps its
   * last frame on screen and costs nothing per frame. Resuming honours reduced motion.
   */
  setPaused(paused: boolean): void;
  /** Tear down the rAF loop, the simulation, the observer and all DOM. */
  destroy(): void;
}

/** Internal — a node once the simulation has given it coordinates. */
export interface SimNode extends BeadNode {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  degree: number;
  ageRadius: number;
}

/** Internal — one owner and the active nodes they hold. */
export interface Worker {
  owner: string;
  targets: SimNode[];
  color: string;
  phase: number;
  trail?: Array<[number, number]>;
  geometry?: {
    signature: string;
    waypoints: Array<[number, number]>;
    curves: CubicSegment[][];
    computedAt: number;
    locked: boolean;
  };
}

/** `[from, controlOne, controlTwo, to]` */
export type CubicSegment = [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
];

// ── Universe contract (U1) ───────────────────────────────────────────────────
//
// ADD-ONLY. A universe is a BeadData whose nodes also carry a level, a parent and a
// health, so one graph can be explored as universe → galaxy → solar → system → moon.
// Consumed by `./universe` (pure) and `./space` (React). Nothing above changed.

/** Depth in the universe tree. */
export type BeadLevel = 'universe' | 'galaxy' | 'solar' | 'system' | 'moon';

/** Observed health. `unknown` is NOT healthy: it renders hollow, never green. */
export type BeadHealthState = 'ok' | 'degraded' | 'down' | 'starting' | 'parked' | 'unknown';

export interface BeadHealth {
  state: BeadHealthState;
  /** Why this state, as a short plain phrase. */
  reason?: string;
  /** Which source reported it. */
  source?: string;
  /** ISO timestamp of the observation. */
  at?: string;
  /** Children's states summed, on a node that aggregates others. */
  rollup?: { ok: number; degraded: number; down: number; starting: number; unknown: number };
}

/** Something the host can do to a node. The package itself executes nothing. */
export interface BeadVerb {
  id: string;
  label: string;
  /** `confirm` = destructive: it arms on the first click and runs on a second within 6 s. */
  danger: 'none' | 'confirm';
  /**
   * `fleet` runs through the host's action table; `open` opens a surface; `info` renders
   * the node's own meta and runs nothing; `profile` edits a profile tier through a PR;
   * `unit` starts or parks ONE fleet unit (`unit-start:<unit>` / `unit-park:<unit>`).
   */
  transport: 'fleet' | 'open' | 'info' | 'profile' | 'unit';
  primary?: boolean;
}

/** An "explore with my agent" prompt scoped to one node. The first is THE button. */
export interface BeadExplore {
  label: string;
  prompt: string;
}

export interface BeadAskOption {
  key: string;
  label: string;
  recommended: boolean;
}

/** A decision card attached to the object it concerns. Attached client-side. */
export interface BeadAsk {
  cardId: string;
  title: string;
  urgency: string;
  credential: boolean;
  secretName?: string;
  options: BeadAskOption[];
  /** `explicit` (the card named its subject) or `heuristic:<rule>`. */
  how: string;
  /** Position in the host's ranked card order; lower is more important. */
  rank?: number;
}

export interface UniverseNode extends BeadNode {
  level: BeadLevel;
  parent: string | null;
  health: BeadHealth;
  verbs?: BeadVerb[];
  explore?: BeadExplore[];
  asks?: BeadAsk[];
  /** Created client-side to hold an ask whose subject had no node. */
  virtual?: boolean;
}

export type UniverseRel = 'depends' | 'hosts' | 'serves' | 'traffic' | 'routes';

export interface UniverseLink extends BeadLink {
  rel: UniverseRel;
  weight?: number;
}

export interface UniverseData {
  universe_version: number;
  generated_at: string;
  etag: string;
  nodes: UniverseNode[];
  links: UniverseLink[];
  meta: {
    sources?: Record<string, string>;
    counts?: Record<string, number>;
    ttl_s?: number;
    [key: string]: unknown;
  };
}

/** One open decision card as the desk normalises it (its `cardFromRaw` shape). */
export interface DeskCard {
  id: string;
  title: string;
  summary: string;
  kind: string;
  urgency: string;
  subject?: string;
  secretName?: string;
  recipe?: string;
  dedupeKey?: string;
  agent?: string;
  sessionId?: string;
  cwd?: string;
  host?: string;
  options: Array<{ key: string; label: string; recommended?: boolean; consequence?: string }>;
  blocking: boolean;
}
