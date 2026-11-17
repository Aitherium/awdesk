"use strict";

/**
 * Does the Fleet window RENDER the living network? A real Electron run, HIDDEN
 * (show:false -- never a window on the owner's screen), that exits by itself
 * (`npm run test:fleet`).
 *
 *   1. load fleet-control.html over the real fleet-preload.cjs;
 *   2. the REAL bead-space engine drew it: a .bead-space root, one g.bs-node per node the
 *      page built (control nodes, doors, services, aw* bricks), links drawn;
 *   3. the header agrees with itself: a cannot-judge verdict reads CANNOT JUDGE in the pill
 *      AND the status line, never UP, and the log stays empty (no auto-refresh spam);
 *   4. selecting a service node opens the dock with "Open in Space".
 *
 * Default data is a fixed verdict + a small universe, so the run is the same everywhere.
 * FLEET_SMOKE_REAL=1 uses the REAL FleetControl (read-only status) and the desk's last-good
 * universe copy instead -- that is how the proof screenshot is taken.
 * FLEET_SMOKE_SHOT=<png> writes a screenshot; FLEET_SMOKE_HTML=<file> loads another page
 * (the old one, for a side-by-side). Exit 0 pass, 1 a check failed, 2 the run broke, 3 hung.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-fleet-smoke-"));
app.setPath("userData", path.join(tmp, "userData"));
const REAL = process.env.FLEET_SMOKE_REAL === "1";
setTimeout(() => { process.stdout.write("TIMEOUT\n"); app.exit(3); }, REAL ? 240000 : 60000);

const { fleetNetwork, readEcosystem } = require("./fleet-network.cjs");

const results = [];
function check(name, ok, detail) { results.push({ name, ok: Boolean(ok), detail: detail || "" }); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FIXED_STATUS = {
  ok: false, cannotJudge: true, error: "the awnix distro did not answer in 20 s. Nothing was changed.",
  stale: { age_ms: 42000, reason: "probe timed out", verdict: {
    ok: true, fleet: { running: 96, units: 212, masked: 0 }, held: false,
    vram: { used_mib: 20480, total_mib: 32607 }, gpu_holders: [],
    surfaces: [
      { label: "Cloudflare Access login (origin not probed)", url: "https://x.example", up: true, ms: 40, detail: "HTTP 302", scope: "fleet" },
      { label: "Genesis via MCP gateway", url: "https://y.example", up: false, ms: 0, detail: "timeout", scope: "fleet" },
    ] } },
};

function fixedUniverse() {
  const nodes = [{ id: "platform", level: "universe", parent: null, title: "Aither" },
    { id: "galaxy:fleet", level: "galaxy", parent: "platform", title: "awnix fleet" },
    { id: "solar:fleet/core", level: "solar", parent: "galaxy:fleet", title: "Core" },
    { id: "solar:fleet/gpu", level: "solar", parent: "galaxy:fleet", title: "Gpu" }];
  const links = [];
  const states = ["ok", "ok", "ok", "down", "parked", "degraded", "unknown"];
  for (let i = 0; i < 14; i++) {
    const solar = i < 9 ? "core" : "gpu";
    nodes.push({ id: `svc:s${i}`, level: "system", parent: `solar:fleet/${solar}`, title: `Service number ${i} with a long name`,
      health: { state: states[i % states.length], reason: "fixture" } });
    if (i) links.push({ source: `svc:s${i}`, target: `svc:s${Math.floor(i / 2)}`, rel: "depends" });
  }
  links.push({ source: "svc:s1", target: "svc:s9", rel: "traffic" });
  return { universe_version: 1, nodes, links };
}

async function realUniverse() {
  const { createSpaceClient } = require("./space-client.cjs");
  const { createLastGoodCache } = require("./last-good-cache.cjs");
  const src = path.join(app.getPath("appData"), "Desk", "page-cache");
  const dir = path.join(tmp, "page-cache");
  fs.mkdirSync(dir, { recursive: true });
  try { fs.copyFileSync(path.join(src, "space-universe.json"), path.join(dir, "space-universe.json")); } catch { /* none saved */ }
  const client = createSpaceClient({
    fetchUniverse: async () => { throw new Error("smoke: Veil not asked"); },
    store: createLastGoodCache({ dir: () => dir }),
  });
  return client.get({});
}

