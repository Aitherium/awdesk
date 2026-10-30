"use strict";

/**
 * browser-rail.cjs -- the Aither Browser's left rail: the avatar docked at the top,
 * every Aither page under it, and the layer strip at the bottom.
 *
 * Owner, 2026-10-04: "it doesn't have all the proper ways to navigate to the various
 * pages that we collapsed from the Aither Console into this ... the awdesk avatar
 * should be attached to the Aither Browser and the browser just forms around it like
 * a shell, and then AitherDesktop forms around that dynamically ... multiple layers:
 * awsh -> awdesk/avatar -> browser -> AitherOS Online overlay".
 *
 * Until then the aither:// pages were reachable only by typing the scheme into the
 * address bar or from the three pinned tabs; the console's rail had been deleted with
 * the console. This module is that rail again, generic over console-window.cjs PANES
 * (a pane added there appears here with no edit) plus the OS apps the command
 * registry already declares.
 *
 * Pure (no electron at module load): every rectangle and row is asserted under
 * `node --test`. browser-window.cjs lays the views out from railLayout(), and main
 * docks the avatar window onto avatarSlotRect().
 */

const launchModes = require("./launch-modes.cjs");
const agentCookies = require("./browser-agent-cookies.cjs");

/** Section order, top to bottom. A section not named here follows in PANES order. */
const SECTION_ORDER = Object.freeze(["Now", "Voice", "Agents", "Agent apps", "Workspace", "Spaces & sprites", "Stage", "Apps", "Data",
  "System", "Network & platform", "Security", "Command & control", "Observability", "Planes", "Online"]);
const RAIL_WIDTH = 248;
const RAIL_COLLAPSED_WIDTH = 56;
/** Drag limits (owner, 2026-10-04: "side bars need to be draggable/customizable"). */
const RAIL_MIN = 180;
const RAIL_MAX = 420;
const PANEL_MIN = 260;
const PANEL_MAX = 640;
/** The grab strip between rail|page and page|panel: the chrome page draws the handle there. */
const GUTTER = 6;
/** The living desktop's taskbar along the bottom (Veil's <Taskbar/>, EDGE_ROOT h-14). */
const TASKBAR_HEIGHT = 56;
/**
 * The terminal dock (owner, 2026-10-28: "an always active bottom 'terminal' bar"): an
 * aither://terminal/?dock=1 view under the page and panel, above the taskbar. Closed it
 * is still a strip -- the session tabs and the running count -- so it never disappears.
 */
const DOCK_STRIP_HEIGHT = 32;
const DOCK_MIN = 120;
const DOCK_MAX = 1200;
const DOCK_HEIGHT = 300;
/** What the page keeps when the dock is dragged tall: the dock gives way, not the page. */
const PAGE_MIN_HEIGHT = 120;
/** The brand row: the Aither button that opens THE menu (the tray's), and the collapse toggle. */
const BRAND_HEIGHT = 44;
/** The avatar's slot, portrait like the floating window's default (430 x 680). */
const AVATAR_SLOT_HEIGHT = 360;
/** The layer strip at the bottom: awsh, Avatar, Browser, Online. */
const LAYERS_HEIGHT = 92;

/**
 * Commands the rail may run, by registry id. The rail is a page: it sends an id
 * back, and main refuses any id not on this list (the same fence the bead rail has).
 */
const RAIL_COMMANDS = Object.freeze([
  "osapp.family", "osapp.learn", "osapp.sprite", "osapp.academy", "osapp.spaces",
  "avatar.dock", "desktop.overlay.toggle",
  "voice.talk", "voice.mute", "voice.mute-all",
]);

/**
 * Voice in the browser (owner, 2026-10-04: "awvoice / aithervoice"): the desk's own
 * voice commands, plus Read aloud (the selection, else the page) in AitherVoice.
 */
