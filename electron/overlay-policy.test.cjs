"use strict";

// overlay-policy.cjs: when the desk may raise the AitherOS Online overlay by itself.
// Each automatic trigger obeys its own switch, explicit actions always pass, and Do not
// disturb silences every automatic trigger. Plus the cast.json section and main's wiring.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const policy = require("./overlay-policy.cjs");
const { TRIGGERS } = policy;

const AUTOMATIC = [TRIGGERS.START, TRIGGERS.EDGE, TRIGGERS.NOTIFICATION, TRIGGERS.REQUEST];
const FLAG_OF = {
  [TRIGGERS.START]: "autoOpenOnStart",
  [TRIGGERS.EDGE]: "edgeReveal",
  [TRIGGERS.NOTIFICATION]: "raiseOnNotifications",
};

test("defaults are quiet: nothing opens at start, at an edge or for a notification", () => {
  const d = policy.normalize({});
  assert.deepEqual(d, {
    autoOpenOnStart: false, edgeReveal: false, edge: "right", edgeDwellMs: 600,
    raiseOnNotifications: false, doNotDisturb: false,
  });
  for (const t of [TRIGGERS.START, TRIGGERS.EDGE, TRIGGERS.NOTIFICATION]) {
    assert.equal(policy.decide({}, t).allow, false, `${t} must be off by default`);
    assert.equal(policy.decide(undefined, t).allow, false, `${t} with no settings at all`);
  }
  assert.equal(policy.decide({}, TRIGGERS.REQUEST).allow, true, "a program's request is honoured unless DND");
});

test("each automatic trigger obeys ITS OWN switch and no other", () => {
  for (const [trigger, flag] of Object.entries(FLAG_OF)) {
    const on = policy.decide({ [flag]: true }, trigger);
    assert.equal(on.allow, true, `${trigger} with ${flag}=true`);
    assert.match(on.reason, new RegExp(flag));
    assert.equal(policy.decide({ [flag]: false }, trigger).allow, false, `${trigger} with ${flag}=false`);
    // Every OTHER switch on, this one off: still refused.
    const others = Object.fromEntries(Object.values(FLAG_OF).filter((f) => f !== flag).map((f) => [f, true]));
    assert.equal(policy.decide(others, trigger).allow, false, `${trigger} must not ride on another switch`);
  }
});

test("an explicit user action always passes: DND, everything off, junk settings", () => {
  for (const s of [{}, { doNotDisturb: true }, { doNotDisturb: true, autoOpenOnStart: false }, null, "junk", 42]) {
    assert.equal(policy.decide(s, TRIGGERS.USER).allow, true, JSON.stringify(s));
  }
});

test("Do not disturb suppresses EVERY automatic trigger, even with its switch on", () => {
  const all = { autoOpenOnStart: true, edgeReveal: true, raiseOnNotifications: true, doNotDisturb: true };
  for (const t of AUTOMATIC) {
    const v = policy.decide(all, t);
    assert.equal(v.allow, false, t);
    assert.match(v.reason, /do not disturb/);
  }
  // ... and with DND off the same settings let every one through.
  for (const t of AUTOMATIC) assert.equal(policy.decide({ ...all, doNotDisturb: false }, t).allow, true, t);
});

test("an unknown trigger is refused, so a new automatic door must be named first", () => {
  const v = policy.decide({ autoOpenOnStart: true, edgeReveal: true, raiseOnNotifications: true }, "idle");
  assert.equal(v.allow, false);
  assert.match(v.reason, /unknown trigger/);
});

test("non-boolean switches read as their default, never as on", () => {
  const s = policy.normalize({ autoOpenOnStart: "yes", edgeReveal: 1, raiseOnNotifications: "true", doNotDisturb: "no" });
  assert.equal(s.autoOpenOnStart, false);
  assert.equal(s.edgeReveal, false);
  assert.equal(s.raiseOnNotifications, false);
  assert.equal(s.doNotDisturb, false);
  assert.equal(policy.normalize({ edge: "diagonal", edgeDwellMs: 10 }).edge, "right");
  assert.equal(policy.normalize({ edgeDwellMs: 10 }).edgeDwellMs, 600);
  assert.equal(policy.normalize({ edgeDwellMs: 999999 }).edgeDwellMs, 600);
  assert.equal(policy.normalize({ edge: "left", edgeDwellMs: 300 }).edge, "left");
});

test("cleanPatch keeps known, valid keys only", () => {
  assert.deepEqual(policy.cleanPatch({ doNotDisturb: true, edge: "top", edgeDwellMs: 400, evil: 1, autoOpenOnStart: "1" }),
    { doNotDisturb: true, edge: "top", edgeDwellMs: 400 });
  assert.deepEqual(policy.cleanPatch(null), {});
  assert.deepEqual(policy.cleanPatch({ edgeDwellMs: 1.5 }), {});
});

