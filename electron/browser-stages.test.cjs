"use strict";

// browser-stages.cjs: a stage is a named, saved Aither Browser arrangement bound to a
// workspace, stored as userData/stages.json. Every arm here can fail on a real regression
// (the switch losing tabs, a workspace binding dropped on the way through the file, a
// corrupt file wedging the browser).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const S = require("./browser-stages.cjs");

const tab = (url, extra = {}) => ({ url, title: url, kind: "web", by: "you", ...extra });

test("a fresh document is one stage, active, and the browser always has one", () => {
  const doc = S.defaultDoc();
  assert.equal(doc.v, S.SCHEMA_VERSION);
  assert.equal(doc.kind, S.DOC_KIND);
  assert.equal(doc.stages.length, 1);
  assert.equal(doc.active, doc.stages[0].id);
  assert.equal(S.activeStage(doc).id, doc.active);
  assert.deepEqual(S.list(doc), [{ id: doc.stages[0].id, name: S.DEFAULT_NAME, workspace: "", tabs: 0, active: true }]);
});

test("create names a stage uniquely, renames, and refuses a duplicate name", () => {
  let doc = S.defaultDoc();
  let r = S.create(doc, { name: "Garg" });
  assert.equal(r.ok, true);
  doc = r.doc;
  assert.equal(doc.stages.length, 2);
  assert.equal(S.activeStage(doc).name, "Garg", "a new stage is the one you are in");
  // A second "Garg" gets a suffix, never an ambiguous switcher.
  r = S.create(doc, { name: "Garg" });
  assert.equal(r.ok, true);
  doc = r.doc;
  const names = doc.stages.map((s) => s.name);
  assert.deepEqual(names, ["Stage 1", "Garg", "Garg 2"]);
  // Rename: works, and refuses landing on a neighbour.
  const garg = doc.stages.find((s) => s.name === "Garg");
  assert.equal(S.rename(doc, garg.id, "Garg 2").ok, false);
  const renamed = S.rename(doc, garg.id, "Customer work");
  assert.equal(renamed.ok, true);
  assert.equal(renamed.doc.stages.find((s) => s.id === garg.id).name, "Customer work");
  assert.equal(S.rename(doc, "s99", "x").ok, false, "an unknown id is refused, not invented");
  assert.equal(S.rename(doc, garg.id, "   ").ok, false, "a blank name is refused");
});

test("delete: the last stage stays; deleting the active one moves you to a neighbour", () => {
  let doc = S.defaultDoc();
  doc = S.create(doc, { name: "Two" }).doc;
  doc = S.create(doc, { name: "Three" }).doc;
  const two = doc.stages.find((s) => s.name === "Two");
  const removed = S.remove(doc, two.id);
  assert.equal(removed.ok, true);
  assert.equal(removed.doc.stages.length, 2);
  assert.equal(removed.doc.active, doc.active, "an inactive stage does not steal focus");
  // Delete the active one: the browser lands on a stage that exists.
  const active = S.activeStage(removed.doc);
  const again = S.remove(removed.doc, active.id);
  assert.equal(again.ok, true);
  assert.equal(S.activeStage(again.doc).id, again.active);
  // The last one never goes: the browser is always in a stage.
  assert.equal(S.remove(again.doc, S.activeStage(again.doc).id).ok, false);
});

test("reorder: by index and by +1 / -1, clamped at both ends", () => {
  let doc = S.defaultDoc();
  doc = S.create(doc, { name: "B" }).doc;
  doc = S.create(doc, { name: "C" }).doc;
  const order = (d) => d.stages.map((s) => s.name);
  const c = doc.stages.find((s) => s.name === "C");
  assert.deepEqual(order(S.move(doc, c.id, { index: 0 }).doc), ["C", S.DEFAULT_NAME, "B"]);
  assert.deepEqual(order(S.move(doc, c.id, { by: -1 }).doc), [S.DEFAULT_NAME, "C", "B"]);
  assert.deepEqual(order(S.move(doc, c.id, { by: 1 }).doc), [S.DEFAULT_NAME, "B", "C"]);
  assert.deepEqual(order(S.move(doc, c.id, { by: 1 }).doc), [S.DEFAULT_NAME, "B", "C"], "last stays last");
  assert.deepEqual(order(S.move(doc, c.id, { index: 99 }).doc), [S.DEFAULT_NAME, "B", "C"]);
});