const VOICE_ROWS = Object.freeze([
  Object.freeze({ kind: "command", id: "voice.talk", label: "Talk", hint: "Push to talk to Aither (Ctrl+Shift+Space)" }),
  Object.freeze({ kind: "browser", id: "read-aloud", label: "Read aloud", hint: "The selection, else this page, in AitherVoice" }),
  Object.freeze({ kind: "command", id: "voice.mute", label: "Mute my mic", hint: "Stop listening (Ctrl+Shift+M)" }),
  Object.freeze({ kind: "command", id: "voice.mute-all", label: "Voices on / off", hint: "Every agent voice (Ctrl+Alt+M)" }),
]);

/* ══════════════════════════════════════════════════════════════════════════════
   THE CATALOGUE — one grouping, generated from Veil, never hand-listed here.

   Owner, 2026-10-29: "THIS SHIT IS SO DAMN INCONSISTENT! NAVIGATION FUNCTIONALITY,
   DUPLICATE PAGES/APPS." Measured on this tree the same morning: 97 rows in 16
   sections, Tunnel under Observability AND Platform, Pulse under Observability AND
   Planes, and lyra/atlas/vera/hera/demi as five rows that all open the Agents window.

   Two things fixed it, and neither is a list in this file:

     1. desk-apps.generated.json, written by AitherOS/dev/tools/gen_desk_apps.py
        from Veil's app-registry.tsx + nav-destinations.ts. Every app's label, hint
        and ONE destination come from there; `--check` fails if this file is stale.
     2. railSections() groups by DESTINATION and dedupes by what a click OPENS, so
        two rows for one window collapse no matter which section either came from.

   The nine destinations are the unified surface plan's (S1): Today, Talk, Work,
   Know, Agents, Create, Worlds, Build, Platform.
   ══════════════════════════════════════════════════════════════════════════════ */
const catalogue = require("./desk-apps.generated.json");

const DESTINATIONS = Object.freeze(catalogue.destinations.map((d) => Object.freeze({ ...d })));
const DESTINATION_ORDER = Object.freeze(DESTINATIONS.map((d) => d.id));
const DESTINATION_LABEL = new Map(DESTINATIONS.map((d) => [d.id, d.label]));
const ALIAS_TO = Object.freeze(catalogue.aliasTo || {});
const APPS_BY_ID = new Map(catalogue.apps.map((a) => [a.id, a]));
/** The pane's destination, from nav-destinations.ts (the generator emits it). */
const PANE_DESTINATION = new Map(catalogue.panes.map((p) => [p.id, p.destination]));

/** The generated catalogue's rail set for one destination (curation lives in Veil). */
function railAppsFor(destination) {
  return catalogue.apps
    .filter((a) => a.rail && a.destination === destination)
    .map((a) => Object.freeze({ app: a.id, label: a.label, hint: a.hint }));
}

/** The window an id opens: an alias lands on its canonical app, everything else itself. */
function canonicalId(id) {
  return ALIAS_TO[String(id || "")] || String(id || "");
}

/** The destination filed for an app id (alias-resolved), or null when nobody filed it. */
function destinationOf(appId) {
  const app = APPS_BY_ID.get(canonicalId(appId));
  return app ? app.destination : null;
}

/**
 * The OS apps (they open inside AitherOS Online, never as new installables).
 * `destination` is the catalogue's own filing for that app id -- the desk command
 * lands where the app lands, so there is one answer.
 */
const OS_APP_ROWS = Object.freeze([
  Object.freeze({ command: "osapp.family", app: "family", label: "Family", hint: "The household, devices and kids", icon: "home" }),
  Object.freeze({ command: "osapp.learn", app: "learn", label: "Learn", hint: "Lessons and the tutor", icon: "book" }),
  Object.freeze({ command: "osapp.sprite", app: "sprite", label: "Sprite", hint: "Make and animate sprites", icon: "image" }),
  Object.freeze({ command: "osapp.academy", app: "classroom", label: "Academy", hint: "Courses and classes", icon: "book" }),
  Object.freeze({ command: "osapp.spaces", app: "spaces", label: "Spaces", hint: "Shared spaces and boards", icon: "grid" }),
]);

