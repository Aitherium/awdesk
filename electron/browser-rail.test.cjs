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
      taskbar: true, dock: true, dockOpen: false, dockHeight: rail.DOCK_HEIGHT, overlay: false,
      collapsedSections: ["Apps"], launchModes: {}, agentCookieSites: [] });
  assert.equal(rail.normalizeLayout({ railWidth: null }).railWidth, rail.RAIL_WIDTH, "reset means default, not minimum");
  assert.equal(rail.normalizeLayout({ taskbar: false }).taskbar, false);
  assert.equal(rail.normalizeLayout({ overlay: "yes" }).overlay, false, "on only when exactly true");
});

test("the terminal dock sits under page and panel, above the taskbar, behind a gutter", () => {
  const G = rail.GUTTER;
  const r = rail.railLayout({ width: 1320, height: 880 }, { chromeHeight: 118, panelWidth: 340,
    taskbarHeight: rail.TASKBAR_HEIGHT, dockHeight: 300 });
  assert.deepEqual(r.dock, { x: r.page.x, y: 880 - rail.TASKBAR_HEIGHT - 300, width: 1320 - r.page.x, height: 300 });
  assert.equal(r.page.y + r.page.height + G, r.dock.y, "the gutter between page and dock is the drag handle");
  assert.equal(r.panel.height, r.page.height, "the panel ends above the dock too");
  assert.equal(r.dock.y + r.dock.height, r.taskbar.y);
  assert.equal(r.rail.height, r.taskbar.y, "the rail keeps its full height");
  const none = rail.railLayout({ width: 1320, height: 880 }, { chromeHeight: 118 });
  assert.equal(none.dock.height, 0);
  assert.equal(none.page.height, 880 - 118, "no dock, no gutter");
});

test("a dock dragged too tall gives way to the page; the strip always fits", () => {
  const r = rail.railLayout({ width: 1000, height: 700 }, { chromeHeight: 118, dockHeight: 5000 });
  assert.equal(r.page.height, rail.PAGE_MIN_HEIGHT);
  assert.equal(r.dock.height, 700 - 118 - rail.GUTTER - rail.PAGE_MIN_HEIGHT);
  const short = rail.railLayout({ width: 1000, height: 200 }, { chromeHeight: 118, dockHeight: 400 });
  assert.equal(short.dock.height, rail.DOCK_STRIP_HEIGHT, "a short window still shows the strip");
  assert.ok(short.page.height >= 0);
});

test("dock height: off, strip when closed, the dragged height when open (persisted, clamped)", () => {
  assert.equal(rail.dockHeightFor({ dock: false, dockOpen: true }), 0);
  assert.equal(rail.dockHeightFor({ dockOpen: false, dockHeight: 500 }), rail.DOCK_STRIP_HEIGHT);
  assert.equal(rail.dockHeightFor({ dockOpen: true, dockHeight: 500 }), 500);
  assert.equal(rail.dockHeightFor({ dockOpen: true, dockHeight: 3 }), rail.DOCK_MIN);
  const saved = rail.normalizeLayout({ dockOpen: true, dockHeight: 444 });
  assert.equal(saved.dockOpen, true);
  assert.equal(saved.dockHeight, 444);
  assert.equal(rail.normalizeLayout({ dockHeight: "x" }).dockHeight, rail.DOCK_HEIGHT);
  assert.equal(rail.normalizeLayout({ dockOpen: "yes" }).dockOpen, false, "open only when exactly true");
  assert.equal(rail.normalizeLayout({ dock: false }).dock, false);
});

