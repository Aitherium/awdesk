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
const PAGE = fs.readFileSync(path.join(__dirname, "fleet-page.js"), "utf8");
const OVERVIEW = fs.readFileSync(path.join(__dirname, "fleet-overview.js"), "utf8");

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
function mount({ status, spaceAvailable, network } = {}) {
  const ids = {};
  for (const id of ["log", "pill", "s-running", "s-down", "s-parked", "s-vram", "holders", "surfaces", "hint",
    "hud", "statusline", "stage", "net", "netnote", "dock", "dock-title", "dock-close", "fleet-detail", "arc-detail",
    "host", "host-line", "door-detail", "svc-detail", "brick-detail", "b-help", "cli-hints",
    "overview", "attention-list", "group-list"]) {
    ids[id] = byId(id);
  }
  ids.net.hidden = /<div id="net" hidden>/.test(HTML); // as the html ships it
  ids.netnote.hidden = /id="netnote" hidden/.test(HTML);
  ids.pill.dataset.state = "UNKNOWN";
  ids.pill.textContent = "…";
  ids.dock.hidden = true;
  ids.log.hidden = true;
  ids.holders.appendChild(new Element("div")); // the .k caption
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
  ids["b-view"] = byId("b-view", "button");
  // "Open in Space": the anchor's data-space, read from the html like the verbs.
  ids["b-space"] = byId("b-space", "a");
  ids["b-space"].dataset.space = (/<a id="b-space"[^>]*data-space="([^"]+)"/.exec(HTML) || [])[1];
  ids["b-space"].hidden = /<a id="b-space" hidden/.test(HTML); // as the html ships it

  const calls = [];
  const runs = [];
  const services = [];
  const opened = [];
  const keydown = [];
  const fleet = {
    status: (opts) => { calls.push(opts); return status ? status(opts) : Promise.resolve(null); },
    doors: () => Promise.resolve([]),
    run: (a) => { runs.push(a); return Promise.resolve({ ok: true }); },
    onProgress: () => () => {},
    close: () => {},
    open: (u) => { opened.push(u); },
    service: (verb, name) => {
      services.push([verb, name]);
      return Promise.resolve(verb === "show" ? { ok: true, log: "line one\nboom: port in use", status: "exited" }
        : { ok: true, verified: "running" });
    },
  };
  if (spaceAvailable !== undefined) fleet.spaceAvailable = () => spaceAvailable();
  if (network !== undefined) fleet.network = () => Promise.resolve(network);
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
  const ctx = vm.createContext(sandbox);
  vm.runInContext(OVERVIEW, ctx, { filename: "fleet-overview.js" });
  vm.runInContext(PAGE, ctx, { filename: "fleet-page.js" });
  const text = (id) => ids[id].textContent;
  return { ids, calls, intervals, text, runs, opened, keydown, services, pill: ids.pill, pane: () => win.fleetPane,
    refreshTimer: () => intervals.find((i) => i.ms === 30_000),
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
  const pillBg = (state) => (HTML.match(new RegExp(`#pill\\[data-state="${state}"\\]\\s*\\{[^}]*background:\\s*([^;]+);`)) || [])[1];
  assert.ok(pillBg("BUSY"), "BUSY has no background");
  assert.equal(pillBg("PROBING"), pillBg("BUSY"), "PROBING is styled in BUSY's blue");
  for (const id of ["s-running", "s-vram"]) {
    assert.equal(page.text(id), "probing…", `${id} while the first probe runs`);
    assert.ok(page.ids[id].classList.contains("probing"), `${id} carries the probing class`);
  }
  assert.match(page.text("holders"), /probing…/);
  assert.match(page.text("statusline"), /probing the fleet/, "the status line says a probe is running");
  assert.equal(page.logLines().length, 0, "a probe is not action output: the log stays empty");
  assert.equal(JSON.stringify(page.calls), JSON.stringify([{ maxAgeMs: 0 }]), "the first probe is forced fresh");

  release(GOOD());
  await tick(); await tick();
  assert.equal(page.pill.dataset.state, "UP");
  assert.equal(page.pill.textContent, "UP");
  assert.equal(page.text("s-running"), "145");
  assert.equal(page.text("s-vram"), "31.2 used · 0.6 free GiB", "VRAM is used AND free, not a ratio to do in your head");
  assert.match(page.text("statusline"), /^145 running/);
  assert.match(page.text("holders"), /7\.10 GiB.*ComfyUI \(pid 4242\)/);
  const door = page.pane().data().nodes.find((n) => n.id === "door:0");
  assert.ok(door && door.title === "Pulse" && door.meta.health === "ok", "the Pulse door is a node of the network");
  assert.equal(page.text("hint"), "auto-refresh every 30 s");
});