test("atEdge: each edge of the display, and nowhere else", () => {
  const b = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.equal(policy.atEdge({ x: 0, y: 500 }, b, "left"), true);
  assert.equal(policy.atEdge({ x: 1919, y: 500 }, b, "right"), true);
  assert.equal(policy.atEdge({ x: 900, y: 0 }, b, "top"), true);
  assert.equal(policy.atEdge({ x: 900, y: 1079 }, b, "bottom"), true);
  assert.equal(policy.atEdge({ x: 900, y: 500 }, b, "right"), false);
  assert.equal(policy.atEdge({ x: 0, y: 500 }, b, "right"), false);
  assert.equal(policy.atEdge({ x: 1919, y: 1200 }, b, "right"), false, "off the display");
  // A display that does not start at 0,0 (a second monitor).
  const b2 = { x: -1280, y: 0, width: 1280, height: 1024 };
  assert.equal(policy.atEdge({ x: -1280, y: 10 }, b2, "left"), true);
  assert.equal(policy.atEdge({ x: -1, y: 10 }, b2, "right"), true);
});

function harness(settings, { visible = false } = {}) {
  const state = { t: 0, cursor: { x: 900, y: 500 }, visible, reveals: 0, settings };
  const w = policy.createEdgeWatcher({
    settings: () => state.settings,
    cursor: () => state.cursor,
    bounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    visible: () => state.visible,
    reveal: () => { state.reveals += 1; },
    now: () => state.t,
  });
  const dwell = (ms, step = 100) => { for (let i = 0; i <= ms; i += step) { w.tick(); state.t += step; } };
  return { state, w, dwell };
}

test("edge watcher: OFF by default -- resting on the edge reveals nothing", () => {
  const { state, dwell } = harness({});
  state.cursor = { x: 1919, y: 500 };
  dwell(5000);
  assert.equal(state.reveals, 0);
});

test("edge watcher: on, it reveals once after the dwell and re-arms only after leaving", () => {
  const { state, dwell } = harness({ edgeReveal: true, edge: "right", edgeDwellMs: 600 });
  state.cursor = { x: 1919, y: 500 };
  dwell(400);
  assert.equal(state.reveals, 0, "before the dwell");
  dwell(400);
  assert.equal(state.reveals, 1, "after the dwell");
  dwell(3000);
  assert.equal(state.reveals, 1, "staying on the edge does not reveal again");
  state.cursor = { x: 900, y: 500 };
  dwell(200);
  state.cursor = { x: 1919, y: 500 };
  dwell(800);
  assert.equal(state.reveals, 2, "leaving and coming back re-arms it");
});

test("edge watcher: only the chosen edge, never while DND, never when already visible", () => {
  const left = harness({ edgeReveal: true, edge: "left" });
  left.state.cursor = { x: 1919, y: 500 };
  left.dwell(3000);
  assert.equal(left.state.reveals, 0, "the right edge does not reveal a left-edge setting");

  const dnd = harness({ edgeReveal: true, edge: "right", doNotDisturb: true });
  dnd.state.cursor = { x: 1919, y: 500 };
  dnd.dwell(3000);
  assert.equal(dnd.state.reveals, 0, "do not disturb");

  const shown = harness({ edgeReveal: true, edge: "right" }, { visible: true });
  shown.state.cursor = { x: 1919, y: 500 };
  shown.dwell(3000);
  assert.equal(shown.state.reveals, 0, "already on screen");
});

test("wouldShowOverlay: the toggle on a hidden overlay, a shell pick on a closed one", () => {
  assert.equal(policy.wouldShowOverlay("desktop.overlay.toggle", null, { open: true, visible: false }), true);
  assert.equal(policy.wouldShowOverlay("desktop.overlay.toggle", null, { open: true, visible: true }), false);
  assert.equal(policy.wouldShowOverlay("desktop.shell.gobbonet", { shell: "gobbonet" }, { open: false }), true);
  assert.equal(policy.wouldShowOverlay("desktop.shell.gobbonet", { shell: "gobbonet" }, { open: true }), false);
  assert.equal(policy.wouldShowOverlay("inbox.open", { id: "inbox.open" }, { open: false }), false);
});

// ─── cast.json `overlay`: persisted with every other desk setting ─────────────

