"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const rail = require("./browser-rail.cjs");
const { PANES } = require("./console-window.cjs");
const registry = require("./command-registry.cjs");
const chromeHtml = require("node:fs").readFileSync(require("node:path").join(__dirname, "browser-chrome.html"), "utf8");

test("every console pane is a rail row: nothing collapsed into the browser is unreachable", () => {
  const rows = rail.railSections(PANES).flatMap((sec) => sec.rows);
  for (const pane of PANES) {
    assert.ok(rows.some((row) => row.kind === "page" && row.id === pane.id), `${pane.id} has no rail row`);
  }
});

test("sections read in the declared order; Apps carries the OS apps as commands", () => {
  const names = rail.railSections(PANES).map((sec) => sec.name);
  const declared = rail.SECTION_ORDER.filter((name) => names.includes(name));
  assert.deepEqual(names.slice(0, declared.length), declared);
  const apps = rail.railSections(PANES).find((sec) => sec.name === "Apps");
  assert.deepEqual(apps.rows.map((row) => row.id), rail.APP_ROWS.map((row) => row.command));
  assert.ok(apps.rows.every((row) => row.kind === "command"));
});

test("the active pane is marked, and only it", () => {
  const rows = rail.railSections(PANES, { activePane: "settings" }).flatMap((sec) => sec.rows);
  assert.deepEqual(rows.filter((row) => row.active).map((row) => row.id), ["settings"]);
});

test("the rail runs only its allowlisted commands, and each exists in the registry", () => {
  for (const id of rail.RAIL_COMMANDS) {
    assert.ok(rail.railMayRun(id));
    assert.ok(registry.byId(id), `${id} is not a registry command`);
  }
  for (const layer of rail.LAYERS) {
    if (layer.command) assert.ok(rail.railMayRun(layer.command), `layer ${layer.key} runs a command the rail refuses`);
    if (layer.page) assert.ok(PANES.some((pane) => pane.id === layer.page), `layer ${layer.key} opens a missing page`);
  }
  assert.equal(rail.railMayRun("quit"), false);
  assert.equal(rail.railMayRun("fleet.gaming"), false);
  assert.equal(rail.railMayRun(""), false);
});

test("the layers are the owner's stack, innermost first", () => {
  assert.deepEqual(rail.LAYERS.map((layer) => layer.key), ["shell", "avatar", "browser", "online"]);
  const rows = rail.layerRows({ docked: true, overlayVisible: false });
  assert.equal(rows.find((r) => r.key === "avatar").state, "docked");
  assert.equal(rows.find((r) => r.key === "online").on, false);
});

test("layout: rail | gutter | page | gutter | panel, never overlapping", () => {
  const G = rail.GUTTER;
  const r = rail.railLayout({ width: 1320, height: 880 }, { chromeHeight: 118, panelWidth: 340 });
  assert.deepEqual(r.rail, { x: 0, y: 0, width: 248, height: 880 });
  assert.equal(r.page.x, 248 + G);
  assert.equal(r.page.x + r.page.width + G, r.panel.x);
  assert.equal(r.panel.x + r.panel.width, 1320);
  assert.equal(r.page.y, 118);
  const c = rail.railLayout({ width: 1320, height: 880 }, { collapsed: true, chromeHeight: 118, panelWidth: 340 });
  assert.equal(c.page.x, rail.RAIL_COLLAPSED_WIDTH + G);
});

test("dragged widths are honoured and clamped; a collapsed panel gives the page its room", () => {
  const r = rail.railLayout({ width: 1600, height: 900 }, { chromeHeight: 118, railWidth: 320, panelWidth: 500 });
  assert.equal(r.rail.width, 320);
  assert.equal(r.panel.width, 500);
  const tiny = rail.railLayout({ width: 1600, height: 900 }, { chromeHeight: 118, railWidth: 5, panelWidth: 99999 });
  assert.equal(tiny.rail.width, rail.RAIL_MIN);
  assert.equal(tiny.panel.width, rail.PANEL_MAX);
  const off = rail.railLayout({ width: 1600, height: 900 }, { chromeHeight: 118, panelCollapsed: true });
  assert.equal(off.panel.width, 0);
  assert.equal(off.page.x + off.page.width, 1600);
});

test("the taskbar takes the bottom strip, full width; the rail and pages end above it", () => {
  const r = rail.railLayout({ width: 1320, height: 880 }, { chromeHeight: 118, taskbarHeight: rail.TASKBAR_HEIGHT });
  assert.deepEqual(r.taskbar, { x: 0, y: 880 - rail.TASKBAR_HEIGHT, width: 1320, height: rail.TASKBAR_HEIGHT });
  assert.equal(r.page.y + r.page.height, r.taskbar.y);
  assert.equal(r.rail.height, r.taskbar.y);
});

