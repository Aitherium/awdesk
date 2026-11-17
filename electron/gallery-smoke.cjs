"use strict";
/**
 * The avatar gallery, end to end, in a HIDDEN offscreen window (never on screen): the built
 * renderer at ?gallery=1, the real preload, and the real gallery-host contract over a roster
 * (read-only) and a SCRATCH cast.json -- the owner's file is never written.
 *
 *   npx vite build && npx electron electron/gallery-smoke.cjs <roster dir> <cast.json to copy> <out dir>
 *
 * Shots: work-mine.png (Work profile, a body selected, live preview), hearth-mine.png (Hearth:
 * only everyone-rated tiles, the hidden count), personas.png, safe.png (safe mode on).
 * Checks: in Hearth no non-everyone name reaches the page; assign writes only the scratch cast.
 * Exit 0 pass, 1 violation, 2 could not judge.
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DIST = path.join(__dirname, "..", process.env.AWDESK_SMOKE_DIST || "dist");
const [rosterDir, castSrc, outDir] = process.argv.slice(-3);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(DIST, "index.html")) || !rosterDir || !fs.existsSync(rosterDir) || !outDir) {
  console.error("gallery-smoke: needs a build, a roster dir, a cast.json and an out dir -- could not judge");
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-smoke-"));
const castFile = path.join(scratch, "cast.json");
fs.copyFileSync(castSrc, castFile);
process.env.DESK_CAST_FILE = castFile;
process.env.DESK_ROSTER_DIR = rosterDir;

const gallery = require("./avatar-gallery.cjs");
const cast = require("./cast-config.cjs");
const { galleryHandlers } = require("./gallery-host.cjs");

const names = fs.readdirSync(rosterDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(rosterDir, e.name, "model.vrm"))).map((e) => e.name);
const record = (n) => { try { return JSON.parse(fs.readFileSync(path.join(rosterDir, n, "character.json"), "utf8")); } catch { return {}; } };
const ratingOf = (n) => {
  const r = record(n);
  return r.source === "default" ? "" : String(r.rating || "");
};
const raw = () => JSON.parse(fs.readFileSync(castFile, "utf8"));
const isHidden = (n) => !gallery.tierAllowed(gallery.tierOf(ratingOf(n)), gallery.audienceCap(gallery.readGallery(raw())));
const deps = {
  rosterDir,
  proposalsDir: scratch,
  allNames: () => names,
  ratingOf,
  isHidden,
  castRaw: raw,
  rosterAgents: () => ["aither", "atlas", "iris", "lyra", "hera"],
  sharing: () => [],
  autoSafe: () => false,
  studio: () => require("./vroid-studio.cjs").detect(),
  hasThumb: (n) => fs.existsSync(path.join(rosterDir, n, "thumbnail.jpg")),
  writeCast: (m) => cast.write(m, { file: castFile }),
  setRating: () => true,
  onChanged: () => {},
  modelUrl: (n) => pathToFileURL(path.join(rosterDir, n, "model.vrm")).href,
  launchStudio: () => ({ ok: false, error: "not in a smoke" }),
  // The REAL broker (read-only browse): the shot shows his true link state.
  vroidBrowse: (s, k, c) => require("./market-client.cjs").vroidBrowse(s, k, c),
  vroidRosterName: (id) => require("./avatar-library-sync.cjs").vroidRosterName(id) || "",
};
const handlers = galleryHandlers(() => deps);

app.whenReady().then(async () => {
  ipcMain.handle("desk:gallery", (_e, verb, arg) => handlers[verb](arg || {}));
  ipcMain.handle("desk:character-thumb", (_e, n) => {
    if (isHidden(n)) return null;
    const f = path.join(rosterDir, n, "thumbnail.jpg");
    return fs.existsSync(f) ? `data:image/jpeg;base64,${fs.readFileSync(f).toString("base64")}` : null;
  });
  ipcMain.handle("desk:save-character-thumb", () => true);
  ipcMain.handle("desk:get-snapshot", () => ({}));
  const win = new BrowserWindow({
    width: 1240, height: 800, show: false, backgroundColor: "#08090c",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true },
  });
  win.webContents.setFrameRate(30);
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(outDir, name), (await wc.capturePage()).toPNG());
  const problems = [];
  try {
    handlers.profile({ profile: "work" });
    await win.loadURL(`${pathToFileURL(path.join(DIST, "index.html")).href}?gallery=1`);
    for (let i = 0; i < 40 && !(await js("document.querySelectorAll('.gal-tile').length")); i += 1) await wait(250);
    const tiles = await js("document.querySelectorAll('.gal-tile').length");
    if (!tiles) { console.error("no tiles rendered -- could not judge"); app.exit(2); return; }
    await js("document.querySelector('.gal-tile').click()");
    await wait(6000);
    await shot("work-mine.png");

    await js("[...document.querySelectorAll('.gal-aud')][0].click()"); // Hearth
    await wait(2500);
    const page = await js("document.body.innerText");
    // A whole name, not a substring of a visible one ("eld-1-0-vrm-0---downloadable" is
    // everyone-rated and contains the r15 "vrm-0---downloadable").
    const words = new Set(page.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean));
    const leaked = names.filter((n) => gallery.tierOf(ratingOf(n)) !== "everyone"
      && (words.has(n) || page.split("\n").some((line) => line.trim() === n)));
    if (leaked.length) problems.push(`Hearth page names hidden bodies: ${leaked.slice(0, 5).join(", ")}`);
    const hearthTiles = await js("document.querySelectorAll('.gal-tile').length");
    await shot("hearth-mine.png");

    await js("document.querySelector('.gal-safe').click()");
    await wait(1200);
    await shot("safe.png");
    await js("document.querySelector('.gal-safe').click()");
    await js("[...document.querySelectorAll('.gal-aud')][1].click()"); // Work again
    await wait(800);
    await js("[...document.querySelectorAll('[role=tab]')][1].click()");
    await wait(2500);
    await shot("personas.png");

    await js("[...document.querySelectorAll('[role=tab]')][2].click()");
    await wait(6000);
    await shot("vroid.png");

    const before = fs.readFileSync(castSrc, "utf8");
    const pick = names.find((n) => gallery.tierOf(ratingOf(n)) === "everyone");
    handlers.assign({ persona: "hera", name: pick });
    if (raw().authors.hera.character !== pick) problems.push("assign did not write the scratch cast");
    if (fs.readFileSync(castSrc, "utf8") !== before) problems.push("the source cast.json was modified");
    console.log(JSON.stringify({ tiles, hearthTiles, problems }));
    console.log(problems.length ? "FAIL" : "PASS: the gallery renders; Hearth leaks no hidden name; assign writes only its own cast");
    app.exit(problems.length ? 1 : 0);
  } catch (error) {
    console.error("could not judge:", error && error.message);
    app.exit(2);
  }
});