/** The agent apps the rail carries (catalogue: destination "agents"). */
const AGENT_APPS = Object.freeze(railAppsFor("agents"));
const SPACE_APPS = Object.freeze(railAppsFor("worlds"));
const PLATFORM_APPS = Object.freeze(railAppsFor("platform"));
/** Kept as an exported name: Sentry is filed under Platform now, so this is empty. */
const SECURITY_APPS = Object.freeze([]);

/**
 * The workspace (owner, 2026-10-04: "the old /workspace surface / UI / apps =
 * BusinessPilot + Aitherium managed agents + ... + local fleet config + MDM for
 * phones / tablets / laptops ... anything that runs awdk"). Pages of the signed-in
 * Workspace (app.aitherium.com), opened in the pinned Workspace tab. Paths are a fixed
 * list; the workspace's own auth decides what each shows. Each row names its
 * destination, because these are ROUTES, not Veil windows.
 */
const WORKSPACE_PAGES = Object.freeze([
  // Mail (MAIL-3, 2026-10-29): the desk had no mail surface at all. /workspace/mail is the
  // route-map door onto the mail view (/workspace/one?tab=mail), which reads the owner's
  // real mailbox (aitheros-mail); the site's RBAC decides who may open it.
  Object.freeze({ path: "/workspace/mail", label: "Mail", hint: "Your inbox: the real mail, unread first", destination: "talk" }),
  Object.freeze({ path: "/workspace/members", label: "Members", hint: "People in your workspace", destination: "work" }),
  Object.freeze({ path: "/workspace/business", label: "BusinessPilot", hint: "Your business, run by agents", destination: "work" }),
  Object.freeze({ path: "/workspace/agents", label: "Managed agents", hint: "Your Aitherium-managed agents", destination: "agents" }),
  Object.freeze({ path: "/workspace/routines", label: "Routines", hint: "What runs on a schedule", destination: "build" }),
  Object.freeze({ path: "/workspace/runs", label: "Runs", hint: "Every agent run", destination: "build" }),
  Object.freeze({ path: "/workspace/skills", label: "Skills", hint: "Installed, learned and community skills", destination: "build" }),
  Object.freeze({ path: "/workspace/fleet", label: "Fleet instances", hint: "Your agent fleet: instances and telemetry", destination: "platform" }),
  Object.freeze({ path: "/workspace/fleet/provision", label: "Provision", hint: "Stand up a new instance", destination: "platform" }),
  Object.freeze({ path: "/workspace/nodes", label: "Nodes", hint: "Every machine running awdk", destination: "platform" }),
  Object.freeze({ path: "/workspace/infrastructure", label: "Infrastructure", hint: "Nodes, tunnels, the stack", destination: "platform" }),
  Object.freeze({ path: "/settings/connected-devices", label: "Devices", hint: "Phones, tablets and laptops you connected", destination: "platform" }),
  Object.freeze({ path: "/settings/wallet", label: "Wallet", hint: "Link your Solana wallet (you sign; no key leaves it)", destination: "platform" }),
  Object.freeze({ path: "/workspace/self-host", label: "Self-host", hint: "Run it on your own machines", destination: "platform" }),
  Object.freeze({ path: "/workspace/packs/licenses", label: "Licenses", hint: "Your packs and licenses", destination: "platform" }),
]);

/**
 * Security (owner, 2026-10-04: "aitherfirewall / sentinel / sentry / chaos + awfirewall /
 * awtunnel"). Sentry is an Online app (filed under Platform); Chaos is a page of the
 * signed-in site. The firewall and tunnel BRICKS (awwall, awtunnel) are on the Bricks
 * page with the rest of the stack.
 */
const SECURITY_PAGES = Object.freeze([
  Object.freeze({ path: "/chaos", label: "Chaos", hint: "Chaos drills: break it on purpose, watch it heal", destination: "platform" }),
]);

