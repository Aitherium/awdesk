"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const cm = require("./companion-menu.cjs");

const ids = (list) => list.filter((i) => !i.sep).map((i) => i.id);

test("hidden by default: a fresh state shows nothing; an installed older state is moved to hidden once", () => {
  const core = require("./orb-core.cjs");
  const fresh = core.sanitizeState(null);
  assert.equal(fresh.visible, false, "fresh install: no fairy");
  assert.equal(fresh.tenantCompanion, false, "fresh install: no workspace companion");
  const older = core.sanitizeState({ visible: true, tenantCompanion: true });
  const moved = cm.migrate(older, { packaged: true });
  assert.equal(moved.changed, true);
  assert.equal(moved.state.visible, false);
  assert.equal(moved.state.tenantCompanion, false);
  assert.equal(moved.state.companionsV, cm.COMPANIONS_VERSION);
  const chosen = cm.migrate({ ...moved.state, visible: true }, { packaged: true });
  assert.equal(chosen.changed, false, "after the move, the person's own choice holds");
  assert.equal(chosen.state.visible, true);
  const dev = cm.migrate(older, { packaged: false });
  assert.equal(dev.state.visible, true, "a dev checkout keeps what its owner left");
  assert.equal(dev.state.companionsV, cm.COMPANIONS_VERSION);
});

test("the rows: hide this / hide all / show all, the doors, quiet, quit -- never a dead row", () => {
  const now = new Date(2026, 10, 13, 14, 5).getTime();
  const hidden = cm.items({ nowMs: now });
  assert.deepEqual(ids(hidden), ["show-all", "open-desktop", "open-spaces", "open-chat", "settings",
    "quiet-1h", "quiet-4h", "quit"], "all hidden: Show all only, no Hide");
  const shown = cm.items({ target: "fairy", fairyVisible: true, tenantVisible: true, nowMs: now });
  assert.deepEqual(ids(shown).slice(0, 2), ["hide-this", "hide-all"]);
  assert.ok(!ids(shown).includes("show-all"), "all shown: no Show all");
  const mixed = cm.items({ target: "tenant", fairyVisible: true, tenantVisible: false, nowMs: now });
  assert.deepEqual(ids(mixed).slice(0, 2), ["hide-all", "show-all"], "a hidden companion cannot be hidden again");
  const quiet = cm.items({ quietUntil: now + 3600_000, nowMs: now });
  assert.ok(ids(quiet).includes("quiet-off") && !ids(quiet).includes("quiet-1h"));
  assert.match(quiet.find((i) => i.id === "quiet-off").label, /until 3:05 PM/);
  for (const list of [hidden, shown, mixed, quiet]) {
    for (const item of list) {
      if (item.sep) continue;
      assert.ok(cm.isCompanionId(item.id), `${item.id} is a known row`);
      assert.ok(item.label && !item.disabled, `${item.id} is live`);
    }
  }
  assert.deepEqual(ids(cm.items({ doors: "tray", nowMs: now })), ["show-all", "open-desktop", "open-spaces", "quiet-1h", "quiet-4h"],
    "the tray's own rows carry chat, settings and quit");
});

test("quiet ids and the clock", () => {
  assert.equal(cm.quietUntilFor("quiet-1h", 1000), 1000 + 3600_000);
  assert.equal(cm.quietUntilFor("quiet-4h", 1000), 1000 + 4 * 3600_000);
  assert.equal(cm.quietUntilFor("quit", 1000), null);
  assert.equal(cm.clockLabel(new Date(2026, 0, 1, 0, 7).getTime()), "12:07 AM");
  assert.equal(cm.clockLabel(new Date(2026, 0, 1, 12, 30).getTime()), "12:30 PM");
});

test("menuRows: plain Electron rows, no leading/trailing/double separators, each click runs its id", () => {
  const ran = [];
  const rows = cm.menuRows([{ sep: true }, { id: "show-all", label: "Show" }, { sep: true }, { sep: true },
    { id: "quit", label: "Quit" }, { sep: true }], (id) => ran.push(id));
  assert.deepEqual(rows.map((r) => r.type || r.label), ["Show", "separator", "Quit"]);
  rows.filter((r) => r.click).forEach((r) => r.click());
  assert.deepEqual(ran, ["show-all", "quit"]);
});

test("wiring: main, the overlay, its preload and the registry use these rows", () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
  const main = read("main.cjs");
  assert.match(main, /hideByDefault: app\.isPackaged/, "an installed build hides an older install's companions");
  assert.match(main, /companionTrayItems\(\)/, "the tray's companion rows");
  assert.match(main, /\.\.\.companionRows, \.\.\.houseTrayRows\(\)/, "near the top of the tray");
  assert.match(main, /orbWindow\.onCompanionsChange\(\(\) => \{ if \(tray\) refreshTrayMenu\(\); \}\)/);
  assert.match(main, /door: \(name\) => \{/, "the doors on every companion menu");
  assert.match(main, /if \(name === "desktop"\) \{ showLivingDesktop\(\); return true; \}/, "Open AitherOS desktop opens, never toggles shut");
  assert.match(main, /if \(orbWindow\.quietUntil\(\) > Date\.now\(\)\)/, "quiet mode holds the popups");
  const ld = read("living-desktop-window.cjs");
  assert.ok(ld.includes('"[data-companion]{display:none !important}"'), "the workspace companion is hidden in desk windows");
  assert.match(ld, /reapplyTenantCompanion\(win\);/, "re-applied on every overlay load");
  assert.match(ld, /reapplyTenantCompanion\(appWin\);/, "and every app-window load");
  assert.match(ld, /openCompanionMenu\("tenant", \{ at \}\)/, "the menu opens AT the companion");
  assert.match(ld, /cursorOverCompanion\(\) \|\| cursorOverInteractive\(\)/, "the companion always takes the mouse (drag)");

  const preload = read("living-desktop-preload.cjs");
  assert.match(preload, /closest\("\[data-companion\]"\)/);
  assert.match(preload, /ipcRenderer\.send\("living-desktop:companion-menu", \{ x:/, "the click point rides with the menu request");
  assert.match(preload, /companion-hold/, "a press on the companion holds the mouse for a drag");
  const reg = require("./command-registry.cjs");
  for (const id of ["companions.show", "companions.hide"]) {
    const row = reg.byId(id);
    assert.ok(row, id);
    assert.ok(row.surfaces.includes("jumplist"), `${id}: right-click Aither on the taskbar`);
    assert.ok(row.surfaces.includes("palette"), `${id}: the keyboard`);
  }
});