async function run() {
  let control = null;
  if (REAL) {
    const { FleetControl } = require("./fleet-control.cjs");
    control = new FleetControl();
  }
  ipcMain.handle("desk:fleet-status", (_e, opts) => (control ? control.status(opts || {}) : FIXED_STATUS));
  ipcMain.handle("desk:fleet-doors", () => (control ? require("./surfaces.cjs").probeSurfaces().catch(() => []) : []));
  ipcMain.handle("desk:fleet-run", () => ({ ok: false, error: "smoke: no verb runs" }));
  ipcMain.handle("desk:fleet-space", () => true);
  ipcMain.handle("desk:fleet-network", async () => fleetNetwork(REAL ? await realUniverse()
    : { universe: fixedUniverse(), source: "remote" }));
  ipcMain.handle("desk:fleet-ecosystem", () => readEcosystem());
  ipcMain.on("desk:fleet-open", () => {});
  ipcMain.on("desk:fleet-close", () => {});

  const win = new BrowserWindow({
    width: 1120, height: 800, show: false, paintWhenInitiallyHidden: true, backgroundColor: "#0f1218",
    // offscreen: frames (and requestAnimationFrame, which the engine's label culling runs
    // on) keep coming with NO window on any screen; a plain hidden window never paints.
    webPreferences: { preload: path.join(__dirname, "fleet-preload.cjs"), contextIsolation: true, sandbox: true,
      backgroundThrottling: false, offscreen: true },
  });
  const errors = [];
  win.webContents.on("console-message", (_e, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(process.env.FLEET_SMOKE_HTML || path.join(__dirname, "fleet-control.html"));
  const js = (code) => win.webContents.executeJavaScript(code);
  const old = Boolean(process.env.FLEET_SMOKE_HTML);
  // wait for the verdict and (new page) the network
  for (let i = 0; i < (REAL ? 400 : 60); i++) {
    const ready = await js(old ? "document.getElementById('pill').dataset.state !== 'UNKNOWN' && !/PROBING/.test(document.getElementById('pill').textContent)"
      : "(() => { const p = document.getElementById('pill').dataset.state; const d = window.fleetPane && window.fleetPane.data();"
        + " return p !== 'UNKNOWN' && p !== 'PROBING' && d && d.nodes.some((n) => n.meta && n.meta.kind === 'svc'); })()").catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  await sleep(REAL ? 9000 : 4000); // let the force layout settle before the picture
  if (!old) {
    const got = await js(`(() => {
      const d = window.fleetPane.data();
      return { nodes: d.nodes.length, drawn: document.querySelectorAll('#net g.bs-node').length,
        links: document.querySelectorAll('#net .bs-link').length, kinds: [...new Set(d.nodes.map((n) => n.meta && n.meta.kind))],
        pill: document.getElementById('pill').dataset.state, line: document.getElementById('statusline').textContent,
        logLines: document.getElementById('log').children.length, logHidden: document.getElementById('log').hidden };
    })()`);
    check("the real engine drew every node", got.drawn === got.nodes && got.nodes > 0, `${got.drawn} drawn / ${got.nodes}`);
    check("links drawn", got.links > 0, `${got.links}`);
    // doors come with a verdict; a live fleet that cannot be judged right now carries none
    const kinds = REAL ? ["ctl", "svc", "brick"] : ["ctl", "door", "svc", "brick"];
    check(`${kinds.join(", ")} nodes`, kinds.every((k) => got.kinds.includes(k)), got.kinds.join(","));
    if (!REAL) {
      check("cannot judge reads CANNOT JUDGE in the pill", got.pill === "CANNOT JUDGE", got.pill);
      check("...and in the one status line", /fresh probe failed/.test(got.line), got.line);
    }
    check("auto-refresh writes nothing to the log", got.logLines === 0 && got.logHidden, `${got.logLines}`);
    if (process.env.FLEET_SMOKE_SELECT !== "0") {
      const dock = await js(`(() => { const s = window.fleetPane.data().nodes.find((n) => n.meta && n.meta.kind === 'svc');
        window.fleetPane.select('svc:' + s.id); const b = document.getElementById('b-node-space');
        return { open: !document.getElementById('dock').hidden, space: !b.hidden }; })()`);
      check("selecting a service opens its dock with Open in Space", dock.open && dock.space, JSON.stringify(dock));
      await js("window.fleetPane.closeDock()");
    }
    process.stdout.write(`page: ${JSON.stringify(got)}\n`);
  }
  check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  if (process.env.FLEET_SMOKE_SHOT) {
    await sleep(500);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(process.env.FLEET_SMOKE_SHOT, image.toPNG());
    process.stdout.write(`shot: ${process.env.FLEET_SMOKE_SHOT}\n`);
  }
  win.destroy();
}

app.whenReady().then(run).then(() => {
  for (const r of results) process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  ${r.detail}`}\n`);
  app.exit(results.every((r) => r.ok) ? 0 : 1);
}, (error) => {
  process.stdout.write(`BROKE ${error && error.stack}\n`);
  app.exit(2);
});