/**
 * Observability, the owner's (owner, 2026-10-04: "tunnel / pulse / grafana integrated for
 * my entitlements"). Grafana and Prometheus run on THIS machine's fleet, on loopback, and
 * open as web tabs. They are PLATFORM rows: the separate "Observability" heading was
 * where Tunnel and Pulse were listed a second time (2026-10-29). Shown only when the
 * desk is linked as the platform owner (adk link role).
 */
const OWNER_LOCAL = Object.freeze([
  Object.freeze({ url: "http://127.0.0.1:3002/", label: "Grafana", hint: "Live dashboards: models, tools, GPU, end to end", destination: "platform" }),
  Object.freeze({ url: "http://127.0.0.1:9090/prometheus/", label: "Prometheus", hint: "Every scrape target and series", destination: "platform" }),
]);

/**
 * Command & control, the platform owner's (owner, 2026-10-04: "command / control all of
 * my platform tenants / customer workspaces / users ..."). Pages of the signed-in
 * site; shown, and opened, only when the desk is linked as owner -- and the site's own
 * RBAC still decides each page.
 */
const ADMIN_PAGES = Object.freeze([
  // Each row opens the page that actually renders it (audited 2026-10-10): the /admin/*
  // spellings are retired redirects (route-map.yaml), and the desktop boot turned every
  // /admin/* into the generic admin hub, so Users, Security and the rest landed on an
  // empty desktop. The canonical Mission Control views open straight in place.
  Object.freeze({ path: "/mission-control?tab=tenants", label: "Tenants", hint: "Every customer workspace", destination: "platform" }),
  Object.freeze({ path: "/mission-control?tab=tenants&view=users", label: "People & customers", hint: "Users, tenants and paying customers, joined", destination: "platform" }),
  Object.freeze({ path: "/mission-control?tab=tenants&view=entitlements", label: "Entitlements", hint: "Who may use what", destination: "platform" }),
  Object.freeze({ path: "/mission-control?tab=tenants&view=licensing", label: "Licensing", hint: "Licenses and packs", destination: "platform" }),
  Object.freeze({ path: "/mission-control?tab=moderation&view=spaces", label: "Moderation", hint: "Reported spaces and Relay messages", destination: "platform" }),
  // Support and feedback are forum boards (Relay categories `support`, `ideas`): one
  // surface with the community boards, not two rows (owner, 2026-10-10).
  Object.freeze({ path: "/?channel=people&board=support", label: "Support & forums", hint: "Support, feedback and the community boards", destination: "talk" }),
  Object.freeze({ path: "/mission-control?tab=support", label: "Support desk", hint: "Tickets, requests and the outbox", destination: "platform" }),
  Object.freeze({ path: "/relay", label: "Relay", hint: "AitherRelay: channels, DMs, rooms", destination: "talk" }),
  Object.freeze({ path: "/mission-control?tab=moderation&view=marketplace", label: "Marketplace review", hint: "Packs and apps waiting for review", destination: "platform" }),
  Object.freeze({ path: "/mission-control?tab=tenants&view=registrations", label: "Registrations", hint: "New sign-ups", destination: "platform" }),
  Object.freeze({ path: "/mission-control?tab=platform&view=security", label: "Security", hint: "Platform security posture", destination: "platform" }),
  // GPU (owner 2026-10-29: "MAKE SURE IT'S ALL TRANSPARENT"): who holds the card, why a
  // lease waited or was refused, the last 20 decisions. Read-only.
  Object.freeze({ path: "/mission-control?tab=platform&view=gpu", label: "GPU", hint: "Who holds the card, and every grant, refusal and eviction", destination: "platform" }),
  Object.freeze({ path: "/mission-control", label: "Platform", hint: "Mission Control: the platform admin home", destination: "platform" }),
]);

function isAdminPage(p) {
  return ADMIN_PAGES.some((a) => a.path === String(p || ""));
}

