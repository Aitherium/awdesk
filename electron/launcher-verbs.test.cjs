"use strict";

// The Alt+Space launcher's VERB path (desk-verbs.cjs wired into launcher-window.cjs):
// a verb answers with its own rows, Enter runs the row's action BY KEY, and a bare
// verb keeps the ordinary search underneath.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createLauncher } = require("./launcher-window.cjs");

function launcher({ hasCanvas = false } = {}) {
  const ran = [];
  const electron = {
    BrowserWindow: class {}, ipcMain: { handle() {}, on() {} },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) }, shell: {}, clipboard: {},
  };
  const registry = { byId: (id) => (id === "canvas.open" && hasCanvas ? { id } : id === "orb.ask" ? null : null) };
  const l = createLauncher({ electron, registry, run: async (id, arg) => { ran.push([id, arg]); }, quickMenu: {} });
  return { l, ran };
}

test("'draw through' answers with the click-through row and Enter runs ink.passthrough", async () => {
  const { l, ran } = launcher();
  const r = await l.search("draw through");
  assert.equal(r.ok, true);
  assert.equal(r.groups[0].id, "verbs");
  const row = r.groups[0].shown[0];
  assert.equal(row.title, "Draw, clicks go through");
  assert.equal("action" in row, false, "the action stays in main");
  const done = await l.runRow(row.key, "");
  assert.equal(done.ok, true);
  assert.deepEqual(ran, [["ink.passthrough", undefined]]);
});

test("'youtube <words>' offers a YouTube search; 'pin <url>' a pin row; unknown verb keys expire", async () => {
  const { l } = launcher();
  const yt = await l.search("youtube lofi");
  assert.match(yt.groups[0].shown[0].title, /Search YouTube for “lofi”/);
  const pin = await l.search("pin https://media.tenor.com/x/cat.gif");
  assert.match(pin.groups[0].shown[0].title, /Pin this GIF/);
  const stale = await l.runRow("verb:nope", "");
  assert.equal(stale.ok, false);
  assert.match(stale.error, /expired/);
});

// A bare verb ("canvas", "draw") also runs the ordinary search underneath; that path
// starts the universal search's providers (powershell), so it is asserted in
// desk-verbs.test.cjs on verbRows, not here.
test("'canvas' rows follow the registry: a canvas row only when canvas.open exists", () => {
  const verbs = require("./desk-verbs.cjs");
  const v = verbs.parseDeskVerb("canvas");
  assert.deepEqual(verbs.verbRows(v, { hasCanvas: false }).rows.map((r) => r.action.id), ["board.new"]);
  assert.deepEqual(verbs.verbRows(v, { hasCanvas: true }).rows.map((r) => r.action.id), ["canvas.open", "board.new"]);
});
