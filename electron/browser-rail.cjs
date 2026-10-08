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

/** The OS apps (they open inside AitherOS Online, never as new installables). */
const APP_ROWS = Object.freeze([
  Object.freeze({ command: "osapp.family", label: "Family", hint: "The household, devices and kids", icon: "home" }),
  Object.freeze({ command: "osapp.learn", label: "Learn", hint: "Lessons and the tutor", icon: "book" }),
  Object.freeze({ command: "osapp.sprite", label: "Sprite", hint: "Make and animate sprites", icon: "image" }),
  Object.freeze({ command: "osapp.academy", label: "Academy", hint: "Courses and classes", icon: "book" }),
  Object.freeze({ command: "osapp.spaces", label: "Spaces", hint: "Shared spaces and boards", icon: "grid" }),
]);

/**
 * The agent apps (owner, 2026-10-04: "integrating all of the agent apps like aither,
 * aeon, demi, atlas, lyra, saga, iris, vera/hera and the demi forge ide ... entitlement
 * gated and permissioned to me as platform owner"). Each is an AitherOS Online app, so a
 * row opens it in the pinned Online tab (app.aitherium.com/?spawn=<id>), signed in as
 * the desk's account. The PLATFORM gates each one (ACTA / sign-in / owner, Veil
 * app-permissions); the desk only refuses an id not on this list.
 */
const AGENT_APPS = Object.freeze([
  Object.freeze({ app: "aitherchat", label: "Aither", hint: "Talk to Aither" }),
  Object.freeze({ app: "aeon", label: "Aeon", hint: "Agent group chat: the council" }),
  Object.freeze({ app: "demi", label: "Demi", hint: "Code that builds itself" }),
  Object.freeze({ app: "forge", label: "Forge", hint: "Demi's IDE: describe it, watch it build" }),
  Object.freeze({ app: "builder", label: "Iris", hint: "Tell her what should exist" }),
  Object.freeze({ app: "atlas", label: "Atlas", hint: "Plan anything" }),
  Object.freeze({ app: "atlas-pm", label: "Atlas PM", hint: "Expeditions, board, agents" }),
  Object.freeze({ app: "lyra", label: "Lyra", hint: "Research with receipts" }),
  Object.freeze({ app: "saga", label: "Saga", hint: "Stories and video" }),
  Object.freeze({ app: "vera", label: "Vera", hint: "The librarian writes" }),
  Object.freeze({ app: "hera", label: "Hera", hint: "The wire: live news" }),
]);

/**
 * Spaces and sprites (owner, 2026-10-04: "integrating with aither spaces / retro spaces
 * / myspace + sprites so people can grow their personal agent sprites visibly ... create
 * and customize their own sprite avatars or choose premade ones from the VRoid store").
 * Online apps, opened the same way as the agent apps. The desk's own Characters page
 * (VRoid Hub and the market) and Stage sit beside them in the Stage section.
 */
const SPACE_APPS = Object.freeze([
  Object.freeze({ app: "spaces", label: "AitherSpaces", hint: "Friends, agents, rooms: the neighborhood" }),
  Object.freeze({ app: "myspace", label: "My Space", hint: "Your Space and every public one" }),
  Object.freeze({ app: "homestead", label: "Homestead", hint: "Your own site" }),
  Object.freeze({ app: "sprite", label: "Sprite", hint: "Hatch it, teach it, watch it grow" }),
  Object.freeze({ app: "persona", label: "Avatar", hint: "Make and dress your avatar" }),
]);

/**
 * Network and platform (owner, 2026-10-04: "aithermesh / aithernet home LAN and
 * distributed fleet management + lockbox and aithertunnel / secure tunnels + licenses,
 * apps / agent packs"). Online apps, platform-gated (Control and Admin are owner/RBAC).
 */