function isOwnerLocal(url) {
  return OWNER_LOCAL.some((o) => o.url === String(url || ""));
}

function isWorkspacePage(p) {
  const want = String(p || "");
  return WORKSPACE_PAGES.some((w) => w.path === want) || SECURITY_PAGES.some((w) => w.path === want);
}

/** May the desk open `id` as an Online app? The rail's catalogue is the fence. */
function isAgentApp(id) {
  const want = canonicalId(id);
  return catalogue.apps.some((a) => a.rail && a.id === want);
}

/**
 * The layers, innermost first. Each row says what it is and the ONE thing a click
 * does, so the stack the owner described is visible instead of implied.
 */
const LAYERS = Object.freeze([
  Object.freeze({ key: "shell", label: "awsh", hint: "The shell: terminal tabs, Claude Code, Aither, Codex", page: "terminal" }),
  Object.freeze({ key: "avatar", label: "Avatar", hint: "Dock it here, or float it on the desktop", command: "avatar.dock" }),
  Object.freeze({ key: "browser", label: "Browser", hint: "This window: pages, tabs, the agent panel" }),
  // In the browser, the Online layer is AitherOS Online drawn OVER the page (awconnect's
  // overlay, browser-overlay.cjs; Alt+O). Around the whole screen stays in the Aither menu.
  // Its ⇱ detaches it onto the real desktop (the desk's click-through overlay window);
  // a click on the layer brings it back over the page.
  Object.freeze({ key: "online", label: "Online", hint: "AitherOS Online over this page (Alt+O); ⇱ detaches it onto your desktop", action: "overlay", detach: "overlay-detach" }),
]);

/**
 * Every rail row, grouped BY DESTINATION. A row is a PAGE (opens aither://<id>), a
 * COMMAND (an id from RAIL_COMMANDS), an ONLINE app (opens in the pinned Online tab)
 * or a WEB page (workspace/admin/local).
 *
 * DEDUPE: the key is what a click OPENS -- `kind:canonical` for an app, the id for a
 * pane, the path for a page, the url for a loopback page. Two rows with one key are
 * one row. When the duplicates disagree on which id to show, the canonical id wins
 * (so the Agents window is "Agents", never "Lyra").
 *
 * @param {Array<object>} panes console-window.cjs PANES
 * @param {{activePane?: string|null}} [opts]
 */
/**
 * The identity of a row: what a click OPENS. Two rows with one key are one row.
 * Exported so a test can assert it CAN collide (a duplicated row is detected) and
 * that today's rail has no collision -- a dedupe nobody can show failing is a comment.
 */
function railRowKeys(row) {
  const idKey = `${row.kind}:${row.canonical}`;
  // The owner reads LABELS: "Files" as a pane and "Files" as an Online app in the same
  // destination is the same complaint as Tunnel twice under two headings.
  const labelKey = `${row.destination}|${String(row.label || "").trim().toLowerCase()}`;
  return [idKey, labelKey];
}

