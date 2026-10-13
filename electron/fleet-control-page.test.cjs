"use strict";

/**
 * fleet-control.html's render loop, run against a paper DOM.
 *
 * The page's presentation had no test, and it shipped three lies in a row:
 * a grey UNKNOWN pill over four "?" for the whole first probe (owner screenshot
 * 2026-09-18 07:20, read as "fleet info still busted" while a 24-73 s probe was
 * simply in flight), "GPU hold: free" painted from NO verdict (`null && x`), and
 * a "probing…" that stayed up after the verdict landed because the flag was
 * cleared after render. console-smoke.cjs can only see the pane come up; it
 * cannot hold the probe still to look at the pane mid-flight. This can.
 *
 * The script is lifted out of the html and run under `vm` over the smallest
 * document that satisfies it -- ids, dataset, classList, innerHTML/textContent,
 * children. If the page grows a DOM call this document lacks, the test throws
 * at load, which is the right failure: it means the page is asserted nowhere.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const HTML = fs.readFileSync(path.join(__dirname, "fleet-control.html"), "utf8");

/** Every <button> carrying data-bead in the html: { id, action, bead }. */
const VERBS = [...HTML.matchAll(/<button id="([^"]+)"[^>]*?data-bead="([^"]+)"[^>]*>/g)].map((m) => ({
  id: m[1], bead: m[2], action: (/data-action="([^"]+)"/.exec(m[0]) || [])[1] || null,
}));

const focused = { el: null };

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.className = "";
    this.id = "";
    this.title = "";
    this.disabled = false;
    this.scrollTop = 0;
    this.listeners = {};
    this._text = "";
    this.hidden = false;
    this.attrs = {};
    this.style = { setProperty(k, v) { this[k] = v; } };
    this.classList = classListOf(this);
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  focus() { focused.el = this; }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.children[0] ?? null; }
  get lastChild() { return this.children[this.children.length - 1] ?? null; }
  get scrollHeight() { return 0; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); child.parent = null; return child; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(v) { this.children = []; this._text = String(v).replace(/<[^>]*>/g, ""); }
  get innerHTML() { return this._text; }
  querySelector(sel) {
    if (!sel.startsWith(".")) return null;
    return this.children.find((c) => c.classList.contains(sel.slice(1))) ?? null;
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({}); }
}

/** A classList over `className`, the four verbs the page uses. */
function classListOf(el) {
  const read = () => new Set(el.className.split(/\s+/).filter(Boolean));
  const write = (set) => { el.className = [...set].join(" "); };
  const list = {
    add(c) { const s = read(); s.add(c); write(s); },
    remove(c) { const s = read(); s.delete(c); write(s); },
    contains(c) { return read().has(c); },
    toggle(c, force) {
      const on = force === undefined ? !list.contains(c) : Boolean(force);
      if (on) list.add(c); else list.remove(c);
      return on;
    },
  };
  return list;
}

function byId(id, tag = "div") { const e = new Element(tag); e.id = id; return e; }

