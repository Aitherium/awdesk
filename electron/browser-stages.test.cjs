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