function railSections(panes, { activePane = null, signedIn = true, owner = false, modes = {} } = {}) {
  const rows = [];
  const seen = new Map();

  const push = (row) => {
    const keys = railRowKeys(row);
    const at = keys.map((k) => seen.get(k)).find((i) => i != null);
    if (at != null) {
      // Prefer the canonical id's own row; otherwise keep the first (generation order).
      const existing = rows[at];
      if (existing.id !== existing.canonical && row.id === row.canonical) rows[at] = row;
      for (const k of keys) if (!seen.has(k)) seen.set(k, at);
      return;
    }
    const at2 = rows.length;
    for (const k of keys) seen.set(k, at2);
    rows.push(row);
  };

  for (const pane of panes || []) {
    if (!pane || typeof pane.id !== "string") continue;
    push({
      kind: "page", id: pane.id, canonical: pane.id, label: pane.label || pane.id,
      hint: pane.hint || "", icon: pane.icon || null, active: pane.id === activePane,
      destination: PANE_DESTINATION.get(pane.id) || "platform",
      tabOf: pane.tabOf || null,
    });
  }
  for (const v of VOICE_ROWS) push({ ...v, canonical: v.id, icon: null, active: false, destination: "talk" });
  // Online apps BEFORE the osapp.* commands: where both exist for one window (Sprite,
  // Spaces), the app row carries the launch-mode chip and the richer door, so it wins
  // the dedupe and the command collapses into it.
  const online = (apps) => {
    for (const a of apps) {
      push({ kind: "online", id: a.app, canonical: canonicalId(a.app), label: a.label,
        hint: signedIn ? a.hint : `${a.hint} (sign in to AitherOS Online first)`, icon: null, active: false,
        locked: !signedIn, launch: launchModes.launchModeFor(modes, a.app),
        destination: destinationOf(a.app) || "platform" });
    }
  };
  for (const destination of DESTINATION_ORDER) online(railAppsFor(destination));
  for (const app of OS_APP_ROWS) {
    push({ kind: "command", id: app.command, canonical: app.command, label: app.label, hint: app.hint,
      icon: app.icon, active: false, destination: destinationOf(app.app) || "platform" });
  }
  const pages = (list) => {
    for (const w of list) {
      push({ kind: "workspace", id: w.path, canonical: w.path, label: w.label,
        hint: signedIn ? w.hint : `${w.hint} (sign in to AitherOS Online first)`, icon: null,
        active: false, locked: !signedIn, destination: w.destination || "work" });
    }
  };
  pages(WORKSPACE_PAGES);
  pages(SECURITY_PAGES);
  if (owner) {
    pages(ADMIN_PAGES);
    for (const o of OWNER_LOCAL) {
      push({ kind: "local", id: o.url, canonical: o.url, label: o.label, hint: o.hint, icon: null,
        active: false, destination: o.destination || "platform" });
    }
  }

  const groups = new Map(DESTINATION_ORDER.map((id) => [id, []]));
  for (const row of rows) {
    const dest = groups.has(row.destination) ? row.destination : "platform";
    row.destination = dest;
    groups.get(dest).push(row);
  }
  return DESTINATION_ORDER
    .filter((id) => groups.get(id).length > 0)
    .map((id) => ({ id, name: DESTINATION_LABEL.get(id) || id, rows: groups.get(id) }));
}

/** May the rail run this command id? */
/**
 * Is what the owner typed into the address bar a SEARCH rather than an address? Words
 * with a space, or one word with no dot, no scheme and no port. "localhost:3000",
 * "example.com" and "aither://x" are addresses.
 */
function isSearchText(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 500) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;
  if (/\s/.test(t)) return true;
  return !/[.:/]/.test(t);
}

function railMayRun(id) {
  return RAIL_COMMANDS.includes(String(id || ""));
}

/** The layer strip's rows with live state. */
function layerRows({ docked = false, overlayVisible = false, browserOpen = true, overPages = false } = {}) {
  return LAYERS.map((layer) => ({
    ...layer,
    on: layer.key === "avatar" ? Boolean(docked)
      : layer.key === "online" ? Boolean(overPages || overlayVisible)
        : layer.key === "browser" ? Boolean(browserOpen) : true,
    state: layer.key === "avatar" ? (docked ? "docked" : "floating")
      : layer.key === "online" ? (overPages ? "over pages" : overlayVisible ? "around you" : "off")
        : layer.key === "browser" ? "here" : "ready",
  }));
}

function clamp(value, min, max, fallback) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n))) : fallback;
}

/**
 * The owner's layout, sanitized: what browser-layout.json may hold. Anything
 * unknown or out of range falls back, so a hand-edited file cannot wedge the window.
 */