test("workspace binding round-trips through the file, and a bad slug is refused", () => {
  let doc = S.defaultDoc();
  const id = S.activeStage(doc).id;
  doc = S.assignWorkspace(doc, id, "garg").doc;
  assert.equal(S.activeStage(doc).workspace, "garg");
  // Through the real file, byte for byte, and back.
  const file = path.join(tmpDir(), S.FILE_NAME);
  assert.equal(S.save(file, doc).ok, true);
  assert.equal(S.load(file).doc.stages[0].workspace, "garg");
  // Cleared with an empty slug; a bad one refused.
  assert.equal(S.assignWorkspace(doc, id, "").doc.stages[0].workspace, "");
  assert.equal(S.assignWorkspace(doc, id, "Not A Slug!").ok, false);
  assert.equal(S.assignWorkspace(doc, id, "../etc").ok, false);
  // Case is folded: the policy names tenants in lower case.
  assert.equal(S.assignWorkspace(doc, id, "Garg").doc.stages[0].workspace, "garg");
});

test("a stage never loses its tabs when you switch, and switching back finds them", () => {
  let doc = S.defaultDoc();
  const first = S.activeStage(doc).id;
  doc = S.setTabs(doc, first, [tab("https://mail.example.com/"), tab("aither://files", { kind: "internal" })]).doc;
  doc = S.create(doc, { name: "Garg", workspace: "garg" }).doc;
  const second = S.activeStage(doc).id;
  doc = S.setTabs(doc, second, [tab("https://garg.example.com/deal/7")]).doc;
  // Switching is a pointer move; it never edits the tab lists.
  doc = S.setActive(doc, first).doc;
  assert.deepEqual(doc.stages.find((s) => s.id === first).tabs.map((t) => t.url),
    ["https://mail.example.com/", "aither://files"]);
  assert.deepEqual(doc.stages.find((s) => s.id === second).tabs.map((t) => t.url),
    ["https://garg.example.com/deal/7"]);
  // And the whole document survives the file.
  const file = path.join(tmpDir(), S.FILE_NAME);
  S.save(file, doc);
  const back = S.load(file).doc;
  assert.equal(back.active, first);
  assert.deepEqual(back.stages.map((s) => [s.name, s.workspace, s.tabs.length]),
    [[S.DEFAULT_NAME, "", 2], ["Garg", "garg", 1]]);
  // A tab set written back later replaces, never appends, and drops a duplicate.
  const replaced = S.setTabs(back, first, [tab("https://mail.example.com/"), tab("https://mail.example.com/")]);
  assert.deepEqual(replaced.doc.stages.find((s) => s.id === first).tabs.map((t) => t.url), ["https://mail.example.com/"]);
});

test("tabs are descriptors: a private tab, a javascript: URL and a blank URL are never saved", () => {
  const doc = S.setTabs(S.defaultDoc(), S.activeStage(S.defaultDoc()).id, [
    tab("https://ok.example/"),
    tab("javascript:alert(1)"),
    { url: "" },
    tab("https://private.example/", { private: true }),
    null,
    "https://string.example/",
  ]).doc;
  assert.deepEqual(doc.stages[0].tabs.map((t) => t.url), ["https://ok.example/"]);
  assert.equal("private" in doc.stages[0].tabs[0], false, "InPrivate leaves no descriptor behind");
});

test("a tab the window's cap would not open is kept, in the document's own order", () => {
  // Two of five opened (the window's 30-tab cap); the other three never were live.
  const live = [tab("https://a.example/"), tab("https://d.example/")];
  const saved = ["a", "b", "c", "d", "e"].map((n) => tab(`https://${n}.example/`));
  const held = [saved[1], saved[2], saved[4]];
  assert.deepEqual(S.mergeUnopened(live, saved, held).map((t) => t.url),
    saved.map((t) => t.url), "nothing is dropped and the saved order survives");
  // A tab opened after the switch (not in the document yet) keeps its place at the end.
  const fresh = [...live, tab("https://new.example/")];
  assert.deepEqual(S.mergeUnopened(fresh, saved, held).map((t) => t.url),
    [...saved.map((t) => t.url), "https://new.example/"]);
  // A tab the owner closed is gone (it was live, then is not, and is not held).
  assert.deepEqual(S.mergeUnopened([saved[0]], saved, []).map((t) => t.url), [saved[0].url]);
});