test("a hand-edited layout file cannot wedge the window", () => {
  assert.deepEqual(rail.normalizeLayout({ railWidth: "abc", panelWidth: -4, collapsedSections: [1, "Apps", "Apps"] }),
    { railWidth: rail.RAIL_WIDTH, panelWidth: rail.PANEL_MIN, railCollapsed: false, panelCollapsed: false,
      taskbar: true, overlay: false, collapsedSections: ["Apps"] });
  assert.equal(rail.normalizeLayout({ railWidth: null }).railWidth, rail.RAIL_WIDTH, "reset means default, not minimum");
  assert.equal(rail.normalizeLayout({ taskbar: false }).taskbar, false);
  assert.equal(rail.normalizeLayout({ overlay: "yes" }).overlay, false, "on only when exactly true");
});

test("the avatar slot follows a dragged rail width", () => {
  const slot = rail.avatarSlot({ height: 1000 }, { docked: true, railWidth: 340 });
  assert.equal(slot.width, 340);
  assert.ok(slot.height > rail.AVATAR_SLOT_HEIGHT, "a wider rail is a bigger body");
});

test("the avatar slot exists only docked, expanded and tall enough", () => {
  assert.equal(rail.avatarSlot({ height: 880 }, { docked: false }), null);
  assert.equal(rail.avatarSlot({ height: 880 }, { docked: true, collapsed: true }), null);
  assert.deepEqual(rail.avatarSlot({ height: 880 }, { docked: true }),
    { x: 0, y: rail.BRAND_HEIGHT, width: rail.RAIL_WIDTH, height: rail.AVATAR_SLOT_HEIGHT });
  const short = rail.avatarSlot({ height: 480 }, { docked: true });
  assert.ok(short && short.height < rail.AVATAR_SLOT_HEIGHT && short.height >= 160);
  assert.equal(rail.avatarSlot({ height: 300 }, { docked: true }), null);
});

test("the slot rect is in screen space: the content origin plus the slot offset", () => {
  const rect = rail.avatarSlotRect({ x: 100, y: 50, width: 1320, height: 880 }, { docked: true });
  assert.deepEqual(rect, { x: 100, y: 50 + rail.BRAND_HEIGHT, width: rail.RAIL_WIDTH, height: rail.AVATAR_SLOT_HEIGHT });
  assert.equal(rail.avatarSlotRect(null, { docked: true }), null);
});

test("the chrome page's rail matches the module's sizes", () => {
  assert.match(chromeHtml, new RegExp(`--rail-w: ${rail.RAIL_WIDTH}px`));
  assert.match(chromeHtml, new RegExp(`\\.brand \\{ height: ${rail.BRAND_HEIGHT}px`));
  assert.match(chromeHtml, new RegExp(`#layers \\{[^}]*height: ${rail.LAYERS_HEIGHT}px`));
  for (const action of ["drag", "rail-width", "panel-width", "panel", "taskbar", "section", "reset-layout"]) {
    assert.ok(chromeHtml.includes(`"${action}"`), `the chrome never sends ${action}`);
  }
  // Labels are text, never markup: a pane label cannot inject into the chrome.
  assert.doesNotMatch(chromeHtml, /l\.innerHTML|name\.innerHTML|st\.innerHTML/);
});

test("agent apps: every one the owner named, as Online rows, locked when signed out", () => {
  const ids = rail.AGENT_APPS.map((a) => a.app);
  for (const want of ["aitherchat", "aeon", "demi", "forge", "builder", "atlas", "atlas-pm", "lyra", "saga", "vera", "hera"]) {
    assert.ok(ids.includes(want), `${want} missing`);
  }
  const sec = rail.railSections(PANES, { signedIn: false }).find((s) => s.name === "Agent apps");
  assert.ok(sec.rows.every((r) => r.kind === "online" && r.locked));
  assert.ok(rail.railSections(PANES).find((s) => s.name === "Agent apps").rows.every((r) => !r.locked));
  assert.equal(rail.isAgentApp("aeon"), true);
  assert.equal(rail.isAgentApp("darkmatters"), false, "only the listed apps; the platform gates the rest anyway");
  assert.equal(rail.isAgentApp("../x"), false);
});

test("spaces & sprites: the owner's list, opened through Online like the agent apps", () => {
  const ids = rail.SPACE_APPS.map((a) => a.app);
  for (const want of ["spaces", "myspace", "homestead", "sprite", "persona"]) assert.ok(ids.includes(want), want);
  const sec = rail.railSections(PANES).find((s) => s.name === "Spaces & sprites");
  assert.deepEqual(sec.rows.map((r) => r.id), ids);
  assert.ok(ids.every((id) => rail.isAgentApp(id)), "the rail may open each of them");
  const names = rail.railSections(PANES).map((s) => s.name);
  assert.ok(names.indexOf("Spaces & sprites") < names.indexOf("Stage"), "beside Stage (Characters: VRoid + market)");
});