function normalizeLayout(raw = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    railWidth: clamp(r.railWidth, RAIL_MIN, RAIL_MAX, RAIL_WIDTH),
    panelWidth: clamp(r.panelWidth, PANEL_MIN, PANEL_MAX, 340),
    railCollapsed: Boolean(r.railCollapsed),
    panelCollapsed: Boolean(r.panelCollapsed),
    taskbar: r.taskbar !== false,
    // The terminal dock: open (dragged height) or its strip; present unless switched off.
    dock: r.dock !== false,
    dockOpen: r.dockOpen === true,
    dockHeight: clamp(r.dockHeight, DOCK_MIN, DOCK_MAX, DOCK_HEIGHT),
    // AitherOS Online drawn over web pages (browser-overlay.cjs): off until asked for.
    overlay: r.overlay === true,
    collapsedSections: Array.isArray(r.collapsedSections)
      ? [...new Set(r.collapsedSections.filter((n) => typeof n === "string" && n.length <= 40))].slice(0, 20) : [],
    // Where each Online app opens: tab (default) | window | desktop (launch-modes.cjs).
    launchModes: launchModes.normalizeLaunchModes(r.launchModes),
    // The sites whose sign-in the agent may ride (BROWSER-M3, browser-agent-cookies.cjs):
    // empty -- the agent keeps its own session -- until the owner allows a site.
    agentCookieSites: agentCookies.normalizeSites(r.agentCookieSites),
  };
}

/** The dock's wanted height from the owner's layout: 0 off, the strip closed, the drag open. */
function dockHeightFor({ dock = true, dockOpen = false, dockHeight = DOCK_HEIGHT } = {}) {
  if (!dock) return 0;
  return dockOpen ? clamp(dockHeight, DOCK_MIN, DOCK_MAX, DOCK_HEIGHT) : DOCK_STRIP_HEIGHT;
}

/**
 * A drag of the dock's top edge to `pointerY` (content coordinates): the height it asks
 * for, before railLayout fits it. Dragged below the strip = closed.
 */
function dockHeightFromDrag(pointerY, { height, taskbarHeight = 0 }) {
  const want = Math.round(height - taskbarHeight - Number(pointerY || 0));
  if (!Number.isFinite(want) || want < DOCK_MIN / 2) return { dockOpen: false };
  return { dockOpen: true, dockHeight: clamp(want, DOCK_MIN, DOCK_MAX, DOCK_HEIGHT) };
}

function railWidth(collapsed, width = RAIL_WIDTH) {
  return collapsed ? RAIL_COLLAPSED_WIDTH : clamp(width, RAIL_MIN, RAIL_MAX, RAIL_WIDTH);
}

/**
 * Where every view goes inside the window's content area.
 *
 *   rail | gutter | page | gutter | panel     (top: chrome, bottom: taskbar)
 *        |        ------ gutter ------
 *        |        dock (page + panel width)
 *
 * The dock sits under the page AND the panel (VS Code's bottom panel), above the
 * taskbar; the rail keeps its full height. A tall dock gives way before the page
 * drops under PAGE_MIN_HEIGHT.
 * The gutters are the chrome page's own pixels: the drag handles live there.
 *
 * @param {{width: number, height: number}} content the window's content size
 */