test("a verdict without host enrichment does not leave probing… behind (flag cleared before paint)", async () => {
  const bare = GOOD();
  delete bare.gpu_holders;
  delete bare.surfaces;
  const page = mount({ status: () => Promise.resolve(bare) });
  await tick(); await tick();
  assert.equal(page.pill.textContent, "UP");
  assert.match(page.text("holders"), /not in this verdict/);
});

test("held fleet: GPU hold reads HELD and the pill GPU QUIET", async () => {
  const st = GOOD(); st.held = true;
  const page = mount({ status: () => Promise.resolve(st) });
  await tick(); await tick();
  assert.match(page.text("statusline"), /GPU held/);
  assert.equal(page.pill.textContent, "GPU QUIET");
});

test("cannotJudge with no stale verdict: pill CANNOT JUDGE, counters say WHY (never a bare ?), reason in the status line", async () => {
  const page = mount({ status: () => Promise.resolve({ ok: false, cannotJudge: true, error: "the Debian distro did not answer. Nothing changed." }) });
  await tick(); await tick();
  assert.equal(page.pill.dataset.state, "CANNOT JUDGE");
  for (const id of ["s-running", "s-down", "s-parked", "s-vram"]) {
    assert.notEqual(page.text(id), "?", `${id} is a bare ?`);
    assert.equal(page.text(id), "unknown", id);
    assert.ok(page.ids[id].title, `${id} carries its reason as a tooltip`);
  }
  assert.equal(page.ids["s-running"].title, "status probe failed: the Debian distro did not answer");
  assert.equal(page.text("statusline"), "status probe failed: the Debian distro did not answer");
  assert.equal(page.ids.statusline.dataset.tone, "bad");
  assert.equal(page.logLines().length, 0);
  assert.equal(page.pane().data().nodes.find((n) => n.id === "ctl:host").meta.health, "down", "the host node says it does not answer");
});

test("a STALE verdict is CANNOT JUDGE in the pill -- never UP -- with the old numbers and their age", async () => {
  const page = mount({
    status: () => Promise.resolve({
      ok: false, cannotJudge: true, error: "podman ps timed out",
      stale: { age_ms: 42_000, at: 1, reason: "podman ps timed out", verdict: GOOD() },
    }),
  });
  await tick(); await tick();
  assert.equal(page.pill.dataset.state, "CANNOT JUDGE");
  assert.equal(page.pill.textContent, "CANNOT JUDGE");
  assert.match(page.text("statusline"), /^fresh probe failed \(podman ps timed out\) -- the numbers are 42 s old: 145 running then$/);
  assert.match(page.text("s-running"), /^145 · 42 s ago$/);
  assert.match(page.text("s-vram"), /^31\.2 used · 0\.6 free GiB · 42 s ago$/);
  assert.notEqual(page.pane().data().nodes.find((n) => n.id === "ctl:fleet").meta.health, "ok", "a stale fleet is not drawn healthy");
});

test("the IPC itself rejecting is a CANNOT JUDGE verdict, not a pane stuck on probing…", async () => {
  const page = mount({ status: () => Promise.reject(new Error("No handler registered for 'desk:fleet-status'")) });
  await tick(); await tick();
  assert.equal(page.pill.textContent, "CANNOT JUDGE");
  assert.equal(page.text("s-running"), "unknown");
  assert.match(page.text("statusline"), /^status probe failed: No handler registered/);
});