const PLATFORM_APPS = Object.freeze([
  Object.freeze({ app: "control", label: "Aither Control", hint: "Your devices, lending and models (owner only)" }),
  Object.freeze({ app: "fleet", label: "Mission Control", hint: "Agents, endpoints, labs: the command deck" }),
  Object.freeze({ app: "netmon", label: "Network", hint: "Live health: is it reachable" }),
  Object.freeze({ app: "tunnel", label: "Tunnel", hint: "Your machines: shell, VPN, containers" }),
  Object.freeze({ app: "lockbox", label: "Lockbox", hint: "Secrets, keys, tokens: your vault" }),
  Object.freeze({ app: "connections", label: "Connections", hint: "GitHub, chat channels, keys, sign-in" }),
  Object.freeze({ app: "services", label: "Services", hint: "Where your services run" }),
  Object.freeze({ app: "marketplace", label: "Packs & licenses", hint: "Agent packs, powers and apps" }),
  Object.freeze({ app: "shop", label: "Shop", hint: "Buy agents, studios, packs" }),
  Object.freeze({ app: "admin", label: "Platform Admin", hint: "The admin suite (RBAC-gated)" }),
]);

/**
 * The workspace (owner, 2026-10-04: "the old /workspace surface / UI / apps =
 * BusinessPilot + Aitherium managed agents + ... + local fleet config + MDM for
 * phones / tablets / laptops ... anything that runs awdk"). Pages of the signed-in
 * Workspace (app.aitherium.com), opened in the pinned Workspace tab. Paths are a fixed
 * list; the workspace's own auth decides what each shows.
 */
const WORKSPACE_PAGES = Object.freeze([
  Object.freeze({ path: "/workspace/business", label: "BusinessPilot", hint: "Your business, run by agents" }),
  Object.freeze({ path: "/workspace/agents", label: "Managed agents", hint: "Your Aitherium-managed agents" }),
  Object.freeze({ path: "/workspace/fleet", label: "Fleet instances", hint: "Your agent fleet: instances and telemetry" }),
  Object.freeze({ path: "/workspace/fleet/provision", label: "Provision", hint: "Stand up a new instance" }),
  Object.freeze({ path: "/workspace/nodes", label: "Nodes", hint: "Every machine running awdk" }),
  Object.freeze({ path: "/workspace/infrastructure", label: "Infrastructure", hint: "Nodes, tunnels, the stack" }),
  Object.freeze({ path: "/settings/connected-devices", label: "Devices", hint: "Phones, tablets and laptops you connected" }),
  Object.freeze({ path: "/settings/wallet", label: "Wallet", hint: "Link your Solana wallet (you sign; no key leaves it)" }),
  Object.freeze({ path: "/workspace/self-host", label: "Self-host", hint: "Run it on your own machines" }),
  Object.freeze({ path: "/workspace/packs/licenses", label: "Licenses", hint: "Your packs and licenses" }),
  Object.freeze({ path: "/workspace/skills", label: "Skills", hint: "Installed, learned and community skills" }),
  Object.freeze({ path: "/workspace/routines", label: "Routines", hint: "What runs on a schedule" }),
  Object.freeze({ path: "/workspace/runs", label: "Runs", hint: "Every agent run" }),
  Object.freeze({ path: "/workspace/members", label: "Members", hint: "People in your workspace" }),
]);

/**
 * Security (owner, 2026-10-04: "aitherfirewall / sentinel / sentry / chaos + awfirewall /
 * awtunnel"). Sentry is an Online app; Chaos is a page of the signed-in site. The firewall
 * and tunnel BRICKS (awwall, awtunnel) are on the Bricks page with the rest of the stack.
 */
const SECURITY_APPS = Object.freeze([
  Object.freeze({ app: "sentry", label: "Sentry", hint: "The watchtower: threats, live" }),
]);
const SECURITY_PAGES = Object.freeze([
  Object.freeze({ path: "/chaos", label: "Chaos", hint: "Chaos drills: break it on purpose, watch it heal" }),
]);

/**
 * Observability, the owner's (owner, 2026-10-04: "tunnel / pulse / grafana integrated for
 * my entitlements"). Grafana and Prometheus run on THIS machine's fleet, on loopback, and
 * open as web tabs; Pulse is the desk's plane page; Tunnel is the Online app. The whole
 * section is shown only when the desk is linked as the platform owner (adk link role).
 */
