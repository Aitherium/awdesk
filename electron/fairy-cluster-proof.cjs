"use strict";

/**
 * The fairy cluster, proven on the REAL modules with nothing on anyone's screen.
 * `npx electron electron/fairy-cluster-proof.cjs` (writes PNGs to $SMOKE_OUT, default tmp).
 *
 * Every BrowserWindow is forced OFFSCREEN and never shown (the owner's rule: no visible
 * scratch window on his screen); the real orb-window.cjs, decision-cards.cjs and
 * session-context.cjs run against a scratch card store (AITHER_DECISIONS_DIR) and a
 * scratch Claude sessions folder (CLAUDE_CONFIG_DIR) whose rows name this process's own
 * pid (alive) -- so grow, shrink and reap are the real reads, not stubs.
 *
 * Stages, each a screenshot of the fairy + its cluster window composited on a dark card:
 *   n0   nothing live: one fairy, no cluster
 *   n3   2 decisions + 1 session
 *   n8   5 decisions + 3 sessions -> 5 fairies + a "+3" bead, count 8
 *   shrink  3 cards answered, 2 sessions ended -> 3 left
 *   reaped  session source unreadable for 30 s -> its fairy reaped; queue empties -> orb hides
 * Exit 0 pass, 1 a check failed, 3 hung.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const tmp = path.join(os.tmpdir(), `awdesk-cluster-proof-${process.pid}`);
const store = path.join(tmp, "decisions");
const claude = path.join(tmp, "claude");
fs.mkdirSync(path.join(claude, "sessions"), { recursive: true });
fs.mkdirSync(store, { recursive: true });
process.env.AITHER_DECISIONS_DIR = store;
process.env.CLAUDE_CONFIG_DIR = claude;
process.env.DESK_FAIRY_OWNER_FILE = path.join(tmp, "fairy-owner.json");
process.env.AWDESK_NO_BROWSER_REGISTER = "1";
const OUT = process.env.SMOKE_OUT || tmp;
fs.mkdirSync(OUT, { recursive: true });

// ── every window offscreen, none ever shown ─────────────────────────────────
const electron = require("electron");
const made = [];
class HiddenWindow extends electron.BrowserWindow {
  constructor(opts = {}) {
    super({ ...opts, show: false, webPreferences: { ...(opts.webPreferences || {}), offscreen: true, backgroundThrottling: false } });
    this.__vis = false;
    this.__title = String(opts.title || "");
    made.push(this);
  }
  show() { this.__vis = true; }
  showInactive() { this.__vis = true; }
  hide() { this.__vis = false; }
  isVisible() { return this.__vis; }
  focus() {}
  moveTop() {}
}
const shim = new Proxy(electron, { get: (t, k) => (k === "BrowserWindow" ? HiddenWindow : t[k]) });
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === "electron") return shim;
  return realLoad.call(this, request, ...rest);
};

const { app } = electron;
app.setPath("userData", path.join(tmp, "userData"));
app.on("window-all-closed", () => {});
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 180_000);

const fails = [];
const expect = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` :: ${JSON.stringify(detail)}`}`);
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Date.now() / 1000;

let seq = 0;
function raise(agent, title, sessionId = "") {
  seq += 1;
  const id = `d-pr${seq}`;
  fs.writeFileSync(path.join(store, `${id}.json`), JSON.stringify({
    id, title, kind: "decision", status: "open", urgency: "normal", created_at: nowSec() - 120 + seq,
    options: [{ key: "yes", label: "Yes", recommended: true }, { key: "no", label: "No" }],
    source: { agent, session_id: sessionId },
  }));
  return id;
}
function answer(id) {
  const f = path.join(store, `${id}.json`);
  const raw = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, JSON.stringify({ ...raw, status: "answered", answer: "yes" }));
}
function startSession(id, name) {
  fs.writeFileSync(path.join(claude, "sessions", `${100000 + Number.parseInt(id.slice(0, 4), 16)}.json`),
    JSON.stringify({ sessionId: id, pid: process.pid, name, status: "busy", startedAt: Date.now() }));
}
function endSession(id) {
  fs.rmSync(path.join(claude, "sessions", `${100000 + Number.parseInt(id.slice(0, 4), 16)}.json`), { force: true });
}

app.whenReady().then(async () => {
  const orb = require("./orb-window.cjs");
  const cards = require("./decision-cards.cjs");
  const sessionContext = require("./session-context.cjs");
  let listed = 0;
  orb.startOrb({ hideByDefault: true, attention: { quiet: () => "", idleMs: () => 0, fullScreen: async () => "", openList: () => { listed += 1; return true; } } });
  // The real feed main runs: the card store, then the sessions folder.
  const feed = () => {
    const open = cards.listOpen();
    orb.setAttentionCards(cards.partitionCards(open).decisions, open);
  };
  const sessions = ({ ok = true } = {}) => {
    const checked = sessionContext.liveSessionsChecked();
    orb.setClusterSessions([checked.live], { ok: ok && checked.judged });
  };

  async function shot(name, caption) {
    await sleep(900);
    const wins = made.filter((w) => !w.isDestroyed());
    const pick = (title) => wins.find((w) => w.__title === title && w.isVisible());
    const orbWin = pick("Aither spirit");
    const swarm = pick("Aither swarm");
    const layers = [];
    for (const w of [swarm, orbWin]) {
      if (!w) continue;
      w.webContents.invalidate();
      await sleep(150);
      const img = await w.webContents.capturePage();
      const lf = path.join(tmp, `layer-${name}-${layers.length}.png`);
      fs.writeFileSync(lf, img.toPNG());
      layers.push({ b: w.getBounds(), url: require("node:url").pathToFileURL(lf).href, empty: img.isEmpty(), size: img.getSize() });
    }
    console.log(`layers ${name}: ${JSON.stringify(layers.map((l) => ({ b: l.b, empty: l.empty, size: l.size })))} titles=${JSON.stringify(wins.map((w) => [w.__title, w.isVisible()]))}`);
    const cx = orbWin ? orbWin.getBounds().x + 36 : 0;
    const cy = orbWin ? orbWin.getBounds().y + 36 : 0;
    const stage = new HiddenWindow({ width: 420, height: 380, backgroundColor: "#0d1117" });
    const imgs = layers.map((l) => `<img src="${l.url}" style="position:absolute;left:${210 + l.b.x - cx}px;top:${200 + l.b.y - cy}px;width:${l.b.width}px;height:${l.b.height}px">`).join("");
    const label = caption.replace(/[<&]/g, "");
    const stageFile = path.join(tmp, `stage-${name}.html`);
    fs.writeFileSync(stageFile, `<!doctype html><body style="margin:0;background:#0d1117;color:#e6edf3;font:13px system-ui;width:420px;height:380px;position:relative;overflow:hidden"><div style="position:absolute;left:12px;top:10px;right:12px">${label}</div>${imgs}</body>`);
    await stage.loadFile(stageFile);
    await sleep(500);
    stage.webContents.invalidate();
    await sleep(200);
    const png = (await stage.webContents.capturePage()).toPNG();
    const file = path.join(OUT, `fairy-cluster-${name}.png`);
    fs.writeFileSync(file, png);
    stage.destroy();
    console.log(`SHOT ${file}`);
    return file;
  }

  // ── N = 0 ────────────────────────────────────────────────────────────────
  feed();
  sessions();
  expect("N=0: nothing live, the cluster holds nothing", orb.clusterState().total === 0, orb.clusterState());
  expect("N=0: hidden by default, and still the desk's claim (no Tk window)", !orb.state().visible && orb.carriesCards(), orb.state());
  orb.showOrb(); // the owner's own fairy, to photograph the empty cluster
  await shot("n0", "N=0 - one fairy, no cluster (count hidden)");
  orb.hideOrb({ auto: true });

  // ── N = 3: two decisions + one session ───────────────────────────────────
  const s1 = "aaaa1111-0000-4000-8000-000000000001";
  startSession(s1, "awdesk lane");
  const c1 = raise("lyra", "Merge the fairy cluster PR?");
  const c2 = raise("claude-code", "Promote D:\\desk now?", s1);
  feed();
  sessions();
  expect("N=3: a hidden orb came up for the cards by itself", orb.state().visible && orb.autoSurfaced(), orb.state());
  expect("N=3: 2 decisions + 1 session", orb.clusterState().total === 3, orb.clusterState());
  const files = [await shot("n3", "N=3 - 2 decisions + 1 agent session")];

  // ── N = 8: five decisions + three sessions -> capped ─────────────────────
  const s2 = "bbbb2222-0000-4000-8000-000000000002";
  const s3 = "cccc3333-0000-4000-8000-000000000003";
  startSession(s2, "opencode lane");
  startSession(s3, "music video");
  const c3 = raise("atlas", "Restart genesis-b?");
  const c4 = raise("iris", "Render the V10 cut?");
  const c5 = raise("demiurge", "Ship PR #118?");
  feed();
  sessions();
  const st8 = orb.clusterState();
  const drawn = orb.companions();
  expect("N=8: eight fairies counted", st8.total === 8, st8);
  expect("N=8: capped at 6 drawn, the last a +3 bead", drawn.length === 6 && drawn[5].kind === "more" && drawn[5].count === 3, drawn.map((d) => [d.kind, d.count]));
  expect("the bead opens the whole waiting list", orb.chatWithAgent("more").ok && listed === 1, listed);
  files.push(await shot("n8", "N=8 - 5 decisions + 3 sessions: 5 fairies + a +3 bead"));

  // ── a click opens the card inline, at the fairy; answering dismisses its fairy ──
  const open = orb.openFairyCard(c3);
  expect("a decision fairy's click opens its card inline at the fairy", open.ok && orb.nudging() && orb.nudging().id === c3, open);

  // ── shrink: 3 answered, 2 sessions ended ─────────────────────────────────
  for (const id of [c1, c3, c4]) answer(id);
  endSession(s2);
  endSession(s3);
  feed();
  sessions();
  expect("answered cards and ended sessions leave on the next read", orb.clusterState().total === 3, orb.clusterState());
  expect("the open card's whisper closed when it was answered", !orb.nudging() || orb.nudging().id !== c3, orb.nudging());
  files.push(await shot("shrink", "Shrink - 3 answered, 2 sessions ended: 3 left"));

  // ── reap: the session source goes unreadable; its fairy is reaped after 30 s ──
  sessions({ ok: false });
  expect("an unreadable source keeps its fairy at first", orb.clusterState().keys.includes("s:session-aaaa1111"), orb.clusterState().keys);
  console.log("waiting 31 s for the reaper (real clock)...");
  await sleep(31_000);
  expect("after 30 s the orphan session fairy is reaped", !orb.clusterState().keys.includes("s:session-aaaa1111"), orb.clusterState().keys);
  for (const id of [c2, c5]) answer(id);
  feed();
  expect("queue empty: the cluster-surfaced orb went back down", !orb.state().visible && orb.clusterState().total === 0, orb.clusterState());
  const saved = JSON.parse(fs.readFileSync(orb.stateFile(), "utf8"));
  expect("the owner's saved choice (hidden) was never overwritten", saved.visible === false, saved);
  orb.showOrb();
  files.push(await shot("reaped", "Reaped + emptied - back to one fairy"));
  orb.stopOrb();
  console.log(fails.length ? `FAILED: ${fails.join("; ")}` : "ALL PASS");
  app.exit(fails.length ? 1 : 0);
});