test("network & platform: mesh, fleet, lockbox, tunnels, packs -- Online apps, platform-gated", () => {
  const ids = rail.PLATFORM_APPS.map((a) => a.app);
  for (const want of ["control", "fleet", "netmon", "tunnel", "lockbox", "marketplace", "admin"]) assert.ok(ids.includes(want), want);
  assert.ok(ids.every((id) => rail.isAgentApp(id)));
  assert.ok(rail.railSections(PANES).some((s) => s.name === "Platform"));
});

test("workspace: BusinessPilot, managed agents, fleet, nodes, devices -- fixed paths on the signed-in workspace", () => {
  const paths = rail.WORKSPACE_PAGES.map((w) => w.path);
  for (const want of ["/workspace/business", "/workspace/agents", "/workspace/fleet", "/workspace/nodes", "/settings/connected-devices", "/settings/wallet"]) {
    assert.ok(paths.includes(want), want);
  }
  assert.ok(paths.every((p) => /^\/[a-z/-]+$/.test(p)), "plain same-site paths only");
  assert.equal(rail.isWorkspacePage("https://evil.test/"), false);
  assert.equal(rail.isWorkspacePage("/workspace/secrets"), false, "only the listed pages");
  const sec = rail.railSections(PANES).find((s) => s.name === "Workspace");
  assert.ok(sec && sec.rows.every((r) => r.kind === "workspace"));
});

test("security: Sentry (Online app) and Chaos (site page) in one section", () => {
  const sec = rail.railSections(PANES).find((s) => s.name === "Security");
  assert.deepEqual(sec.rows.map((r) => [r.kind, r.id]), [["online", "sentry"], ["workspace", "/chaos"]]);
  assert.equal(rail.isAgentApp("sentry"), true);
  assert.equal(rail.isWorkspacePage("/chaos"), true);
});

test("observability is the owner's only: Grafana, Prometheus, Pulse, Tunnel", () => {
  assert.equal(rail.railSections(PANES).some((s) => s.name === "Observability"), false, "hidden unless owner");
  const sec = rail.railSections(PANES, { owner: true }).find((s) => s.name === "Observability");
  assert.deepEqual(sec.rows.map((r) => r.label), ["Grafana", "Prometheus", "Pulse", "Tunnel"]);
  assert.ok(rail.OWNER_LOCAL.every((o) => /^http:\/\/127\.0\.0\.1:\d+\//.test(o.url)), "loopback only");
  assert.equal(rail.isOwnerLocal("http://127.0.0.1:3002/"), true);
  assert.equal(rail.isOwnerLocal("http://evil.test/"), false);
});

test("command & control: tenants, people, moderation, support+forums, relay -- owner only", () => {
  assert.equal(rail.railSections(PANES).some((s) => s.name === "Command & control"), false);
  const sec = rail.railSections(PANES, { owner: true }).find((s) => s.name === "Command & control");
  const paths = sec.rows.map((r) => r.id);
  for (const want of ["/mission-control?tab=tenants", "/mission-control?tab=tenants&view=users",
    "/mission-control?tab=moderation&view=spaces", "/?channel=people&board=support", "/relay"]) assert.ok(paths.includes(want), want);
  assert.equal(rail.isAdminPage("/mission-control?tab=tenants"), true);
  assert.equal(rail.isWorkspacePage("/mission-control?tab=tenants"), false, "never through the member path");
});

test("command & control rows open the page that renders, never a retired /admin/* redirect", () => {
  for (const a of rail.ADMIN_PAGES) {
    assert.ok(!/^\/admin\//.test(a.path), `${a.label}: ${a.path} is a retired redirect`);
    assert.ok(!["/support", "/forum"].includes(a.path), `${a.label}: support and forums are one surface`);
  }
  const labels = rail.ADMIN_PAGES.map((a) => a.label);
  assert.equal(labels.filter((l) => /forum/i.test(l)).length, 1, "one support & forums row");
  assert.equal(new Set(rail.ADMIN_PAGES.map((a) => a.path)).size, rail.ADMIN_PAGES.length, "no duplicate targets");
});

test("the Online layer: over pages, or detached onto the desktop; either reads on", () => {
  const row = (o) => rail.layerRows(o).find((l) => l.key === "online");
  assert.equal(row({}).on, false);
  assert.deepEqual([row({ overPages: true }).on, row({ overPages: true }).state], [true, "over pages"]);
  assert.deepEqual([row({ overlayVisible: true }).on, row({ overlayVisible: true }).state], [true, "around you"]);
  assert.equal(row({}).detach, "overlay-detach");
});
