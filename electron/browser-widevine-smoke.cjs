"use strict";

/**
 * Widevine, live (`npm run test:browser-widevine`): the real Aither Browser window and a
 * real encrypted stream. Unit tests prove the status mapping and the notice decision;
 * only a real Chromium shows that the CDM installs, that a browser TAB (the owner's
 * partition, sandbox on, no preload) is granted the Widevine key system, and that an
 * encrypted video actually decodes (its clock advances and frames are drawn).
 *
 * On stock Electron there is no Widevine. The run measures that (the baseline: the same
 * probe is rejected), prints one SKIP line and exits 0. On the castLabs build it runs
 * the real checks. It needs the network: the CDM comes from Google's component server
 * and the stream is Shaka's public Widevine test asset.
 *
 * Own entry point: a temp userData (never the owner's profile), no tray.
 * Exit 0 all pass (or SKIP on stock), 1 a check failed, 2 the run itself broke, 3 it hung.
 */
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { app } = require("electron");

const userData = path.join(os.tmpdir(), `awdesk-widevine-smoke-${process.pid}`);
app.setPath("userData", userData);
// A known DRM host, served by this run's own local server, so the notice path sees a
// real navigation to it without touching the real site.
const DRM_HOST = "open.spotify.com";
app.commandLine.appendSwitch("host-resolver-rules", `MAP ${DRM_HOST} 127.0.0.1`);
app.on("window-all-closed", () => {});
process.on("unhandledRejection", (e) => { console.log("REJECT " + ((e && e.stack) || e)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 130000);

const SHAKA = "https://ajax.googleapis.com/ajax/libs/shaka-player/4.7.11/shaka-player.compiled.js";
const MANIFEST = "https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine/dash.mpd";
const LICENSE = "https://cwip-shaka-proxy.appspot.com/no_auth";

const PAGES = {
  "/probe": "<!doctype html><title>Probe</title><p>probe</p>",
  "/play": `<!doctype html><title>Play</title><video id="v" muted autoplay width="640"></video>
<script src="${SHAKA}"></script>
<script>
window.__wv = { state: "loading" };
(async () => {
  try {
    shaka.polyfill.installAll();
    const v = document.getElementById("v");
    const p = new shaka.Player();
    await p.attach(v);
    p.configure({ drm: { servers: { "com.widevine.alpha": "${LICENSE}" } } });
    p.addEventListener("error", (e) => { window.__wv.error = "shaka " + (e.detail && e.detail.code); });
    await p.load("${MANIFEST}");
    window.__wv.state = "loaded";
    window.__wv.keySystem = p.keySystem();
    await v.play();
    window.__wv.state = "playing";
  } catch (e) { window.__wv.error = String((e && (e.code || e.message)) || e); }
})();
</script>`,
};

const PROBE = `navigator.requestMediaKeySystemAccess("com.widevine.alpha", [{
  initDataTypes: ["cenc"],
  videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
}]).then((a) => ({ ok: true, keySystem: a.keySystem }), (e) => ({ ok: false, error: e.name + ": " + e.message }))`;

const PLAY_STATE = `(() => {
  const v = document.getElementById("v");
  const q = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
  return { ...window.__wv, t: v ? v.currentTime : -1, width: v ? v.videoWidth : 0,
    frames: q.totalVideoFrames || 0, encrypted: Boolean(v && v.mediaKeys) };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    await sleep(150);
  }
  return null;
}

app.whenReady().then(async () => {
  const widevine = require("./browser-widevine.cjs").getWidevine();
  const bw = require("./browser-window.cjs");
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const body = PAGES[new URL(req.url, "http://x").pathname];
      res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(body || "nope");
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;
  const base = `http://localhost:${port}`; // localhost is a secure context; EME needs one
  const fails = [];
  const expect = (name, cond, detail) => {
    console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(detail)));
    if (!cond) fails.push(name);
  };
  const finish = (code) => {
    server.close();
    try { bw.closeBrowserWindow(); } catch { /* closing */ }
    setTimeout(() => {
      try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* temp */ }
      app.exit(code);
    }, 300);
  };
  const active = () => bw.getTabs().active;
  const page = () => bw.__pageForTest(active());
  const loaded = (wc, suffix) => until(() => wc && !wc.isLoading() && wc.getURL().includes(suffix));

  console.log(`INFO electron ${process.versions.electron} chrome ${process.versions.chrome}`);
  console.log(`INFO widevine before install ${JSON.stringify(widevine.snapshot())}`);

  // The tab opens while the CDM is still installing, as on a first run of the desk.
  bw.createBrowserWindow({ url: `${base}/probe`, home: false });
  const wc = await until(page);
  await loaded(wc, "/probe");

  if (!widevine.hasApi) {
    const stock = await wc.executeJavaScript(PROBE);
    console.log(`INFO baseline, stock Electron: requestMediaKeySystemAccess("com.widevine.alpha") -> ${JSON.stringify(stock)}`);
    expect("stock Electron reports Widevine as missing", widevine.snapshot().state === "missing", widevine.snapshot());
    expect("stock Electron cannot play Widevine (the baseline)", stock && stock.ok === false, stock);
    await wc.loadURL(`http://${DRM_HOST}:${port}/probe`).catch(() => {});
    const n = await until(() => bw.__noticeForTest(active()), 4000);
    const edge = require("./browser-everyday.cjs").edgeExecutable();
    expect("a DRM site still gets the Open in Edge fallback", edge ? Boolean(n && n.kind === "drm") : n === null, { n, edge });
    expect("state reports Widevine missing", (bw.getState().widevine || {}).state === "missing", bw.getState().widevine);
    console.log(fails.length ? `FAILED ${fails.length}`
      : "SKIP this Electron has no Widevine (stock build); run on the castLabs build for the real probe");
    return finish(fails.length ? 1 : 0);
  }

  const t0 = Date.now();
  const snap = await widevine.ensure();
  console.log(`INFO components.whenReady settled in ${Date.now() - t0} ms -> ${JSON.stringify(snap)}`);
  console.log(`INFO components.status() ${JSON.stringify(require("electron").components.status())}`);
  expect("the Widevine CDM installs (components.whenReady resolves)", snap.state === "ready" && Boolean(snap.version), snap);

  // The tab is the browser's own: the owner's persistent partition, sandboxed, no preload.
  const { session } = require("electron");
  const prefs = wc.getLastWebPreferences ? wc.getLastWebPreferences() : {};
  expect("the tab rides persist:aither-browser, sandbox on, no preload",
    wc.session === session.fromPartition(bw.PARTITION) && prefs.sandbox === true && !prefs.preload, { sandbox: prefs.sandbox, preload: prefs.preload });

  const early = await wc.executeJavaScript(PROBE);
  console.log(`INFO tab opened before the install, no reload: ${JSON.stringify(early)}`);
  await wc.loadURL(`${base}/probe?again=1`).catch(() => {});
  await loaded(wc, "again=1");
  const probe = await wc.executeJavaScript(PROBE);
  expect("an owner tab is granted com.widevine.alpha", probe && probe.ok === true, probe);

  // A real encrypted stream decodes: the clock advances and frames are drawn.
  await wc.loadURL(`${base}/play`).catch(() => {});
  await loaded(wc, "/play");
  const playing = await until(async () => {
    const s = await wc.executeJavaScript(PLAY_STATE);
    return s && (s.error || (s.t > 2 && s.frames > 0)) ? s : null;
  }, 60000);
  const last = playing || await wc.executeJavaScript(PLAY_STATE).catch(() => null);
  console.log(`INFO stream ${JSON.stringify(last)}`);
  expect("an encrypted Widevine stream plays (clock advances, frames decode)",
    Boolean(last && !last.error && last.t > 2 && last.frames > 0 && last.width > 0 && last.encrypted && last.keySystem === "com.widevine.alpha"), last);

  // A DRM site with Widevine ready gets NO "Open in Edge" notice.
  await wc.loadURL(`http://${DRM_HOST}:${port}/probe`).catch(() => {});
  await loaded(wc, DRM_HOST);
  await sleep(600);
  const notice = bw.__noticeForTest(active());
  expect("a DRM site shows no Edge notice once Widevine is ready", wc.getURL().includes(DRM_HOST) && notice === null, { url: wc.getURL(), notice });
  expect("state reports Widevine ready", (bw.getState().widevine || {}).state === "ready", bw.getState().widevine);

  const label = require("./browser-widevine.cjs").widevineMenuLabel(bw.getState().widevine);
  expect("the more-menu line says protected playback is on", /on [(]Widevine [0-9]/.test(label), label);

  // An agent tab rides its own session, which is never granted the protected-media
  // identifier (browser-policy). The key system itself is process-wide in Chromium, so
  // what an agent tab sees is measured and printed, not asserted.
  const agent = bw.browserAgent();
  const opened = await agent("open", { url: `${base}/probe?agent=1` });
  const awc = opened && opened.ok ? bw.__pageForTest(opened.tab) : null;
  expect("an agent tab is not on the owner's session", Boolean(awc && awc.session !== session.fromPartition(bw.PARTITION)), { opened });
  console.log(`INFO agent tab probe: ${JSON.stringify(awc ? await awc.executeJavaScript(PROBE) : null)}`);

  console.log(fails.length ? `FAILED ${fails.length}` : "ALL PASS");
  finish(fails.length ? 1 : 0);
}).catch((e) => { console.log("BROKE " + ((e && e.stack) || e)); app.exit(2); });
