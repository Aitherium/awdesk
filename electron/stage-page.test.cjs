"use strict";

/**
 * stage.html's voice controls, run against a paper DOM (same technique as
 * cast-page.test.cjs): lift the script out of the html, run it under `vm` with a
 * fake `window.aitherStage` that records every call.
 *
 * What it guards: the per-body speaker and the master "All voices" switch were
 * reachable only from a body's right-click and the tray. A row button that sent
 * the wrong slot, or a master switch that flipped instead of stating its target,
 * would look right on screen and silence the wrong body.
 *
 *   node --test electron/stage-page.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const HTML = fs.readFileSync(path.join(__dirname, "stage.html"), "utf8");
const SCRIPT = HTML.slice(HTML.indexOf("<script>") + 8, HTML.lastIndexOf("</script>"));

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.className = "";
    this.id = "";
    this.title = "";
    this.disabled = false;
    this._text = "";
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get childElementCount() { return this.children.length; }
  appendChild(child) { this.children.push(child); return child; }
  append(...kids) { for (const k of kids) this.children.push(k); }
  replaceChildren(...kids) { this.children = [...kids]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type) { return Promise.all((this.listeners[type] || []).map((fn) => fn({ target: this }))); }
  walk() { return [this, ...this.children.flatMap((c) => c.walk())]; }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function boot({ bodies, allVoicesMuted = false, answers = {} }) {
  const byId = new Map();
  const body = new Node("body");
  const document = {
    body,
    createElement: (tag) => new Node(tag),
    getElementById: (id) => {
      if (!byId.has(id)) { const n = new Node("div"); n.id = id; byId.set(id, n); body.appendChild(n); }
      return byId.get(id);
    },
  };
  const calls = [];
  const state = { bodies, allVoicesMuted };
  const aitherStage = {
    bodies: () => Promise.resolve({ ok: true, bodies: JSON.parse(JSON.stringify(state.bodies)),
      allVoicesMuted: state.allVoicesMuted, safety: null }),
    arrange: () => Promise.resolve({ ok: true }),
    focus: () => Promise.resolve({ ok: true }),
    remove: () => Promise.resolve({ ok: true }),
    run: () => Promise.resolve({ ok: true }),
    setVoice: (slotId, muted) => {
      calls.push(["setVoice", slotId, muted]);
      return Promise.resolve(answers.setVoice || { ok: true, slotId, voiceMuted: muted });
    },
    setAllVoices: (muted) => {
      calls.push(["setAllVoices", muted]);
      return Promise.resolve(answers.setAllVoices || { ok: true, allVoicesMuted: muted });
    },
  };
  const sandbox = { document, window: { aitherStage }, setInterval: () => 0, console, Date };
  vm.createContext(sandbox);
  vm.runInContext(`${SCRIPT}\n;globalThis.__refresh = refresh;`, sandbox);
  return { body, calls, state, byId, refresh: () => sandbox.__refresh() };
}

const voiceButtons = (page) => page.body.walk().filter((n) => n.tagName === "BUTTON" && n.dataset.voice);
const voiceFor = (page, slotId) => voiceButtons(page).find((n) => n.dataset.voice === slotId);
const master = (page) => page.byId.get("allVoices");

const BODIES = [
  { slotId: "slot0", name: "Aither", agent: "aither", resident: true, voiceMuted: false },
  { slotId: "slot1", name: "atlas.vrm", agent: "atlas", resident: false, voiceMuted: true },
];

test("stage pane: every body row carries its own speaker, painted from voiceMuted", async () => {
  const page = boot({ bodies: BODIES });
  await page.refresh();
  assert.equal(voiceButtons(page).length, 2, "one speaker per body");
  assert.equal(voiceFor(page, "slot0").textContent, "Voice on");
  assert.equal(voiceFor(page, "slot0").attributes["aria-pressed"], "false");
  assert.equal(voiceFor(page, "slot1").textContent, "Voice off");
  assert.match(voiceFor(page, "slot1").className, /\boff\b/);
});

test("stage pane: a row's speaker sends THAT slot and the OPPOSITE of its state", async () => {
  const page = boot({ bodies: BODIES });
  await page.refresh();
  await voiceFor(page, "slot0").fire("click");
  await flush();
  await voiceFor(page, "slot1").fire("click");
  await flush();
  assert.deepEqual(page.calls, [["setVoice", "slot0", true], ["setVoice", "slot1", false]]);
  assert.equal(voiceFor(page, "slot0").textContent, "Voice off", "the row repaints from main's answer");
  assert.equal(voiceFor(page, "slot1").textContent, "Voice on");
});

test("stage pane: a refused voice call is SAID and the row keeps its old state", async () => {
  const page = boot({ bodies: BODIES, answers: { setVoice: { ok: false, error: "voice: slot0 is not a body" } } });
  await page.refresh();
  await voiceFor(page, "slot0").fire("click");
  await flush();
  assert.equal(page.byId.get("err").textContent, "voice: slot0 is not a body");
  assert.equal(voiceFor(page, "slot0").textContent, "Voice on");
});

test("stage pane: the master switch names the current state and states its target", async () => {
  const page = boot({ bodies: BODIES });
  await page.refresh();
  assert.equal(master(page).textContent, "All voices on");
  await master(page).fire("click");
  await flush();
  assert.deepEqual(page.calls, [["setAllVoices", true]]);
  assert.equal(master(page).textContent, "All voices off");
  assert.equal(master(page).attributes["aria-pressed"], "true");
  assert.match(voiceFor(page, "slot0").className, /room-off/, "rows show that the room is muted");
});

test("stage pane: every poll paints main's reported target (no client timer)", async () => {
  const page = boot({ bodies: BODIES });
  await page.refresh();
  await master(page).fire("click");
  await flush();
  assert.equal(master(page).textContent, "All voices off");
  // Main reports the pending mute as muted while "Voices off." plays.
  page.state.allVoicesMuted = true;
  await page.refresh();
  assert.equal(master(page).textContent, "All voices off");
  // Someone unmutes from the tray: the very next poll follows main, no 15 s lag.
  page.state.allVoicesMuted = false;
  await page.refresh();
  assert.equal(master(page).textContent, "All voices on");
});

test("stage pane: a muted room on open reads as muted", async () => {
  const page = boot({ bodies: BODIES, allVoicesMuted: true });
  await page.refresh();
  assert.equal(master(page).textContent, "All voices off");
  await master(page).fire("click");
  await flush();
  assert.deepEqual(page.calls, [["setAllVoices", false]]);
});

test("main.cjs wires the stage pane's voice verbs to the cast-config switches", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const start = main.indexOf("function stagePaneImpl()");
  assert.ok(start > 0, "stagePaneImpl is gone");
  const impl = main.slice(start, main.indexOf("\n}\n", start));
  assert.match(impl, /withVoiceState\(/, "bodies must carry voiceMuted");
  assert.match(impl, /agentFor: agentForSlot/, "the row must key on the right-click's agent lookup");
  assert.match(impl, /setVoiceMuted: \(slotId, muted\) => setAgentVoiceMuted\(slotId, muted\)/);
  assert.match(impl, /setAllVoicesMuted: \(muted\) => setAllVoicesMuted\(muted\)/);
  assert.match(impl, /allVoicesMuted: \(\) => voiceAllMuted\(\)/);
});

test("the master switch's in-flight target lives in main, not a pane timer", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /require\("\.\/voice-master\.cjs"\)\.createVoiceMaster\(/);
  assert.match(main, /function voiceAllMuted\(\) \{\n\s*try \{ return voiceMaster\(\)\.target\(\);/,
    "voiceAllMuted must report the pending target, not only cast.json");
  assert.match(main, /function setAllVoicesMuted\(muted\) \{\n\s*return voiceMaster\(\)\.set\(muted\);/);
  const html = fs.readFileSync(path.join(__dirname, "stage.html"), "utf8");
  assert.doesNotMatch(html, /pendingAll|PENDING_ALL_MS/, "the pane must not guess speech length");
});