function railLayout(content, { collapsed = false, docked = false, chromeHeight, panelWidth = 340,
  railWidth: wantRail = RAIL_WIDTH, panelCollapsed = false, taskbarHeight = 0, dockHeight = 0 }) {
  const width = Math.max(0, Math.floor(content.width || 0));
  const height = Math.max(0, Math.floor(content.height || 0));
  const railW = Math.min(railWidth(collapsed, wantRail), width);
  const rest = Math.max(0, width - railW - GUTTER);
  const panelW = panelCollapsed ? 0 : Math.min(clamp(panelWidth, PANEL_MIN, PANEL_MAX, 340), Math.floor(rest / 2));
  const taskH = Math.min(Math.max(0, taskbarHeight), Math.max(0, height - chromeHeight));
  const room = Math.max(0, height - chromeHeight - taskH);
  const wantDock = Math.max(0, Math.floor(Number(dockHeight) || 0));
  // The strip always fits when there is room for it; an open dock stops at the page's floor.
  const dockH = wantDock ? Math.max(Math.min(wantDock, room - GUTTER - PAGE_MIN_HEIGHT),
    Math.min(DOCK_STRIP_HEIGHT, Math.max(0, room - GUTTER)), 0) : 0;
  const bodyH = Math.max(0, room - (dockH ? dockH + GUTTER : 0));
  const pageX = railW + GUTTER;
  const pageW = Math.max(0, width - pageX - (panelW ? panelW + GUTTER : 0));
  return {
    rail: { x: 0, y: 0, width: railW, height: height - taskH },
    page: { x: pageX, y: chromeHeight, width: pageW, height: bodyH },
    panel: { x: width - panelW, y: chromeHeight, width: panelW, height: bodyH },
    taskbar: { x: 0, y: height - taskH, width, height: taskH },
    dock: { x: pageX, y: height - taskH - dockH, width: Math.max(0, width - pageX), height: dockH },
    avatar: avatarSlot({ width, height: height - taskH }, { collapsed, docked, railWidth: railW }),
  };
}

/**
 * The avatar slot inside the content area, or null when there is none: the rail is
 * collapsed (56 px cannot hold a body) or the avatar is floating. Portrait, as wide
 * as the rail. The slot never eats the layer strip: on a short window it shrinks,
 * and below 160 px it is gone.
 */
function avatarSlot(content, { collapsed = false, docked = false, railWidth: w = RAIL_WIDTH } = {}) {
  if (collapsed || !docked) return null;
  const room = Math.floor((content.height || 0) - BRAND_HEIGHT - LAYERS_HEIGHT - 120);
  const width = railWidth(false, w);
  const height = Math.min(Math.round(width * (AVATAR_SLOT_HEIGHT / RAIL_WIDTH)), room);
  if (height < 160) return null;
  return { x: 0, y: BRAND_HEIGHT, width, height };
}

/**
 * The slot in SCREEN coordinates, for main to put the avatar window on. `contentBounds`
 * is BrowserWindow#getContentBounds() (DIP, screen space), so this is one offset.
 */
function avatarSlotRect(contentBounds, opts) {
  if (!contentBounds) return null;
  const slot = avatarSlot(contentBounds, opts);
  if (!slot) return null;
  return {
    x: Math.round(contentBounds.x + slot.x),
    y: Math.round(contentBounds.y + slot.y),
    width: slot.width,
    height: slot.height,
  };
}

module.exports = {
  AGENT_APPS,
  SPACE_APPS,
  PLATFORM_APPS,
  WORKSPACE_PAGES,
  SECURITY_APPS,
  SECURITY_PAGES,
  OWNER_LOCAL,
  isOwnerLocal,
  ADMIN_PAGES,
  isAdminPage,
  isWorkspacePage,
  isAgentApp,
  GUTTER,
  PANEL_MAX,
  PANEL_MIN,
  RAIL_MAX,
  RAIL_MIN,
  TASKBAR_HEIGHT,
  DOCK_STRIP_HEIGHT,
  DOCK_MIN,
  DOCK_MAX,
  DOCK_HEIGHT,
  PAGE_MIN_HEIGHT,
  dockHeightFor,
  dockHeightFromDrag,
  normalizeLayout,
  OS_APP_ROWS,
  AVATAR_SLOT_HEIGHT,
  BRAND_HEIGHT,
  LAYERS,
  LAYERS_HEIGHT,
  RAIL_COLLAPSED_WIDTH,
  RAIL_COMMANDS,
  RAIL_WIDTH,
  canonicalId,
  destinationOf,
  avatarSlot,
  avatarSlotRect,
  layerRows,
  railLayout,
  railMayRun,
  isSearchText,
  railSections,
  railRowKeys,
  railAppsFor,
  DESTINATIONS,
  DESTINATION_ORDER,
  railWidth,
};