const OWNER_LOCAL = Object.freeze([
  Object.freeze({ url: "http://127.0.0.1:3002/", label: "Grafana", hint: "Live dashboards: models, tools, GPU, end to end" }),
  Object.freeze({ url: "http://127.0.0.1:9090/prometheus/", label: "Prometheus", hint: "Every scrape target and series" }),
]);

/**
 * Command & control, the platform owner's (owner, 2026-10-04: "command / control all of
 * my platform tenants / customer workspaces / users -- moderate my community and support /
 * feedback in one place, integrated with forums + AitherRelay"). Pages of the signed-in
 * site; shown, and opened, only when the desk is linked as owner -- and the site's own
 * RBAC still decides each page.
 */
const ADMIN_PAGES = Object.freeze([
  Object.freeze({ path: "/admin/tenants", label: "Tenants", hint: "Every customer workspace" }),
  Object.freeze({ path: "/admin/users", label: "Users", hint: "Every account" }),
  Object.freeze({ path: "/admin/entitlements", label: "Entitlements", hint: "Who may use what" }),
  Object.freeze({ path: "/admin/licensing", label: "Licensing", hint: "Licenses and packs" }),
  Object.freeze({ path: "/admin/moderation", label: "Moderation", hint: "Reports, boards, community" }),
  Object.freeze({ path: "/support", label: "Support & feedback", hint: "Tickets and feedback in one place" }),
  Object.freeze({ path: "/forum", label: "Forums", hint: "The community boards" }),
  Object.freeze({ path: "/relay", label: "Relay", hint: "AitherRelay: channels, DMs, rooms" }),
  Object.freeze({ path: "/admin/marketplace/review", label: "Marketplace review", hint: "Packs and apps waiting for review" }),
  Object.freeze({ path: "/admin/registrations", label: "Registrations", hint: "New sign-ups" }),
  Object.freeze({ path: "/admin/security", label: "Security", hint: "Platform security posture" }),
  Object.freeze({ path: "/admin/platform", label: "Platform", hint: "The platform admin home" }),
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

function isAgentApp(id) {
  const want = String(id || "");
  return [AGENT_APPS, SPACE_APPS, PLATFORM_APPS, SECURITY_APPS].some((list) => list.some((a) => a.app === want));
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
 * Every rail row, grouped. A row is either a PAGE (opens aither://<id>) or a
 * COMMAND (an id from RAIL_COMMANDS). Panes that live as a tab of another pane
 * (`tabOf`) stay rows: the console hid them behind a tab, and that is exactly
 * the "where is it" the owner hit.
 *
 * @param {Array<object>} panes console-window.cjs PANES
 * @param {{activePane?: string|null}} [opts]
 */
function railSections(panes, { activePane = null, signedIn = true, owner = false } = {}) {
  const groups = new Map();
  const add = (name, row) => {
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  };
  for (const pane of panes || []) {
    if (!pane || typeof pane.id !== "string") continue;
    add(pane.section || "More", {
      kind: "page", id: pane.id, label: pane.label || pane.id, hint: pane.hint || "",
      icon: pane.icon || null, active: pane.id === activePane,
    });
  }
  for (const v of VOICE_ROWS) add("Voice", { ...v, icon: null, active: false });
  for (const app of APP_ROWS) {
    add("Apps", { kind: "command", id: app.command, label: app.label, hint: app.hint, icon: app.icon, active: false });
  }
  const online = (section, apps) => {
    for (const a of apps) {
      add(section, { kind: "online", id: a.app, label: a.label,
        hint: signedIn ? a.hint : `${a.hint} (sign in to AitherOS Online first)`, icon: null, active: false,
        locked: !signedIn });
    }
  };
  online("Agent apps", AGENT_APPS);
  online("Spaces & sprites", SPACE_APPS);
  online("Platform", PLATFORM_APPS);
  const pages = (section, list) => {
    for (const w of list) {
      add(section, { kind: "workspace", id: w.path, label: w.label,
        hint: signedIn ? w.hint : `${w.hint} (sign in to AitherOS Online first)`, icon: null, active: false, locked: !signedIn });
    }
  };
  pages("Workspace", WORKSPACE_PAGES);
  online("Security", SECURITY_APPS);
  pages("Security", SECURITY_PAGES);
  if (owner) {
    for (const a of ADMIN_PAGES) add("Command & control", { kind: "workspace", id: a.path, label: a.label, hint: a.hint, icon: null, active: false });
    for (const o of OWNER_LOCAL) add("Observability", { kind: "local", id: o.url, label: o.label, hint: o.hint, icon: null, active: false });
    add("Observability", { kind: "page", id: "pulse", label: "Pulse", hint: "Heartbeat and disk headroom", icon: "activity", active: activePane === "pulse" });
    add("Observability", { kind: "online", id: "tunnel", label: "Tunnel", hint: "Your machines: shell, VPN, containers", icon: null, active: false });
  }
  const names = [...groups.keys()];
  const ordered = [...SECTION_ORDER.filter((n) => groups.has(n)), ...names.filter((n) => !SECTION_ORDER.includes(n))];
  return ordered.map((name) => ({ name, rows: groups.get(name) }));
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
    // AitherOS Online drawn over web pages (browser-overlay.cjs): off until asked for.
    overlay: r.overlay === true,
    collapsedSections: Array.isArray(r.collapsedSections)
      ? [...new Set(r.collapsedSections.filter((n) => typeof n === "string" && n.length <= 40))].slice(0, 20) : [],
  };
}

function railWidth(collapsed, width = RAIL_WIDTH) {
  return collapsed ? RAIL_COLLAPSED_WIDTH : clamp(width, RAIL_MIN, RAIL_MAX, RAIL_WIDTH);
}

/**
 * Where every view goes inside the window's content area.
 *
 *   rail | gutter | page | gutter | panel     (top: chrome, bottom: taskbar)
 *
 * The gutters are the chrome page's own pixels: the drag handles live there.
 *
 * @param {{width: number, height: number}} content the window's content size
 */
function railLayout(content, { collapsed = false, docked = false, chromeHeight, panelWidth = 340,
  railWidth: wantRail = RAIL_WIDTH, panelCollapsed = false, taskbarHeight = 0 }) {
  const width = Math.max(0, Math.floor(content.width || 0));
  const height = Math.max(0, Math.floor(content.height || 0));
  const railW = Math.min(railWidth(collapsed, wantRail), width);
  const rest = Math.max(0, width - railW - GUTTER);
  const panelW = panelCollapsed ? 0 : Math.min(clamp(panelWidth, PANEL_MIN, PANEL_MAX, 340), Math.floor(rest / 2));
  const taskH = Math.min(Math.max(0, taskbarHeight), Math.max(0, height - chromeHeight));
  const bodyH = Math.max(0, height - chromeHeight - taskH);
  const pageX = railW + GUTTER;
  const pageW = Math.max(0, width - pageX - (panelW ? panelW + GUTTER : 0));
  return {
    rail: { x: 0, y: 0, width: railW, height: height - taskH },
    page: { x: pageX, y: chromeHeight, width: pageW, height: bodyH },
    panel: { x: width - panelW, y: chromeHeight, width: panelW, height: bodyH },
    taskbar: { x: 0, y: height - taskH, width, height: taskH },
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
  normalizeLayout,
  APP_ROWS,
  AVATAR_SLOT_HEIGHT,
  BRAND_HEIGHT,
  LAYERS,
  LAYERS_HEIGHT,
  RAIL_COLLAPSED_WIDTH,
  RAIL_COMMANDS,
  RAIL_WIDTH,
  SECTION_ORDER,
  avatarSlot,
  avatarSlotRect,
  layerRows,
  railLayout,
  railMayRun,
  isSearchText,
  railSections,
  railWidth,
};