/** Load the page's script over a fresh paper document with a controllable `window.fleet`. */
function mount({ status } = {}) {
  const ids = {};
  for (const id of ["log", "pill", "s-running", "s-masked", "s-vram", "s-hold", "holders", "surfaces", "hint",
    "hud", "statusline", "stage", "sky", "orbit", "dock", "dock-title", "dock-close", "fleet-detail", "arc-detail",
    "host", "host-line", "door-detail", "b-help", "cli-hints"]) {
    ids[id] = byId(id);
  }
  ids.pill.dataset.state = "UNKNOWN";
  ids.pill.textContent = "…";
  ids.dock.hidden = true;
  for (const box of ["holders", "surfaces"]) ids[box].appendChild(new Element("div")); // the .k caption
  for (const [id, bead] of [["bead-host", "host"], ["bead-fleet", "fleet"], ["bead-gpu", "gpu"], ["bead-arc", "arc"]]) {
    const b = byId(id, "button");
    b.dataset.bead = bead;
    const bv = new Element("span"); bv.className = "bv"; b.appendChild(bv);
    ids[id] = b;
  }
  // Every verb button the html declares, with its bead -- parsed, not retyped here.
  const actions = [];
  for (const v of VERBS) {
    const b = byId(v.id, "button");
    if (v.action) b.dataset.action = v.action;
    b.dataset.bead = v.bead;
    const d = new Element("span"); d.className = "d"; d.textContent = `desc ${v.action || v.id}`;
    b.appendChild(d);
    ids[v.id] = b;
    if (v.action) actions.push(b);
  }
  ids["b-refresh"] = byId("b-refresh", "button");

  const calls = [];
  const runs = [];
  const opened = [];
  const keydown = [];
  const fleet = {
    status: (opts) => { calls.push(opts); return status ? status(opts) : Promise.resolve(null); },
    doors: () => Promise.resolve([]),
    run: (a) => { runs.push(a); return Promise.resolve({ ok: true }); },
    onProgress: () => () => {},
    close: () => {},
    open: (u) => { opened.push(u); },
  };
  const document = {
    getElementById: (id) => ids[id] ?? null,
    querySelectorAll: (sel) => (sel === "button[data-action]" ? actions : []),
    createElement: (tag) => new Element(tag),
    addEventListener: (type, fn) => { if (type === "keydown") keydown.push(fn); },
    get activeElement() { return focused.el; },
  };
  const intervals = [];
  const win = { fleet };
  const sandbox = {
    document,
    window: win,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 1; },
    setTimeout,
    clearTimeout,
    console,
  };
  const script = /<script>([\s\S]*?)<\/script>/.exec(HTML);
  assert.ok(script, "fleet-control.html has one inline script");
  vm.runInNewContext(script[1], vm.createContext(sandbox), { filename: "fleet-control.html" });
  const text = (id) => ids[id].textContent;
  return { ids, calls, intervals, text, runs, opened, keydown, pill: ids.pill,
    logLines: () => ids.log.children.map((c) => c.textContent) };
}