test("context round-trips: awsh terminal session ids, file roots, splits (clamped)", () => {
  let doc = S.defaultDoc();
  const id = S.activeStage(doc).id;
  doc = S.setContext(doc, id, { terminals: ["t-1", "t-2", "t-1"], roots: ["C:/work", " D:/garg "] }).doc;
  assert.deepEqual(doc.stages[0].terminals, ["t-1", "t-2"]);
  assert.deepEqual(doc.stages[0].roots, ["C:/work", "D:/garg"]);
  doc = S.setSplits(doc, id, [{ dir: "row", ratio: 0.25 }, { dir: "sideways", ratio: 9 }, "nope"]).doc;
  assert.deepEqual(doc.stages[0].splits, [{ dir: "row", ratio: 0.25 }, { dir: "row", ratio: 0.9 }]);
  const file = path.join(tmpDir(), S.FILE_NAME);
  S.save(file, doc);
  const back = S.load(file).doc.stages[0];
  assert.deepEqual(back.terminals, ["t-1", "t-2"]);
  assert.deepEqual(back.roots, ["C:/work", "D:/garg"]);
  assert.deepEqual(back.splits, [{ dir: "row", ratio: 0.25 }, { dir: "row", ratio: 0.9 }]);
});

test("the document is bounded: at most MAX_STAGES stages, MAX_TABS tabs each", () => {
  let doc = S.defaultDoc();
  for (let i = 0; i < 20; i += 1) {
    const made = S.create(doc, { name: `S${i}` });
    if (made.ok) doc = made.doc;
  }
  assert.equal(doc.stages.length, S.MAX_STAGES);
  assert.equal(S.create(doc, { name: "one too many" }).ok, false);
  const many = Array.from({ length: 60 }, (_, i) => tab(`https://example.com/${i}`));
  const capped = S.setTabs(doc, S.activeStage(doc).id, many).doc;
  assert.equal(capped.stages.find((s) => s.id === capped.active).tabs.length, S.MAX_TABS);
});

test("a corrupt file starts one stage and SAYS SO; a missing one is quiet", () => {
  const dir = tmpDir();
  const file = path.join(dir, S.FILE_NAME);
  // Missing: a fresh start, no warning, nothing invented.
  const missing = S.load(file);
  assert.equal(missing.corrupt, false);
  assert.equal(missing.exists, false);
  assert.equal(missing.warnings.length, 0);
  assert.equal(missing.doc.stages.length, 1);
  // Not JSON: safe default AND a warning (a bad file is not silently replaced).
  fs.writeFileSync(file, "{ this is not json");
  const broken = S.load(file);
  assert.equal(broken.corrupt, true);
  assert.equal(broken.doc.stages.length, 1);
  assert.equal(broken.doc.active, broken.doc.stages[0].id);
  assert.match(broken.warnings[0], /not JSON/);
  // JSON of the wrong shape: normalized, never fatal.
  fs.writeFileSync(file, JSON.stringify({ stages: "nope", active: 42, nextId: -1 }));
  const odd = S.load(file);
  assert.equal(odd.corrupt, false);
  assert.equal(odd.doc.stages.length, 1);
  assert.equal(odd.doc.active, odd.doc.stages[0].id);
  assert.ok(odd.doc.nextId > 0);
  // A hand-edited duplicate id / name: ids unique, names unique, active names a stage.
  fs.writeFileSync(file, JSON.stringify({ stages: [{ id: "s1", name: "Same" }, { id: "s1", name: "Same" }], active: "s9" }));
  const dupe = S.load(file).doc;
  assert.equal(dupe.stages.length, 2);
  assert.deepEqual(dupe.stages.map((s) => s.name), ["Same", "Same 2"]);
  assert.notEqual(dupe.stages[0].id, dupe.stages[1].id);
  assert.ok(dupe.stages.some((s) => s.id === dupe.active));
});