test("dragging the dock's top edge: up opens it at that height, down past the strip closes it", () => {
  assert.deepEqual(rail.dockHeightFromDrag(500, { height: 880, taskbarHeight: 56 }), { dockOpen: true, dockHeight: 324 });
  assert.deepEqual(rail.dockHeightFromDrag(820, { height: 880, taskbarHeight: 56 }), { dockOpen: false });
  assert.deepEqual(rail.dockHeightFromDrag(-9000, { height: 880 }), { dockOpen: true, dockHeight: rail.DOCK_MAX });
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

test("the rail has NINE sections, one per destination, in the plan's order", () => {
  const names = rail.railSections(PANES).map((sec) => sec.name);
  assert.deepEqual(names, rail.DESTINATION_ORDER
    .filter((id) => names.includes(rail.DESTINATIONS.find((d) => d.id === id).label))
    .map((id) => rail.DESTINATIONS.find((d) => d.id === id).label));
  // ...and never a heading the plan does not name. The 16 ad-hoc heads of 2026-10-29
  // ("Observability" AND "Planes", "Agent apps" AND "Spaces & sprites") are gone.
  const allowed = new Set(rail.DESTINATIONS.map((d) => d.label));
  for (const name of names) assert.ok(allowed.has(name), `${name} is not one of the nine destinations`);
  assert.equal(names.length, 9, "every destination carries at least one row");
});

test("no destination is listed twice: no row opens what another row opens", () => {
  const seen = new Map();
  for (const sec of rail.railSections(PANES, { owner: true })) {
    for (const row of sec.rows) {
      for (const key of rail.railRowKeys(row)) {
        const prev = seen.get(key);
        assert.equal(prev, undefined, `${row.label} (${row.id}) duplicates ${prev} -- key ${key}`);
        seen.set(key, `${sec.name}/${row.label}`);
      }
    }
  }
});

test("the dedupe CAN fail: two rows opening the same window collide", () => {
  // The check above is only worth a gate if it can be shown to fail, so the key
  // function is exercised on the pair the owner actually saw: "Tunnel" twice.
  const a = { kind: "online", id: "tunnel", canonical: "tunnel", label: "Tunnel", destination: "platform" };
  const b = { kind: "online", id: "tunnel", canonical: "tunnel", label: "Tunnel", destination: "network" };
  assert.deepEqual(rail.railRowKeys(a).filter((k) => rail.railRowKeys(b).includes(k)), [
    "online:tunnel",
  ]);
  // ...and the alias form: five rows, one Agents window.
  const alias = { kind: "online", id: "lyra", canonical: "agents", label: "Lyra", destination: "agents" };
  const canon = { kind: "online", id: "agents", canonical: "agents", label: "Agents", destination: "agents" };
  assert.ok(rail.railRowKeys(alias).includes("online:agents"));
  assert.ok(rail.railRowKeys(alias).some((k) => rail.railRowKeys(canon).includes(k)));
});

test("every pane is reachable and filed under a destination", () => {
  for (const sec of rail.railSections(PANES)) {
    for (const row of sec.rows) assert.ok(row.destination, `${row.id} has no destination`);
  }
  const rows = rail.railSections(PANES).flatMap((sec) => sec.rows);
  const ids = new Set(rows.filter((r) => r.kind === "page").map((r) => r.id));
  for (const pane of PANES) assert.ok(ids.has(pane.id), `${pane.id} has no rail row`);
});

test("the OS apps are commands, filed where their app is filed", () => {
  const all = rail.railSections(PANES).flatMap((sec) => sec.rows);
  const commands = all.filter((r) => r.kind === "command" && r.id.startsWith("osapp."));
  // An OS app command that targets a window the rail already carries is COLLAPSED
  // (same destination, same label): Sprite the command and Sprite the Online app are
  // one row. Every command is therefore either present, or covered by that row.
  for (const row of rail.OS_APP_ROWS) {
    const present = commands.some((r) => r.id === row.command);
    const covered = all.some((r) => r.id !== row.command && r.destination === rail.destinationOf(row.app)
      && String(r.label).toLowerCase() === row.label.toLowerCase());
    assert.ok(present || covered, `${row.command} is neither on the rail nor collapsed into an equal row`);
  }
  for (const row of commands) {
    assert.ok(["platform", "know", "create", "worlds"].includes(row.destination), `${row.id}: ${row.destination}`);
  }
});

test("agent apps: the Agents window and its doors, as Online rows, locked when signed out", () => {
  const ids = rail.AGENT_APPS.map((a) => a.app);
  for (const want of ["agents", "builder", "saga"]) assert.ok(ids.includes(want), `${want} missing`);
  // lyra/atlas/vera/hera/demi are ALIASES of agents: they must route, never render.
  for (const alias of ["lyra", "atlas", "vera", "hera", "demi"]) {
    assert.equal(ids.includes(alias), false, `${alias} is an alias and must not be a second row`);
    assert.equal(rail.canonicalId(alias), "agents");
  }
  const sec = rail.railSections(PANES, { signedIn: false }).find((s) => s.name === "Agents");
  assert.ok(sec.rows.filter((r) => r.kind === "online").every((r) => r.locked));
  assert.ok(rail.railSections(PANES).find((s) => s.name === "Agents").rows.filter((r) => r.kind === "online").every((r) => !r.locked));
  assert.equal(rail.isAgentApp("aeon"), true);
  assert.equal(rail.isAgentApp("lyra"), true, "an old id still launches (it resolves to agents)");
  assert.equal(rail.isAgentApp("calculator"), false, "only the rail's catalogue; the launcher has the rest");
  assert.equal(rail.isAgentApp("../x"), false);
});

test("worlds: spaces, the mesh and the games, opened through Online", () => {
  const ids = rail.SPACE_APPS.map((a) => a.app);
  for (const want of ["spaces", "homestead", "beadspace", "darkmatters", "gobbonet"]) assert.ok(ids.includes(want), want);
  assert.ok(ids.every((id) => rail.isAgentApp(id)), "the rail may open each of them");
  const sec = rail.railSections(PANES).find((s) => s.name === "Worlds");
  assert.ok(sec.rows.some((r) => r.kind === "page" && r.id === "space"), "the BeadSpace pane sits with them");
});

test("platform: fleet, tunnels, vault, packs, admin -- one section, not four", () => {
  const ids = rail.PLATFORM_APPS.map((a) => a.app);
  for (const want of ["control", "fleet", "netmon", "tunnel", "lockbox", "shop", "admin", "sentry"]) assert.ok(ids.includes(want), want);
  assert.ok(ids.every((id) => rail.isAgentApp(id)));
  assert.ok(rail.railSections(PANES).some((s) => s.name === "Platform"));
});

test("workspace: BusinessPilot, managed agents, fleet, nodes, devices -- fixed paths on the signed-in workspace", () => {
  const paths = rail.WORKSPACE_PAGES.map((w) => w.path);
  for (const want of ["/workspace/business", "/workspace/agents", "/workspace/fleet", "/workspace/nodes", "/settings/connected-devices", "/settings/wallet"]) {
    assert.ok(paths.includes(want), want);
  }
  assert.ok(paths.every((p) => /^\/[a-z/?.=&-]+$/.test(p)), "plain same-site paths only");
  assert.equal(rail.isWorkspacePage("https://evil.test/"), false);
  assert.equal(rail.isWorkspacePage("/workspace/secrets"), false, "only the listed pages");
  const rows = rail.railSections(PANES).flatMap((s) => s.rows).filter((r) => r.kind === "workspace");
  assert.ok(rows.every((r) => r.kind === "workspace" && r.destination));
});

test("today: the Online Today window is the first section's door (U2)", () => {
  const sections = rail.railSections(PANES);
  assert.equal(sections[0].name, "Today");
  const row = sections[0].rows.find((r) => r.kind === "online" && r.id === "briefing");
  assert.ok(row, "the briefing window is a Today row");
  assert.equal(row.label, "Today");
  assert.equal(rail.isAgentApp("briefing"), true);
  const locked = rail.railSections(PANES, { signedIn: false })[0].rows.find((r) => r.id === "briefing");
  assert.equal(locked.locked, true, "signed out, the row says sign in first");
});

test("mail: a Workspace row opens the mail view's route-map door (MAIL-3)", () => {
  assert.equal(rail.isWorkspacePage("/workspace/mail"), true);
  const row = rail.railSections(PANES).flatMap((s) => s.rows).find((r) => r.label === "Mail");
  assert.ok(row, "a Mail row");
  assert.deepEqual([row.kind, row.id, row.destination], ["workspace", "/workspace/mail", "talk"]);
  const locked = rail.railSections(PANES, { signedIn: false }).flatMap((s) => s.rows).find((r) => r.label === "Mail");
  assert.equal(locked.locked, true, "signed out, the row says sign in first");
});

test("security: Sentry and Chaos sit in Platform with the rest of the admin", () => {
  const rows = rail.railSections(PANES).find((s) => s.name === "Platform").rows;
  assert.ok(rows.some((r) => r.kind === "online" && r.id === "sentry"));
  assert.ok(rows.some((r) => r.kind === "workspace" && r.id === "/chaos"));
  assert.equal(rail.isAgentApp("sentry"), true);
  assert.equal(rail.isWorkspacePage("/chaos"), true);
});

test("the owner's loopback pages are Platform rows, and only for the owner", () => {
  assert.ok(rail.OWNER_LOCAL.every((o) => /^http:\/\/127\.0\.0\.1:\d+\//.test(o.url)), "loopback only");
  const open = rail.railSections(PANES).flatMap((s) => s.rows);
  assert.equal(open.some((r) => r.kind === "local"), false, "hidden unless owner");
  const labels = rail.railSections(PANES, { owner: true }).find((s) => s.name === "Platform").rows
    .filter((r) => r.kind === "local").map((r) => r.label);
  assert.deepEqual(labels, ["Grafana", "Prometheus"]);
  assert.equal(rail.isOwnerLocal("http://127.0.0.1:3002/"), true);
  assert.equal(rail.isOwnerLocal("http://evil.test/"), false);
});

test("command & control: tenants, people, moderation, support+forums, relay -- owner only, one section", () => {
  const adminRows = () => rail.railSections(PANES, { owner: true }).flatMap((s) => s.rows)
    .filter((r) => rail.isAdminPage(r.id)).map((r) => r.id);
  const paths = adminRows();
  for (const want of ["/mission-control?tab=tenants", "/mission-control?tab=tenants&view=users",
    "/mission-control?tab=moderation&view=spaces", "/?channel=people&board=support"]) assert.ok(paths.includes(want), want);
  // /relay is an ADMIN row AND the Online Relay app: one destination, so one row. The
  // Online app wins (it is the richer surface); the page still routes.
  assert.equal(paths.includes("/relay"), false, "collapsed into the Relay app row");
  assert.ok(rail.isAdminPage("/relay"), "still routable");
  assert.equal(rail.railSections(PANES).flatMap((s) => s.rows).some((r) => rail.isAdminPage(r.id)), false, "not for a member");
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

test("the panel grip starts where the chrome ends, never at a hard-coded height", () => {
  // The chrome shrank 118 -> 78 when the agent banner became a toolbar dot; a literal
  // top left the panel's grab strip 40px below the panel's top edge.
  const line = chromeHtml.split("\n").find((l) => l.includes("Object.assign(pg.style"));
  assert.ok(line, "placeGrips still positions the panel grip");
  assert.doesNotMatch(line, /top:\s*"\d+px"/);
  const r = rail.railLayout({ width: 1600, height: 900 }, { chromeHeight: 78, panelWidth: 360 });
  assert.equal(r.panel.y, 78);
});

/* ── the generated catalogue ───────────────────────────────────────────────
   AitherOS/dev/tools/gen_desk_apps.py writes desk-apps.generated.json from Veil.
   These are the two invariants it exists for; the Python tool's --check covers
   drift (a Veil edit not regenerated) and its --self-test proves its own checker
   can fail. */

const catalogue = require("./desk-apps.generated.json");

test("the catalogue files EVERY registry app exactly once (filed or aliased)", () => {
  const filed = new Set(catalogue.apps.map((a) => a.id));
  const duplicates = catalogue.apps.map((a) => a.id).filter((id, i, all) => all.indexOf(id) !== i);
  assert.deepEqual(duplicates, [], "an app is filed twice");
  for (const id of catalogue.registryIds) {
    assert.ok(filed.has(id) || catalogue.aliasTo[id], `${id} is neither filed nor an alias`);
  }
  // ...and an alias is never also a row: five agent ids, ONE Agents window.
  for (const alias of Object.keys(catalogue.aliasTo)) {
    assert.equal(filed.has(alias), false, `${alias} is an alias and must not be filed`);
  }
});

test("every destination is one of the nine, and the nine are the plan's", () => {
  const ids = catalogue.destinations.map((d) => d.id);
  assert.deepEqual(ids, ["today", "talk", "work", "know", "agents", "create", "worlds", "build", "platform"]);
  for (const app of catalogue.apps) assert.ok(ids.includes(app.destination), `${app.id}: ${app.destination}`);
  for (const pane of catalogue.panes) assert.ok(ids.includes(pane.destination), `${pane.id}: ${pane.destination}`);
});

test("no two apps in one destination share a label (what the rail renders)", () => {
  const seen = new Map();
  for (const app of catalogue.apps.filter((a) => a.rail)) {
    const key = `${app.destination}|${app.label.toLowerCase()}`;
    assert.equal(seen.get(key), undefined, `${app.id} and ${seen.get(key)} both render "${app.label}" in ${app.destination}`);
    seen.set(key, app.id);
  }
});

test("the catalogue check CAN fail: a duplicate row is detected", () => {
  const seen = new Map();
  const collide = (rows) => {
    for (const row of rows) {
      const key = `${row.destination}|${String(row.label).toLowerCase()}`;
      if (seen.has(key)) return `${row.id} duplicates ${seen.get(key)}`;
      seen.set(key, row.id);
    }
    return null;
  };
  assert.equal(collide([{ id: "l", label: "Lyra", destination: "agents" }, { id: "a", label: "Agents", destination: "agents" }]), null);
  assert.match(collide([{ id: "p", label: "Pulse", destination: "platform" }, { id: "p2", label: "Pulse", destination: "platform" }]), /duplicates/);
});