const GOOD = () => ({
  ok: true,
  fleet: { running: 145, units: 212, masked: 0 },
  held: false,
  vram: { used_mib: 31973, total_mib: 32607 },
  gpu_holders: [{ pid: 4242, gib: 7.1, name: "ComfyUI", hint: "SDXL" }],
  surfaces: [{ label: "Pulse", url: "https://pulse.example", up: true, ms: 12, detail: "HTTP 200" }],
  state: {},
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("first probe in flight: pill PROBING (BUSY's family), every counter says probing…, never free", async () => {
  let release;
  const page = mount({ status: () => new Promise((resolve) => { release = resolve; }) });
  await tick();
  assert.equal(page.pill.dataset.state, "PROBING");
  assert.equal(page.pill.textContent, "PROBING");
  // The point is that PROBING reads as BUSY's sibling, so assert they share a
  // background -- not which blue. The blue is the family's token now (it was a
  // literal #3b82f6 until the panes stopped carrying private palettes).
  const pillBg = (state) => (HTML.match(new RegExp(`#pill\\[data-state="${state}"\\]\\s*\\{[^}]*background:\\s*([^;]+);`)) || [])[1];
  assert.ok(pillBg("BUSY"), "BUSY has no background");
  assert.equal(pillBg("PROBING"), pillBg("BUSY"), "PROBING is styled in BUSY's blue");
  assert.notEqual(pillBg("PROBING"), "var(--unknown)", "a grey PROBING pill reads as broken");
  for (const id of ["s-running", "s-masked", "s-vram", "s-hold"]) {
    assert.equal(page.text(id), "probing…", `${id} while the first probe runs`);
    assert.ok(page.ids[id].classList.contains("probing"), `${id} carries the probing class`);
  }
  assert.notEqual(page.text("s-hold"), "free", "render(null) must never claim the GPU is free");
  assert.match(page.text("holders"), /probing…/);
  assert.match(page.text("surfaces"), /probing…/);
  assert.ok(page.logLines().some((l) => /probing the fleet/.test(l)), "the log says a probe started");
  // JSON, not deepEqual: the opts object was built in the vm realm and carries its Object.prototype.
  assert.equal(JSON.stringify(page.calls), JSON.stringify([{ maxAgeMs: 0 }]), "the first probe is forced fresh");

  // The verdict lands: every placeholder is replaced, in the same paint.
  release(GOOD());
  await tick(); await tick();
  assert.equal(page.pill.dataset.state, "UP");
  assert.equal(page.pill.textContent, "UP");
  assert.equal(page.text("s-running"), "145");
  assert.equal(page.text("s-masked"), "0 / 212");
  assert.equal(page.text("s-vram"), "31.2 / 32 GiB");
  assert.equal(page.text("s-hold"), "free");
  for (const id of ["s-running", "s-masked", "s-vram", "s-hold"]) {
    assert.ok(!page.ids[id].classList.contains("probing"), `${id} dropped the probing class`);
  }
  assert.match(page.text("holders"), /7\.10 GiB.*ComfyUI \(pid 4242\)/);
  assert.doesNotMatch(page.text("holders"), /probing/);
  assert.match(page.text("surfaces"), /Pulse/);
  assert.doesNotMatch(page.text("surfaces"), /probing/);
  assert.equal(page.text("hint"), "auto-refresh every 30 s");
});

test("a verdict without host enrichment does not leave probing… behind (flag cleared before paint)", async () => {
  const bare = GOOD();
  delete bare.gpu_holders;
  delete bare.surfaces;
  const page = mount({ status: () => Promise.resolve(bare) });
  await tick(); await tick();
  assert.equal(page.pill.textContent, "UP");
  assert.doesNotMatch(page.text("holders"), /probing/);
  assert.match(page.text("holders"), /not in this verdict/);
  assert.doesNotMatch(page.text("surfaces"), /probing/);
});

test("held fleet: GPU hold reads HELD and the pill GPU QUIET", async () => {
  const st = GOOD(); st.held = true;
  const page = mount({ status: () => Promise.resolve(st) });
  await tick(); await tick();
  assert.equal(page.text("s-hold"), "HELD");
  assert.equal(page.pill.textContent, "GPU QUIET");
});

test("cannotJudge with no stale verdict: pill CANNOT JUDGE, counters ?, hold ?, the error in the log", async () => {
  const page = mount({ status: () => Promise.resolve({ ok: false, cannotJudge: true, error: "the Debian distro did not answer" }) });
  await tick(); await tick();
  assert.equal(page.pill.dataset.state, "CANNOT JUDGE");
  assert.equal(page.pill.textContent, "CANNOT JUDGE");
  for (const id of ["s-running", "s-masked", "s-vram", "s-hold"]) assert.equal(page.text(id), "?", id);
  assert.ok(page.logLines().some((l) => /CANNOT JUDGE: the Debian distro did not answer/.test(l)));
  assert.match(HTML, /#pill\[data-state="CANNOT JUDGE"\]/, "CANNOT JUDGE has its own style");
});

test("cannotJudge WITH a stale verdict: pill STALE, the old numbers with their age, hold from the old verdict", async () => {
  const page = mount({
    status: () => Promise.resolve({
      ok: false, cannotJudge: true, error: "podman ps timed out",
      stale: { age_ms: 42_000, at: 1, reason: "podman ps timed out", verdict: GOOD() },
    }),
  });
  await tick(); await tick();
  assert.equal(page.pill.dataset.state, "STALE");
  assert.match(page.text("s-running"), /^145 · 42 s ago$/);
  assert.equal(page.text("s-hold"), "free");
  assert.ok(page.logLines().some((l) => /STALE \(42 s old/.test(l)));
});

test("the IPC itself rejecting is a CANNOT JUDGE verdict, not a pane stuck on probing…", async () => {
  const page = mount({ status: () => Promise.reject(new Error("No handler registered for 'desk:fleet-status'")) });
  await tick(); await tick();
  assert.equal(page.pill.textContent, "CANNOT JUDGE");
  assert.equal(page.text("s-running"), "?");
  assert.ok(page.logLines().some((l) => /No handler registered/.test(l)));
});

test("a later refresh keeps the last numbers up and says refreshing… in the hint, not PROBING", async () => {
  let n = 0;
  let release;
  const page = mount({
    status: () => (n++ === 0 ? Promise.resolve(GOOD()) : new Promise((resolve) => { release = resolve; })),
  });
  await tick(); await tick();
  assert.equal(page.pill.textContent, "UP");
  assert.equal(page.intervals.length, 1, "one auto-refresh timer");
  page.intervals[0].fn();
  await tick();
  assert.equal(page.pill.textContent, "UP", "the pill keeps the last verdict during a re-probe");
  assert.equal(page.text("s-running"), "145");
  assert.equal(page.text("hint"), "refreshing…");
  const st = GOOD(); st.fleet.running = 140;
  release(st);
  await tick(); await tick();
  assert.equal(page.text("s-running"), "140");
  assert.equal(page.text("hint"), "auto-refresh every 30 s");
});

// ── bead-space (owner, 2026-10-13): one spatial view, verbs by context ──────

/** The fifteen actions the list layout carried. None may be lost or doubled. */
const ORIGINAL_ACTIONS = ["fleet-sleep", "fleet-wake", "gpu-sleep", "gpu-wake", "fleet-critical",
  "arc-now", "arc-start", "arc-status", "arc-stop",
  "host-status", "host-start", "host-restart", "host-stop", "host-reattach", "host-migrate-dryrun"];

test("every original action is reachable exactly once, from the bead that owns it", () => {
  const withAction = VERBS.filter((v) => v.action);
  const counted = {};
  for (const v of withAction) counted[v.action] = (counted[v.action] || 0) + 1;
  for (const a of ORIGINAL_ACTIONS) assert.equal(counted[a], 1, `${a} appears ${counted[a] || 0} times`);
  assert.deepEqual(Object.keys(counted).sort(), [...ORIGINAL_ACTIONS].sort(), "no new action slipped in");
  const owner = Object.fromEntries(withAction.map((v) => [v.action, v.bead]));
  // the easy buttons: always visible, never inside a dock
  assert.equal(owner["fleet-sleep"], "hero");
  assert.equal(owner["fleet-wake"], "hero");
  assert.equal(owner["fleet-critical"], "fleet");
  for (const a of ["gpu-sleep", "gpu-wake"]) assert.equal(owner[a], "gpu", a);
  for (const a of ORIGINAL_ACTIONS.filter((x) => x.startsWith("arc-"))) assert.equal(owner[a], "arc", a);
  for (const a of ORIGINAL_ACTIONS.filter((x) => x.startsWith("host-"))) assert.equal(owner[a], "host", a);
  const adopt = VERBS.find((v) => v.id === "b-adopt");
  assert.ok(adopt && adopt.bead === "fleet" && !adopt.action, "Adopt lives in the Fleet dock, wired by id");
  // the page still double-confirms exactly what it did before
  assert.match(HTML, /DESTRUCTIVE = new Set\(\["down", "gaming", "gpu-sleep", "fleet-sleep", "fleet-critical", "arc-stop",\s*"host-start", "host-stop", "host-restart", "host-reattach"\]\)/);
});

test("selecting a bead shows only its verbs; the hero buttons never hide", async () => {
  const page = mount({ status: () => Promise.resolve(GOOD()) });
  await tick(); await tick();
  assert.ok(page.ids.dock.hidden, "no dock before a selection");
  for (const bead of ["host", "fleet", "gpu", "arc"]) {
    page.ids[`bead-${bead}`].click();
    assert.equal(page.ids.dock.hidden, false, `${bead} opens the dock`);
    const shown = VERBS.filter((v) => v.bead !== "hero" && !page.ids[v.id].hidden).map((v) => v.id);
    const expected = VERBS.filter((v) => v.bead === bead).map((v) => v.id);
    assert.deepEqual(shown, expected, `${bead} dock`);
    assert.equal(page.ids[`bead-${bead}`].getAttribute("aria-pressed"), "true");
    assert.equal(page.ids["b-down"].hidden, false, "Sleep everything stays visible");
    assert.equal(page.ids["b-up"].hidden, false, "Wake fleet stays visible");
    assert.ok(VERBS.some((v) => v.bead === bead && focused.el === page.ids[v.id]), `${bead}: focus moves into the dock`);
  }
  for (const fn of page.keydown) fn({ key: "Escape" });
  assert.ok(page.ids.dock.hidden, "Escape closes the dock first");
  assert.equal(focused.el, page.ids["bead-arc"], "and hands focus back to the bead");
});

test("dock verbs keep the two-click confirm and run the SAME action", async () => {
  const page = mount({ status: () => Promise.resolve(GOOD()) });
  await tick(); await tick();
  page.ids["bead-gpu"].click();
  page.ids["b-gaming"].click();
  assert.equal(page.runs.length, 0, "one click only arms gpu-sleep");
  assert.ok(page.ids["b-gaming"].classList.contains("confirm"));
  page.ids["b-gaming"].click();
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual([...page.runs], ["gpu-sleep"]);
  // the hero button: one tap + confirm, fleet-sleep exactly
  page.ids["b-down"].click();
  assert.equal(page.runs.length, 1, "one tap only arms Sleep everything");
  page.ids["b-down"].click();
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual([...page.runs], ["gpu-sleep", "fleet-sleep"]);
});

test("doors are beads; selecting one offers Open, which opens that door's url", async () => {
  const page = mount({ status: () => Promise.resolve(GOOD()) });
  await tick(); await tick();
  const door = page.ids.surfaces.children.find((c) => c.dataset.bead === "door:0");
  assert.ok(door, "the Pulse door is a bead");
  assert.equal(door.dataset.up, "1");
  door.click();
  assert.match(page.text("dock-title"), /Pulse/);
  assert.equal(page.ids["b-open-door"].hidden, false);
  page.ids["b-open-door"].click();
  assert.deepEqual([...page.opened], ["https://pulse.example"]);
});

test("the log says a repeated verdict once, with a count", async () => {
  const page = mount({ status: () => Promise.resolve({ ok: false, cannotJudge: true, error: "the awnix WSL distro did not answer" }) });
  await tick(); await tick();
  for (let i = 0; i < 3; i++) { page.intervals[0].fn(); await tick(); await tick(); }
  const lines = page.logLines().filter((l) => /CANNOT JUDGE/.test(l));
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /\(x4\)$/);
});

test("lines that differ only in their numbers are the same news (STALE 72 s / 102 s)", async () => {
  let age = 42_000;
  const page = mount({
    status: () => Promise.resolve({ ok: false, cannotJudge: true, error: "podman ps timed out",
      stale: { age_ms: (age += 30_000), at: 1, reason: "podman ps timed out", verdict: GOOD() } }),
  });
  await tick(); await tick();
  page.intervals[0].fn(); await tick(); await tick();
  const lines = page.logLines().filter((l) => /STALE/.test(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /STALE \(102 s old.*\(x2\)$/);
});

test("CANNOT JUDGE: one status line replaces the four tiles", async () => {
  const page = mount({ status: () => Promise.resolve({ ok: false, cannotJudge: true, error: "the awnix WSL distro did not answer. Long tail here." }) });
  await tick(); await tick();
  assert.equal(page.ids.hud.hidden, true, "the four '?' tiles are hidden");
  assert.equal(page.ids.statusline.hidden, false);
  assert.equal(page.text("statusline"), "CANNOT JUDGE — the awnix WSL distro did not answer.");
  assert.equal(page.ids["bead-host"].dataset.health, "down", "the core says the host does not answer");
  const good = mount({ status: () => Promise.resolve(GOOD()) });
  await tick(); await tick();
  assert.equal(good.ids.hud.hidden, false, "a verdict brings the tiles back");
  assert.equal(good.ids.statusline.hidden, true);
  assert.equal(good.ids["bead-fleet"].dataset.health, "up");
});

test("the CLI hints sit behind the ? toggle", () => {
  assert.match(HTML, /<footer id="cli-hints" hidden>/);
  const page = mount({ status: () => Promise.resolve(GOOD()) });
  page.ids["cli-hints"].hidden = true; // as the html ships it
  page.ids["b-help"].click();
  assert.equal(page.ids["cli-hints"].hidden, false);
  assert.equal(page.ids["b-help"].getAttribute("aria-expanded"), "true");
});

test("reduced motion is honoured and nothing pulls a script past the CSP", () => {
  assert.match(HTML, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(HTML, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.doesNotMatch(HTML, /<script src=/, "the CSP admits inline script only");
});