test("save is atomic: the file is written whole and a failed write leaves no .tmp", () => {
  const dir = tmpDir();
  const file = path.join(dir, S.FILE_NAME);
  const doc = S.setTabs(S.defaultDoc(), S.activeStage(S.defaultDoc()).id, [tab("https://a.example/")]).doc;
  assert.equal(S.save(file, doc).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).stages[0].tabs[0].url, "https://a.example/");
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  // A directory where the file belongs: reported, not thrown.
  const bad = path.join(dir, "sub", S.FILE_NAME);
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.mkdirSync(bad);
  const failed = S.save(bad, doc);
  assert.equal(failed.ok, false);
  assert.ok(failed.error);
});

test("resolveScope: the workspace partition is used only when it is really in force", () => {
  const work = "persist:aither-work-garg";
  // Unbound: the owner's own session, nothing to say.
  assert.deepEqual(S.resolveScope("", { signed: "garg", workPartition: work }),
    { workspace: "", partition: S.OWNER_PARTITION, live: false, matched: false, reason: "" });
  // Bound to the workspace this desk is signed into, with a policy: its partition.
  assert.deepEqual(S.resolveScope("garg", { signed: "garg", workPartition: work }),
    { workspace: "garg", partition: work, live: true, matched: true, reason: "" });
  // Same workspace, no policy in force: the owner's session, still matched, and the reason.
  const noPolicy = S.resolveScope("garg", { signed: "garg", workPartition: null });
  assert.equal(noPolicy.live, false);
  assert.equal(noPolicy.matched, true, "the binding describes the desk you are in");
  assert.equal(noPolicy.partition, S.OWNER_PARTITION);
  assert.match(noPolicy.reason, /no workspace policy/);
  // Another workspace: never a partition it does not own.
  const other = S.resolveScope("aitherium", { signed: "garg", workPartition: work });
  assert.equal(other.live, false);
  assert.equal(other.matched, false);
  assert.equal(other.partition, S.OWNER_PARTITION);
  assert.match(other.reason, /garg, not aitherium/);
  // Signed in nowhere.
  assert.match(S.resolveScope("garg", { signed: "" }).reason, /not signed into garg/);
  // Case and spaces are folded, so a typed slug still binds.
  assert.equal(S.resolveScope(" GARG ", { signed: "garg", workPartition: work }).live, true);
});