test("repeated CANNOT JUDGE refreshes: ONE status line, nothing in the log, the pill agrees (no '(x6)' spam)", async () => {
  const page = mount({ status: () => Promise.resolve({ ok: false, cannotJudge: true, error: "the awnix WSL distro did not answer" }) });
  await tick(); await tick();
  for (let i = 0; i < 6; i++) { page.refreshTimer().fn(); await tick(); await tick(); }
  assert.equal(page.logLines().length, 0, page.logLines().join("\n"));
  assert.equal(page.ids.log.hidden, true, "the empty log is not drawn");
  assert.equal(page.pill.dataset.state, "CANNOT JUDGE");
  assert.equal(page.text("statusline"), "status probe failed: the awnix WSL distro did not answer");
});

test("a later refresh keeps the last numbers up and says refreshing… in the hint, not PROBING", async () => {
  let n = 0;
  let release;
  const page = mount({
    status: () => (n++ === 0 ? Promise.resolve(GOOD()) : new Promise((resolve) => { release = resolve; })),
  });
  await tick(); await tick();
  assert.equal(page.pill.textContent, "UP");
  assert.ok(page.refreshTimer(), "one 30 s auto-refresh timer");
  page.refreshTimer().fn();
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

// ── the network: verbs by node ───────────────────────────────────────────────

const ORIGINAL_ACTIONS = ["fleet-sleep", "fleet-wake", "gpu-sleep", "gpu-wake", "fleet-critical",
  "arc-now", "arc-start", "arc-status", "arc-stop",
  "host-status", "host-start", "host-restart", "host-stop", "host-reattach", "host-migrate-dryrun"];

test("every original action is reachable exactly once, from the node that owns it", () => {
  const withAction = VERBS.filter((v) => v.action);
  const counted = {};
  for (const v of withAction) counted[v.action] = (counted[v.action] || 0) + 1;
  for (const a of ORIGINAL_ACTIONS) assert.equal(counted[a], 1, `${a} appears ${counted[a] || 0} times`);
  assert.deepEqual(Object.keys(counted).sort(), [...ORIGINAL_ACTIONS].sort(), "no new action slipped in");
  const owner = Object.fromEntries(withAction.map((v) => [v.action, v.bead]));
  assert.equal(owner["fleet-sleep"], "hero");
  assert.equal(owner["fleet-wake"], "hero");
  assert.equal(owner["fleet-critical"], "fleet");
  for (const a of ["gpu-sleep", "gpu-wake"]) assert.equal(owner[a], "gpu", a);
  for (const a of ORIGINAL_ACTIONS.filter((x) => x.startsWith("arc-"))) assert.equal(owner[a], "arc", a);
  for (const a of ORIGINAL_ACTIONS.filter((x) => x.startsWith("host-"))) assert.equal(owner[a], "host", a);
  const adopt = VERBS.find((v) => v.id === "b-adopt");
  assert.ok(adopt && adopt.bead === "fleet" && !adopt.action, "Adopt lives in the Fleet dock, wired by id");
  assert.match(PAGE, /DESTRUCTIVE = new Set\(\["down", "gaming", "gpu-sleep", "fleet-sleep", "fleet-critical", "arc-stop",\s*"host-start", "host-stop", "host-restart", "host-reattach"\]\)/);
});

test("selecting a node shows only its verbs; the hero buttons never hide", async () => {
  const page = mount({ status: () => Promise.resolve(GOOD()) });
  await tick(); await tick();
  assert.ok(page.ids.dock.hidden, "no dock before a selection");
  for (const bead of ["host", "fleet", "gpu", "arc"]) {
    page.pane().select(bead);
    assert.equal(page.ids.dock.hidden, false, `${bead} opens the dock`);
    const shown = VERBS.filter((v) => v.bead !== "hero" && !page.ids[v.id].hidden).map((v) => v.id);
    const expected = VERBS.filter((v) => v.bead === bead).map((v) => v.id);
    assert.deepEqual(shown, expected, `${bead} dock`);
    assert.equal(page.ids["b-down"].hidden, false, "Sleep everything stays visible");
    assert.equal(page.ids["b-up"].hidden, false, "Wake fleet stays visible");
    assert.ok(VERBS.some((v) => v.bead === bead && focused.el === page.ids[v.id]), `${bead}: focus moves into the dock`);
  }
  for (const fn of page.keydown) fn({ key: "Escape" });
  assert.ok(page.ids.dock.hidden, "Escape closes the dock first");
});

test("dock verbs keep the two-click confirm and run the SAME action", async () => {
  const page = mount({ status: () => Promise.resolve(GOOD()) });
  await tick(); await tick();
  page.pane().select("gpu");
  page.ids["b-gaming"].click();
  assert.equal(page.runs.length, 0, "one click only arms gpu-sleep");
  assert.ok(page.ids["b-gaming"].classList.contains("confirm"));
  page.ids["b-gaming"].click();
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual([...page.runs], ["gpu-sleep"]);
  page.ids["b-down"].click();
  assert.equal(page.runs.length, 1, "one tap only arms Sleep everything");
  page.ids["b-down"].click();
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual([...page.runs], ["gpu-sleep", "fleet-sleep"]);
});

test("a door node offers Open, which opens that door's url", async () => {
  const page = mount({ status: () => Promise.resolve(GOOD()) });
  await tick(); await tick();
  page.pane().select("door:0");
  assert.match(page.text("dock-title"), /Pulse/);
  assert.equal(page.ids["b-open-door"].hidden, false);
  page.ids["b-open-door"].click();
  assert.deepEqual([...page.opened], ["https://pulse.example"]);
});

const NETWORK = {
  ok: true, source: "remote", nodes: [
    { id: "svc:genesis", title: "Genesis", group: "Core", health: { state: "ok", reason: "" } },
    { id: "svc:veil", title: "Veil", group: "Core", health: { state: "down", reason: "no answer" } },
    { id: "svc:comfy", title: "ComfyUI", group: "Gpu", health: { state: "parked", reason: "" } },
  ],
  links: [{ source: "svc:veil", target: "svc:genesis", rel: "depends" }],
};

test("services join the network with their health; the map's counts reach the ONE status line", async () => {
  const page = mount({ status: () => Promise.resolve(GOOD()), network: NETWORK });
  await tick(); await tick(); await tick();
  const d = page.pane().data();
  assert.equal(d.nodes.find((n) => n.id === "svc:veil").meta.health, "down");
  assert.ok(d.links.some((l) => l.source === "svc:veil" && l.target === "svc:genesis"), "depends is an edge");
  assert.ok(d.links.some((l) => l.source === "ctl:gpu" && l.target === "svc:comfy"), "the GPU links to its own services");
  assert.equal(page.pill.dataset.state, "UP");
  assert.match(page.text("statusline"), /map: 3 services, 1 down, 1 parked/);
  assert.equal(page.ids.statusline.dataset.tone, "warn", "UP with a service down reads amber, not all-clear");
});

test("selecting a service shows its health and dependencies and opens it in Space", async () => {
  const page = mount({ status: () => Promise.resolve(GOOD()), network: NETWORK, spaceAvailable: () => Promise.resolve(true) });
  await tick(); await tick(); await tick();
  page.pane().selectNode("svc:veil");
  assert.equal(page.text("dock-title"), "Veil");
  assert.match(page.text("svc-detail"), /down -- no answer/);
  assert.match(page.text("svc-detail"), /depends on: Genesis/);
  assert.equal(page.ids["b-node-space"].hidden, false);
  page.ids["b-node-space"].click();
  assert.deepEqual([...page.opened], ["aither://space/?at=svc%3Aveil"]);
});

test("the CLI hints sit behind the ? toggle", () => {
  assert.match(HTML, /<footer id="cli-hints" hidden>/);
  const page = mount({ status: () => Promise.resolve(GOOD()) });
  page.ids["cli-hints"].hidden = true;
  page.ids["b-help"].click();
  assert.equal(page.ids["cli-hints"].hidden, false);
  assert.equal(page.ids["b-help"].getAttribute("aria-expanded"), "true");
});

test("the CSP admits only the page's own files: the vendored engine and fleet-page.js, no inline script", () => {
  assert.match(HTML, /script-src file:;/);
  assert.doesNotMatch(HTML, /<script>/, "no inline script");
  const srcs = [...HTML.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ["vendor/bead-space/bead-space.iife.js", "fleet-overview.js", "fleet-page.js"]);
  assert.match(HTML, /@media \(prefers-reduced-motion: reduce\)/);
});

test("the host line says what the fleet probe proved, not 'not probed yet' (2026-10-13)", async () => {
  const st = GOOD(); st.systemd = "degraded";
  const page = mount({ status: () => Promise.resolve(st) });
  await tick(); await tick();
  assert.match(page.text("host-line"), /distro answers · systemd degraded · 145 containers/);
});

test("the Sleep button no longer promises the customer-facing set stays up", () => {
  assert.doesNotMatch(HTML, /Customer-facing set stays up/);
  assert.match(HTML, /customer-facing sites included/);
});

test("Open in Space: one quiet link, sent through window.fleet.open (never a navigation or inline handler)", async () => {
  const tag = (/<a id="b-space"[^>]*>[^<]*<\/a>/.exec(HTML) || [])[0];
  assert.ok(tag, "fleet-control.html carries the b-space link");
  assert.match(tag, /data-space="aither:\/\/space\/\?at=galaxy:fleet"/, "it targets the fleet galaxy");
  assert.doesNotMatch(tag, /\son[a-z]+=/i, "no inline event handler on the link");
  const page = mount({ status: () => Promise.resolve(GOOD()), spaceAvailable: () => Promise.resolve(true) });
  await tick(); await tick();
  assert.equal(page.ids["b-space"].hidden, false, "main reported a Space pane: the link shows");
  let prevented = false;
  for (const fn of page.ids["b-space"].listeners.click || []) fn({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true, "the anchor never navigates the page itself");
  assert.deepEqual(page.opened, ["aither://space/?at=galaxy:fleet"], "the bridge carries the deep link");
});

test("Open in Space stays hidden unless main reports a Space pane (no dead link on a build without one)", async () => {
  assert.match(HTML, /<a id="b-space" hidden /, "the html ships the link hidden");
  for (const [label, answer] of [["no Space pane", () => Promise.resolve(false)],
    ["a failed probe", () => Promise.reject(new Error("no handler"))], ["an older preload", undefined]]) {
    const page = mount({ status: () => Promise.resolve(GOOD()), spaceAvailable: answer });
    await tick(); await tick();
    assert.equal(page.ids["b-space"].hidden, true, label);
  }
});

// ── the overview (owner 2026-11-18: "can we make this better and work?") ──────────

const SICK = {
  ok: true, source: "genesis", nodes: [
    { id: "svc:genesis", title: "Genesis", group: "Core", health: { state: "ok", reason: "" }, unit: "aither-genesis" },
    { id: "svc:avatars", title: "AitherAvatars", group: "Platform", health: { state: "down", reason: "Watch: offline" },
      unit: "aither-avatars", criticality: "optional" },
    { id: "svc:cognition", title: "CognitionAdvanced", group: "Cognition", health: { state: "down", reason: "Watch: offline" },
      unit: "aither-cognition-advanced", criticality: "core" },
    { id: "svc:alerts", title: "AlertManager", group: "Monitoring", health: { state: "degraded", reason: "relay missing" },
      unit: "aither-alertmanager" },
    { id: "ctr:leftover", title: "leftover", group: "Parked", health: { state: "parked", reason: "nothing runs it" }, unit: null },
  ],
  links: [],
};

test("the DEFAULT view is the overview: the network map is behind a toggle", async () => {
  assert.match(HTML, /<div id="net" hidden>/, "the map ships hidden");
  const page = mount({ status: () => Promise.resolve(GOOD()), network: SICK });
  await tick(); await tick(); await tick();
  assert.equal(page.pane().view(), "overview");
  assert.equal(page.ids.overview.hidden, false);
  assert.equal(page.ids.net.hidden, true);
  page.ids["b-view"].click();
  assert.equal(page.pane().view(), "map");
  assert.equal(page.ids.net.hidden, false, "the toggle shows the map");
  assert.equal(page.ids.overview.hidden, true);
  assert.equal(page.text("b-view"), "Show overview");
  page.ids["b-view"].click();
  assert.equal(page.pane().view(), "overview");
});

test("the header counts are real: running, down (+degraded), parked, VRAM used/free", async () => {
  const page = mount({ status: () => Promise.resolve(GOOD()), network: SICK });
  await tick(); await tick(); await tick();
  assert.equal(page.text("s-running"), "145");
  assert.equal(page.text("s-down"), "2 +1 degraded");
  assert.equal(page.text("s-parked"), "1");
  assert.equal(page.text("s-vram"), "31.2 used · 0.6 free GiB");
});

test("needs-you: down before degraded, core before optional, each with Restart and Logs; parked is not on it", async () => {
  const page = mount({ status: () => Promise.resolve(GOOD()), network: SICK });
  await tick(); await tick(); await tick();
  const rows = page.ids["attention-list"].children.filter((c) => c.className === "att");
  assert.deepEqual(rows.map((r) => r.dataset.id), ["svc:cognition", "svc:avatars", "svc:alerts"]);
  const verbs = rows[0].children[2].children;
  assert.deepEqual(verbs.map((b) => b.textContent), ["Restart", "Logs"]);
  assert.match(rows[0].textContent, /CognitionAdvanced.*down · Cognition -- Watch: offline/);
});

test("Logs reads ONE service's log into the log box; Restart needs a second click", async () => {
  const page = mount({ status: () => Promise.resolve(GOOD()), network: SICK });
  await tick(); await tick(); await tick();
  const row = () => page.ids["attention-list"].children.find((c) => c.dataset.id === "svc:avatars");
  const [restart, logs] = row().children[2].children;
  logs.click();
  for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(page.services, [["show", "aither-avatars"]]);
  assert.ok(page.logLines().some((l) => /boom: port in use/.test(l)), page.logLines().join("\n"));
  restart.click();
  await tick();
  assert.equal(page.services.length, 1, "one click only arms the restart");
  assert.equal(restart.textContent, "Confirm restart");
  restart.click();
  for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(page.services[1], ["restart", "aither-avatars"]);
  assert.ok(page.logLines().some((l) => /restart aither-avatars: running/.test(l)));
});

test("groups are collapsed to one line of counts, worst first; a click opens one", async () => {
  const page = mount({ status: () => Promise.resolve(GOOD()), network: SICK });
  await tick(); await tick(); await tick();
  const heads = () => page.ids["group-list"].children.filter((c) => c.className === "grp");
  assert.equal(page.ids["group-list"].children.length, heads().length, "every group starts collapsed");
  assert.deepEqual(heads().map((h) => h.dataset.group).slice(0, 2), ["Cognition", "Platform"]);
  assert.match(heads()[0].textContent, /0\/1 up · 1 down/);
  heads()[0].click();
  assert.ok(page.ids["group-list"].children.some((c) => c.className === "members"), "the clicked group lists its members");
});

test("the map labels only the control nodes and the services that are not ok (no overlapping hairball)", () => {
  const page = mount({ status: () => Promise.resolve(GOOD()) });
  const label = page.pane().mapLabel;
  assert.equal(label({ title: "Genesis", meta: { kind: "svc", health: "ok" } }), "");
  assert.equal(label({ title: "Veil", meta: { kind: "svc", health: "down" } }), "Veil");
  assert.equal(label({ title: "awnix host", meta: { kind: "ctl", key: "host" } }), "awnix host");
  assert.equal(label({ title: "awdk", meta: { kind: "brick" } }), "");
});

test("a saved map copy says how old it is and WHY the live read failed", async () => {
  // the package is "type": "module", so the page's classic script is loaded the way the page loads it
  const w = {};
  vm.runInNewContext(OVERVIEW, { window: w });
  const OV = w.FleetOverview;
  const now = Date.parse("2026-11-18T19:00:00Z");
  const txt = OV.mapSource({ ok: true, source: "last-good", savedAt: "2026-11-07T19:00:00Z",
    error: "universe route unreachable: TimeoutError; local Genesis: aitheros-genesis-a: no answer" }, now);
  assert.match(txt, /^saved copy \(11 days old\) -- live read failed: universe route unreachable/);
  assert.equal(OV.mapSource({ ok: true, source: "genesis" }), "live from Genesis");
});