test("cast.json overlay: defaults, a saved value round-trips, junk is a named problem", () => {
  const cast = require("./cast-config.cjs");
  const desk = require("./desk-settings.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-policy-"));
  const file = path.join(dir, "cast.json");
  try {
    assert.deepEqual(
      Object.fromEntries(Object.keys(policy.DEFAULTS).map((k) => [k, desk.current({ file, env: {} }).overlay[k]])),
      { ...policy.DEFAULTS },
    );
    const written = cast.write((d) => { d.overlay = { doNotDisturb: true, edgeReveal: true, edge: "left", edgeDwellMs: 900 }; }, { file });
    assert.equal(written.ok, true, written.error);
    const back = desk.current({ file, env: {} }).overlay;
    assert.equal(back.doNotDisturb, true);
    assert.equal(back.edgeReveal, true);
    assert.equal(back.edge, "left");
    assert.equal(back.edgeDwellMs, 900);
    assert.equal(back.autoOpenOnStart, false);
    const loaded = cast.load({ file });
    assert.equal(loaded.problems.some((p) => p.path === "overlay"), false, "overlay is a known top-level key");
    const junk = cast.resolveDesk({ version: 1, overlay: { raiseOnNotifications: "always" } }, { env: {} });
    assert.equal(junk.overlay.raiseOnNotifications, false, "junk never turns a raise on");
    assert.ok(junk.problems.some((p) => p.path === "overlay.raiseOnNotifications"), JSON.stringify(junk.problems));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── the registry rows (tray + palette) ───────────────────────────────────────

test("tray rows: the four switches, plain labels, checked from ctx.overlayPolicy", () => {
  const registry = require("./command-registry.cjs");
  assert.deepEqual(registry.conformance(), []);
  const rows = {
    "desktop.overlay.auto-start": ["Open the desktop overlay when Desk starts", "autoOpenOnStart"],
    "desktop.overlay.edge-reveal": ["Reveal the overlay at the screen edge", "edgeReveal"],
    "desktop.overlay.raise-on-notify": ["Bring the overlay forward for notifications", "raiseOnNotifications"],
    "desktop.overlay.dnd": ["Do not disturb", "doNotDisturb"],
  };
  for (const [id, [label, key]] of Object.entries(rows)) {
    const c = registry.byId(id);
    assert.ok(c, id);
    assert.equal(c.label, label);
    assert.ok(c.surfaces.includes("tray"), `${id} is on the tray`);
    assert.equal(c.type, "checkbox");
    assert.equal(c.checked({ overlayPolicy: { [key]: true } }), true);
    assert.equal(c.checked({ overlayPolicy: { [key]: false } }), false);
    assert.equal(c.checked({}), false);
  }
});

// ─── main.cjs wiring: every automatic door goes through the policy ────────────

const MAIN = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

function body(startMarker, length = 900) {
  const at = MAIN.indexOf(startMarker);
  assert.ok(at >= 0, `main.cjs no longer contains ${startMarker}`);
  return MAIN.slice(at, at + length);
}

test("main: the startup open is the START trigger (unless the user passed --overlay)", () => {
  const b = body('if (process.argv.includes("--overlay")) showLivingDesktop();', 300);
  assert.match(b, /else if \(overlayMayRaise\(overlayPolicy\.TRIGGERS\.START\)\) showLivingDesktop\(\);/);
  assert.match(MAIN, /syncEdgeReveal\(\);/);
});

test("main: a card raises the Inbox only through the NOTIFICATION trigger, else a tray notice", () => {
  const b = body("const mayRaise = ", 900);
  assert.match(b, /overlayMayRaise\(overlayPolicy\.TRIGGERS\.NOTIFICATION/);
  assert.match(b, /if \(mayRaise\) \{\s*openInbox\(/);
  assert.match(b, /notifyQuietly\(/);
  assert.match(b, /mayRaise && cardWindowsMayOpen\(\)/);
});

test("main: MCP desktop_open and POST /desktop/overlay are REQUEST triggers", () => {
  for (const marker of ["onDesktop: (surface) => {", "desktopHandler: (mode) => {"]) {
    const b = body(marker, 400);
    assert.match(b, /requestLivingDesktop\(\)/, marker);
    assert.doesNotMatch(b, /showLivingDesktop\(\)/, `${marker} must not open the overlay directly`);
  }
  assert.match(MAIN, /surface === "bridge" && overlayPolicy\.wouldShowOverlay\(/);
});

test("main: the edge watcher drives a reveal, the settings door is wired", () => {
  assert.match(MAIN, /overlayPolicy\.createEdgeWatcher\(/);
  assert.match(MAIN, /ipcMain\.handle\("desk:settings-set-overlay"/);
  for (const id of ["auto-start", "edge-reveal", "raise-on-notify", "dnd"]) {
    assert.match(MAIN, new RegExp(`case "desktop\\.overlay\\.${id}": return void toggleOverlaySetting\\(`), id);
  }
});