test("the module is pure: no electron, and the file name is its own (not browser-layout.json)", () => {
  const src = fs.readFileSync(path.join(__dirname, "browser-stages.cjs"), "utf8");
  assert.ok(!/require\(["']electron["']\)/.test(src), "browser-stages.cjs must stay electron-free");
  assert.equal(S.FILE_NAME, "stages.json");
  assert.notEqual(S.FILE_NAME, "browser-layout.json");
});

test("the wiring is there: the chrome exposes the switcher, the window filters and switches", () => {
  const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
  const preload = read("browser-chrome-preload.cjs");
  assert.match(preload, /stage:\s*\(action, arg\)\s*=>\s*ipcRenderer\.invoke\("desk:browser-stage"/);
  const chrome = read("browser-chrome.html");
  for (const id of ["stagebtn", "stagepanel", "stage-name", "stage-ws", "stage-new", "stage-rename", "stage-assign", "stage-delete"]) {
    assert.ok(chrome.includes(`id="${id}"`), `the chrome is missing #${id}`);
  }
  assert.match(chrome, /api\.stage\("menu"/, "the panel asks main to step the page views aside");
  const win = read("browser-window.cjs");
  assert.match(win, /require\("\.\/browser-stages\.cjs"\)/);
  assert.match(win, /ipcMain\.handle\("desk:browser-stage"/);
  // The strip and the page area see the ACTIVE stage only.
  assert.match(win, /snap\.tabs\.filter\(\(t\) => tabStage\(t\.id\) === active\)/);
  assert.match(win, /inActiveStage\(id\)/);
  // Switching suspends (views stay alive), it does not close: no closeTab in switchStage.
  const body = win.slice(win.indexOf("function switchStage"), win.indexOf("function stageAction"));
  assert.ok(body.length > 200 && !/closeTab\(/.test(body), "switchStage must not close the outgoing stage's tabs");
  assert.match(body, /showStage\(stageId\)/, "the incoming stage is shown by showStage");
  const show = win.slice(win.indexOf("function showStage"), win.indexOf("function switchStage"));
  assert.match(show, /openStageTabs\(stageId\)/, "a stage is loaded lazily from the document");
  assert.match(show, /dockTab\(id, \{ quiet: true \}\)/, "another stage's popped window comes home");
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "desk-stages-"));
}

/* ── stages x split panes (#143/#144 merged with #145) ─────────────────────────── */

const winSource = () => fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");

test("browser-window.cjs compiles: no identifier is declared twice by two merged features", () => {
  const vm = require("node:vm");
  // The CJS wrapper makes every top-level let/const/function one scope: a second
  // `splitState` (or `stage`) declaration is an early SyntaxError, caught here.
  assert.doesNotThrow(() => new vm.Script(`(function (exports, require, module, __filename, __dirname) {${winSource()}\n})`));
});

test("viewsAside() is true for each of the four step-aside flags, false with none", () => {
  const src = winSource();
  const at = src.indexOf("function viewsAside()");
  assert.ok(at >= 0, "viewsAside is defined");
  const body = src.slice(src.indexOf("{", at) + 1, src.indexOf("\n}", at));
  const flags = ["dragging", "editingLayout", "stageDragging", "stagingMenu"];
  const aside = new Function(...flags, body);
  assert.equal(aside(false, false, false, false), false);
  flags.forEach((name, i) => {
    const args = flags.map((_, j) => j === i);
    assert.equal(aside(...args), true, `viewsAside must be true while ${name}`);
  });
});

test("switching arrangement hides the other arrangement's split panes", () => {
  // Arrangement s1 has a split of tabs 1 and 2; s2 has a split of tabs 3 and 4.
  const home = new Map([[1, "s1"], [2, "s1"], [3, "s2"], [4, "s2"]]);
  const shelf = S.createSplitShelf();
  let active = "s1";
  let onScreen = { axis: "horizontal", tabs: [1, 2], sizes: [0.5, 0.5], focus: 0 };
  shelf.park("s2", { axis: "vertical", tabs: [3, 4], sizes: [0.3, 0.7], focus: 1 });
  const inActive = (id) => home.get(id) === active;
  assert.deepEqual(S.splitPanesShown(onScreen, inActive), [true, true]);
  // s2's parked split is never drawn while s1 is on screen.
  assert.deepEqual(S.splitPanesShown(shelf.peek("s2"), inActive), [false, false]);
  // Switch to s2: park s1's split, take s2's.
  shelf.park(active, onScreen);
  active = "s2";
  onScreen = shelf.take("s2");
  assert.deepEqual(onScreen.tabs, [3, 4]);
  assert.deepEqual(S.splitPanesShown(onScreen, inActive), [true, true]);
  assert.deepEqual(S.splitPanesShown(shelf.peek("s1"), inActive), [false, false], "s1's panes are hidden now");
  // A split that somehow still names the other arrangement's tabs draws none of them.
  assert.deepEqual(S.splitPanesShown({ tabs: [1, 3] }, inActive), [false, true]);
  // A step-aside (a drag, the stage panel) hides every pane.
  assert.deepEqual(S.splitPanesShown(onScreen, inActive, true), [false, false]);
  // The window wires it: park before the incoming tabs activate, take after; layout filters.
  const src = winSource();
  const sw = src.slice(src.indexOf("function switchStage"), src.indexOf("function leaveSplit"));
  assert.ok(sw.indexOf("leaveSplit(doc.active)") >= 0 && sw.indexOf("leaveSplit(doc.active)") < sw.indexOf("showStage(stageId)"),
    "the outgoing split is parked before the incoming tabs are shown");
  assert.ok(sw.indexOf("enterSplit(stageId)") > sw.indexOf("showStage(stageId)"), "the incoming split is restored after");
  const lay = src.slice(src.indexOf("function layout()"), src.indexOf("// ── Split panes"));
  assert.match(lay, /browserStages\.splitPanesShown\(stage, inActiveStage, viewsAside\(\)\)/);
  assert.ok(lay.indexOf("inActiveStage(tabs.active)") < lay.indexOf("stageSettle()")
    && lay.indexOf("stageSettle()") < lay.indexOf("stageAdoptActive()"),
    "the arrangement hand-back runs first, then the split settles and adopts the active tab");
  assert.match(lay, /dockIn\.splitRects\(rects\.page, dockSplitState\)/, "the dock-in split pane keeps its own state");
});

test("a split survives an arrangement round-trip: in this run, and through stages.json", () => {
  // In-run: parked and taken back intact (tabs, sizes, axis, focus).
  const shelf = S.createSplitShelf();
  const split = { axis: "vertical", tabs: [7, 9, 8], sizes: [0.2, 0.5, 0.3], focus: 2 };
  shelf.park("s1", split);
  split.tabs.push(99); // the live object moving on does not change what was parked
  assert.deepEqual(shelf.take("s1"), { axis: "vertical", tabs: [7, 9, 8], sizes: [0.2, 0.5, 0.3], focus: 2 });
  assert.equal(shelf.take("s1"), null, "taken once");
  shelf.park("s1", null);
  assert.equal(shelf.has("s1"), false, "an unsplit arrangement parks nothing");

  // Through the document: tab ids -> indices into the saved tabs -> new ids after a restart.
  const live = { axis: "vertical", tabs: [12, 10], sizes: [0.25, 0.75], focus: 1 };
  const savedIds = [10, 11, 12]; // saved tabs a, b, c were live as 10, 11, 12
  const saved = S.splitToSaved(live, savedIds);
  assert.deepEqual(saved, { axis: "vertical", panes: [2, 0], sizes: [0.25, 0.75], focus: 1 });
  let doc = S.defaultDoc();
  const id = doc.active;
  const tabsList = [{ url: "https://a.example/" }, { url: "https://b.example/" }, { url: "https://c.example/" }];
  doc = S.setTabs(doc, id, tabsList, { split: saved }).doc;
  const dir = tmpDir();
  const file = path.join(dir, S.FILE_NAME);
  assert.equal(S.save(file, doc).ok, true);
  const back = S.load(file).doc.stages[0];
  assert.deepEqual(back.split, saved);
  // After a restart the saved tabs open as 40, 41, 42: the split comes back on them.
  assert.deepEqual(S.splitFromSaved(back.split, [40, 41, 42]),
    { axis: "vertical", tabs: [42, 40], sizes: [0.25, 0.75], focus: 1 });
  // A pane whose tab the cap refused drops; one pane left is no split.
  assert.equal(S.splitFromSaved(back.split, [40, 41, null]), null);
  // Garbage in the file never wedges the load: out-of-range / repeated panes drop.
  assert.equal(S.normalizeSplit({ panes: [0, 0] }, 3), null);
  assert.deepEqual(S.normalizeSplit({ axis: "x", panes: [5, 1, 0], sizes: [1, -1, "z"] }, 3).panes, [1, 0]);
  // Changing the tab list without a split clears a stale one (its indices would lie).
  doc = S.setTabs(doc, id, tabsList.slice(0, 2)).doc;
  assert.equal(doc.stages[0].split, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a split of two tabs on the same address survives a save (twin key)", () => {
  const bs = require("./browser-stages.cjs");
  const tabs = bs.normalizeTabs([
    { url: "https://a.example/" }, { url: "https://a.example/", twin: 1 }, { url: "https://a.example/" },
  ]);
  assert.strictEqual(tabs.length, 2, "twin kept, plain duplicate still folded");
  assert.strictEqual(tabs[1].twin, 1);
  const saved = bs.splitToSaved({ axis: "row", tabs: [11, 12], sizes: [0.5, 0.5], focus: 1 }, [11, 12]);
  assert.deepStrictEqual(saved.panes, [0, 1]);
  const back = bs.splitFromSaved(saved, [21, 22]);
  assert.deepStrictEqual(back.tabs, [21, 22]);
  const doc = JSON.parse(JSON.stringify({ tabs }));
  assert.strictEqual(bs.normalizeTabs(doc.tabs).length, 2, "round trip through JSON keeps the twin");
});
