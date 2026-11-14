"use strict";

/**
 * Does aither://explore really work in a REAL Chromium, offline? `npm run test:explore`
 * -- an Electron run that exits by itself, like browser-internal-smoke.cjs. The unit
 * tests prove the adapters; only a live renderer shows that the page gets its engine
 * and stylesheet past its CSP, that a wiki folder reads, renders, links and draws, and
 * that "no gateway" is a visible state and not an empty canvas.
 *
 *   1. the page loads on its own origin with its bridge and the bead-space engine;
 *   2. Wiki: the platform does not answer, so the fixture FOLDER is shown and said so;
 *      list, search, open a page, follow an internal link, Back, backlinks;
 *   3. the link graph is drawn by the engine (g.bs-node per page in the model);
 *   4. a page's <script> / <img onerror> are text; an external link asks main for an
 *      owner tab and the page itself never navigates;
 *   5. Graph: with no gateway the list AND the canvas say "unreachable" and what to start;
 *   6. Context: a fixture journal is measured offline; traces say why they are absent;
 *   7. a deep link (the address Alt+Space opens) lands on its tab and runs its query;
 *   8. an agent / web tab cannot open the pane or reach its bridge.
 *
 * EXPLORE_SMOKE_LIVE=1 keeps the real gateway and prints (never judges) what one real
 * graph search and one real wiki list return on this computer.
 *
 * Own entry point: no single-instance lock, no tray, HIDDEN windows, a temp userData, a
 * temp CLAUDE_CONFIG_DIR. Nothing touches ~/.aither or the owner's journals.
 * Exit 0 all pass, 1 a check failed, 2 the run broke, 3 it hung.
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const LIVE = process.env.EXPLORE_SMOKE_LIVE === "1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-explore-smoke-"));
const SID = "11111111-2222-4333-8444-555555555555";

// ── fixtures, and every door closed BEFORE the modules read their environment ──
const wikiRoot = path.join(tmp, "Fixture Wiki");
const put = (rel, text) => {
  const file = path.join(wikiRoot, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
put("index.md", "# Index\n\n- [[agent-loop]]\n- [[memory]]\n");
put("wiki/concepts/agent-loop.md", "---\ntitle: Agent Loop\ntype: concept\n---\n# Agent Loop\n\nThe loop reads [[memory]] and calls [tools](../entities/tools.md).\n\nSee [the docs](https://example.com/loop).\n\n<script>window.__pwned = 1</script>\n<img src=x onerror=\"window.__pwned = 2\">\n");
put("wiki/concepts/memory.md", "---\ntitle: Memory\ntype: concept\n---\n# Memory\n\nMemory feeds the [[agent-loop]].\n");
put("wiki/entities/tools.md", "# Tools\n\nTools are called by the [[agent-loop]].\n");

const claudeHome = path.join(tmp, "claude");
fs.mkdirSync(path.join(claudeHome, "projects", "C--smoke"), { recursive: true });
fs.writeFileSync(path.join(claudeHome, "projects", "C--smoke", `${SID}.jsonl`), [
  { parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: "Smoke: find the agent loop." }, timestamp: "2026-11-13T10:00:00.000Z" },
  { parentUuid: "u1", isSidechain: false, message: { model: "claude-fable-5-2", id: "msg_1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "rg loop" } }],
    usage: { input_tokens: 4, cache_creation_input_tokens: 100, cache_read_input_tokens: 123000, output_tokens: 50 } }, type: "assistant", timestamp: "2026-11-13T10:00:05.000Z" },
  { parentUuid: "a1", isSidechain: false, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "wiki/concepts/agent-loop.md" }] }, timestamp: "2026-11-13T10:00:06.000Z" },
  { type: "custom-title", customTitle: "Smoke session", sessionId: SID },
].map((r) => JSON.stringify(r)).join("\n") + "\n");

process.env.AITHER_WIKI_ROOTS = wikiRoot;
process.env.CLAUDE_CONFIG_DIR = claudeHome;
delete process.env.LYRA_WIKI_DATA_DIR;
delete process.env.AITHEROS_ROOT;
delete process.env.AITHEROS_DATA;
if (!LIVE) {
  // A closed loopback port: the gateway and the harness daemon both refuse the socket.
  process.env.AWDESK_GATEWAY_URL = "http://127.0.0.1:9";
  process.env.AITHER_HARNESS_URL = "http://127.0.0.1:9";
}

const { app, BrowserWindow, ipcMain, protocol, session } = require("electron");
const internal = require("./browser-internal.cjs");
const { ensureExploreIpc } = require("./explore-window.cjs");
const { exploreUrl } = require("./explore-verbs.cjs");

const WEB_PARTITION = "persist:aither-explore-smoke-web";
internal.registerPrivilegedScheme(protocol);
app.setPath("userData", path.join(tmp, "userData"));
app.on("window-all-closed", () => {});
process.on("unhandledRejection", (e) => { console.log("REJECT " + ((e && e.stack) || e)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 150000);

const fails = [];
const expect = (name, cond, detail) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(detail)));
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { tries = 60, every = 250 } = {}) {
  let value;
  for (let i = 0; i < tries; i += 1) {
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    await sleep(every);
  }
  return value;
}

async function open(prefs, url) {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: prefs });
  try {
    await win.loadURL(url);
    return { win, error: null };
  } catch (error) {
    return { win, error: String((error && error.message) || error) };
  }
}

app.whenReady().then(async () => {
  internal.installInternalProtocol(session.fromPartition(internal.INTERNAL_PARTITION), { rendererUrl: "" });
  const opened = [];
  // main.cjs is not loaded (it would take the running desk's instance lock); the theme
  // every internal tab asks for on load is answered "default".
  ipcMain.handle("desk:appearance-get", () => null);
  ensureExploreIpc({ openUrl: (url) => opened.push(url) });
  const prefs = internal.tabPreferences("internal", { webPartition: WEB_PARTITION });
  const webPrefs = internal.tabPreferences("web", { webPartition: WEB_PARTITION });

  // 1 ── the page, its bridge, its engine
  const first = await open(prefs, exploreUrl({ tab: "wiki" }));
  const wc = first.win.webContents;
  const js = (code) => wc.executeJavaScript(code);
  const consoleErrors = [];
  wc.on("console-message", (...args) => {
    const m = args[0] && args[0].message !== undefined ? args[0] : { level: args[1], message: args[2] };
    if (m.level === "error" || m.level === 3) consoleErrors.push(String(m.message).slice(0, 200));
  });
  const page = await js(`({ href: location.href, origin: location.origin, bridge: typeof window.aitherExplore, call: typeof (window.aitherExplore || {}).call,
    engine: typeof (window.BeadSpace || {}).createBeadSpace, css: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
    hook: typeof window.__explore })`).catch((e) => ({ error: String(e) }));
  expect("aither://explore loads on its own origin", !first.error && page.origin === "aither://explore", { error: first.error, page });
  expect("the page has its bridge (aitherExplore.call)", page.bridge === "object" && page.call === "function", page);
  expect("the bead-space engine loaded past the page's CSP", page.engine === "function", page);
  expect("the theme stylesheet loaded", Boolean(page.css), page);
  const code = await js(`fetch("aither://explore/explore-window.cjs").then((r) => r.status, (e) => "error: " + e)`);
  expect("the page cannot read desk code", code === 403 || /Failed to fetch/.test(String(code)), code);

  if (!LIVE) {
    // 2 ── Wiki, offline
    await js("window.__explore.ready");
    const m1 = await until(() => js("(() => { const m = window.__explore.model(); return m.wiki.state === 'ok' && m.wiki.source !== 'platform' ? m : null; })()"));
    expect("with no gateway the Wiki tab falls back to the folder on this computer", Boolean(m1) && m1.tab === "wiki" && m1.wiki.source === "fixture-wiki", m1);
    const status = await js("document.getElementById('w-status').textContent");
    expect("…and says LyraWiki did not answer and which folder is shown", /LyraWiki did not answer/.test(status) && /Fixture Wiki/.test(status), status);
    const listed = await js("[...document.querySelectorAll('#w-list .row')].map((r) => r.dataset.slug).sort()");
    expect("the folder's pages are listed", JSON.stringify(listed) === JSON.stringify(["agent-loop", "index", "memory", "tools"]), listed);
    await js("window.__explore.searchWiki('memory')");
    const found = await js("[...document.querySelectorAll('#w-list .row')].map((r) => r.dataset.slug)");
    expect("searching the folder finds pages, the title hit first", found[0] === "memory" && found.includes("agent-loop") && !found.includes("tools"), found);

    await js("window.__explore.openPage('agent-loop')");
    const article = await js(`(() => { const a = document.getElementById('w-page'); return { h1: (a.querySelector('h1') || {}).textContent,
      wiki: [...a.querySelectorAll('a[data-wiki]')].map((x) => x.dataset.wiki), ext: [...a.querySelectorAll('a[data-ext]')].map((x) => x.dataset.ext),
      hrefs: a.querySelectorAll('a[href]').length, scripts: a.querySelectorAll('script, img, iframe').length, pwned: window.__pwned,
      text: a.textContent.includes('<script>window.__pwned = 1</script>'),
      backlinks: [...document.querySelectorAll('#w-backlinks .row')].map((r) => r.textContent).sort() }; })()`);
    expect("a page renders its markdown", article.h1 === "Agent Loop" && article.wiki.includes("memory") && article.wiki.includes("tools"), article);
    expect("backlinks are shown", JSON.stringify(article.backlinks) === JSON.stringify(["Index", "Memory", "Tools"]), article.backlinks);
    // 4 ── sanitised
    expect("a page's <script> and <img onerror> are text: nothing ran, nothing was created", article.pwned === undefined && article.scripts === 0 && article.text && article.hrefs === 0, article);

    // 3 ── the link graph, drawn by the engine
    const drawn = await until(() => js(`(() => { const m = window.__explore.model().wiki; const n = document.querySelectorAll('#w-canvas g.bs-node').length;
      return m.nodes > 0 && n === m.nodes ? { model: m, dom: n, sprites: document.querySelectorAll('#w-canvas image').length } : null; })()`));
    expect("this page's link graph is drawn by the engine (a planet per page)", Boolean(drawn) && drawn.dom === 4 && drawn.model.links >= 4, drawn
      || await js("({ m: window.__explore.model().wiki, dom: document.querySelectorAll('#w-canvas g.bs-node').length, html: document.getElementById('w-canvas').innerHTML.slice(0, 300) })"));

    // follow an internal link by CLICKING it
    await js("document.querySelector('#w-page a[data-wiki=\"memory\"]').click()");
    const moved = await until(() => js("(() => { const m = window.__explore.model().wiki; return m.page === 'memory' ? { page: m.page, h1: document.querySelector('#w-page h1').textContent, back: !document.getElementById('w-back').disabled, href: location.href } : null; })()"));
    expect("an internal link navigates inside the pane", Boolean(moved) && moved.h1 === "Memory" && moved.back && moved.href.startsWith("aither://explore/"), moved);
    await js("document.getElementById('w-back').click()");
    const back = await until(() => js("window.__explore.model().wiki.page === 'agent-loop'"));
    expect("Back returns to the page before", Boolean(back), back);

    await js("window.__explore.setGraphMode('all')");
    const whole = await until(() => js(`(() => { const m = window.__explore.model().wiki; const n = document.querySelectorAll('#w-canvas g.bs-node').length;
      return m.nodes === 4 && n === 4 ? { nodes: m.nodes, links: m.links, note: document.getElementById('w-graph-note').textContent } : null; })()`));
    expect("the whole wiki's link graph draws too", Boolean(whole) && whole.links >= 5, whole);

    // an external link: main is asked for an owner tab; this page does not navigate
    await until(() => js("Boolean(document.querySelector('#w-page a[data-ext]'))"));
    await js("document.querySelector('#w-page a[data-ext]').click()");
    await until(() => opened.length > 0, { tries: 20 });
    expect("an external link opens as an owner web tab", JSON.stringify(opened) === JSON.stringify(["https://example.com/loop"]), opened);
    expect("…and the pane itself did not navigate", wc.getURL().startsWith("aither://explore/"), wc.getURL());

    // 5 ── Graph with no gateway
    await js("window.__explore.show('graph')");
    await js("window.__explore.runGraphSearch('wiki')");
    const graph = await js(`({ model: window.__explore.model().graph,
      list: (document.querySelector('#g-list .state') || { dataset: {} }).dataset.state || null, listText: (document.querySelector('#g-list .state') || {}).textContent || "",
      canvas: (document.querySelector('#g-canvas .state') || { dataset: {} }).dataset.state || null, canvasText: (document.querySelector('#g-canvas .state') || {}).textContent || "",
      planets: document.querySelectorAll('#g-canvas g.bs-node').length })`);
    expect("with no gateway the Graph tab says the source is unreachable", graph.model.state === "unreachable" && graph.list === "unreachable"
      && /Graph source unreachable/.test(graph.listText), graph);
    expect("…on the canvas too, with what to start, and no empty canvas pretending", graph.canvas === "unreachable" && graph.planets === 0
      && /To fix: start the local gateway \(127\.0\.0\.1:8182\)/.test(graph.canvasText), graph);
    const stats = await until(() => js("(document.querySelector('#g-stats .state') || {}).textContent || ''"), { tries: 40 });
    expect("the graph service panel says unreachable as well", /unreachable/.test(String(stats)), stats);

    // 6 ── Context, offline
    await js("window.__explore.show('context')");
    const sessions = await until(() => js("(() => { const rows = [...document.querySelectorAll('#c-sessions .row')].map((r) => ({ id: r.dataset.id, text: r.textContent })); return rows.length ? rows : null; })()"));
    expect("the journals on this computer are listed with the daemon off", Array.isArray(sessions) && sessions.length === 1 && sessions[0].id === SID && /Smoke session/.test(sessions[0].text), sessions);
    const sources = await js("document.getElementById('c-sources').textContent");
    expect("…and the live directory is said to be off", /1 journals on this computer/.test(sources) && /live status off/.test(sources), sources);
    await js(`window.__explore.openSession(${JSON.stringify(SID)})`);
    const facts = await until(() => js("(() => { const t = document.getElementById('c-facts').textContent; return /prompt tokens in its last call/.test(t) ? t : null; })()"));
    expect("a session shows the API's own prompt-token count and the tool-call share", Boolean(facts) && /123,104/.test(facts) && /tool calls and tool results \(1 calls\)/.test(facts)
      && /Read \d+ B of a \d+ B journal — all of it/.test(facts), String(facts).slice(0, 400));
    const traces = await until(() => js("(document.querySelector('#c-traces .state') || {}).textContent || ''"), { tries: 40 });
    expect("platform LLM traces say why they are absent", /LLM traces/.test(String(traces)) && /To fix/.test(String(traces)), traces);
    const limits = await js("[...document.querySelectorAll('#c-limits li')].map((l) => l.textContent)");
    expect("what is not available is stated in the pane", limits.length >= 3 && /assembled prompt of a fleet agent's past call/.test(limits[0]), limits);
    // The one refusal this run CAUSED on purpose (the desk-code fetch above) is not a page error.
    expect("nothing on the page rendered as [object …]", !(await js("document.body.textContent.includes('[object ')")), null);
    const pageErrors = consoleErrors.filter((e) => !/explore-window.cjs/.test(e));
    expect("no console error from the page", pageErrors.length === 0, pageErrors);
    first.win.destroy();

    // 7 ── the address Alt+Space opens
    const deep = await open(prefs, exploreUrl({ tab: "wiki", q: "tools", page: "tools", source: "fixture-wiki" }));
    await deep.win.webContents.executeJavaScript("window.__explore.ready");
    const landed = await deep.win.webContents.executeJavaScript(`({ m: window.__explore.model(), q: document.getElementById('w-q').value,
      h1: (document.querySelector('#w-page h1') || {}).textContent, selected: document.querySelector('.tabs [aria-selected="true"]').dataset.tab })`);
    expect("a wiki deep link opens that page at that query", landed.selected === "wiki" && landed.q === "tools" && landed.h1 === "Tools" && landed.m.wiki.source === "fixture-wiki", landed);
    deep.win.destroy();
    const deepGraph = await open(prefs, exploreUrl({ tab: "graph", q: "lyra wiki" }));
    await deepGraph.win.webContents.executeJavaScript("window.__explore.ready");
    const g2 = await deepGraph.win.webContents.executeJavaScript("({ m: window.__explore.model(), q: document.getElementById('g-q').value })");
    expect("a graph deep link runs its search (and reports the source down)", g2.m.tab === "graph" && g2.q === "lyra wiki" && g2.m.graph.state === "unreachable", g2);
    deepGraph.win.destroy();
    const deepCtx = await open(prefs, exploreUrl({ tab: "context", session: SID }));
    await deepCtx.win.webContents.executeJavaScript("window.__explore.ready");
    const c2 = await deepCtx.win.webContents.executeJavaScript("({ m: window.__explore.model(), t: document.getElementById('c-facts').textContent.slice(0, 60) })");
    expect("a context deep link opens that session", c2.m.tab === "context" && c2.m.context.session === SID && c2.m.context.state === "ok", c2);
    deepCtx.win.destroy();

    // 7b ── Alt+Space: the REAL launcher, typed verbs, Enter. `run` is main's runCommand.
    const ran = [];
    const launcher = require("./launcher-window.cjs").createLauncher({
      electron: require("electron"),
      registry: { byId: () => null, rowsFor: () => [] },
      run: async (id, arg) => { ran.push([id, arg]); return { ok: true }; },
      ask: async () => ({ ok: true }),
      quickMenu: { openRadial: () => ({ ok: false }), releaseSelection: () => ({ ok: true }) },
      cards: async () => [],
    });
    launcher.warm(); // creates the window and registers the launcher's IPC
    launcher.press();
    const box = await until(() => BrowserWindow.getAllWindows().find((w) => /launcher.html/.test(w.webContents.getURL())), { tries: 20 });
    if (!box) {
      expect("the launcher window opened", false, "no launcher.html window");
    } else {
      const lj = (code) => box.webContents.executeJavaScript(code, true);
      const type = (text) => lj(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input")); })()`);
      const titles = () => lj(`[...document.querySelectorAll(".row .title")].map((t) => t.textContent)`);
      await sleep(400);
      await type("wiki memory");
      const wikiRows = await until(async () => { const t = await titles(); return t.some((x) => x === "Memory") ? t : null; }, { tries: 60 });
      const wikiStatus = await lj(`document.getElementById("status").textContent`);
      expect("Alt+Space `wiki memory` lists the folder's pages inline", Array.isArray(wikiRows) && /Search the wiki for/.test(wikiRows[0]) && wikiRows.includes("Memory"), wikiRows || await titles());
      expect("…and its status names the wiki it searched", /wiki pages? in Fixture Wiki/.test(wikiStatus), wikiStatus);
      await lj(`document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
      await until(() => ran.length > 0, { tries: 20 });
      expect("Enter runs explore.open at that query", JSON.stringify(ran[0]) === JSON.stringify(["explore.open", { tab: "wiki", q: "memory" }]), ran);
      launcher.press();
      await sleep(500);
      await type("graph lyra");
      const graphStatus = await until(async () => { const t = await lj(`document.getElementById("status").textContent`); return /source down/.test(t) ? t : null; }, { tries: 60 });
      expect("Alt+Space `graph lyra` with no gateway says the source is down, and still offers the pane", /^1 graph source down/.test(String(graphStatus))
        && (await titles()).some((x) => /Explore the graph for/.test(x)), graphStatus || await lj(`document.getElementById("status").textContent`));
      await type("context smoke");
      const ctxRows = await until(async () => { const t = await titles(); return t.includes("Smoke session") ? t : null; }, { tries: 60 });
      expect("Alt+Space `context smoke` lists the matching session", Array.isArray(ctxRows) && /Context for/.test(ctxRows[0]), ctxRows || await titles());
      box.destroy();
    }
  } else {
    // Printed, never judged: what the real gateway returns on this computer.
    await js("window.__explore.ready");
    await js("window.__explore.show('graph')");
    await js("window.__explore.runGraphSearch('wiki')");
    const live = await js(`({ model: window.__explore.model().graph, status: document.getElementById('g-status').textContent,
      rows: [...document.querySelectorAll('#g-list .row')].slice(0, 6).map((r) => r.textContent), state: (document.querySelector('#g-list .state') || {}).textContent || null,
      planets: document.querySelectorAll('#g-canvas g.bs-node').length })`);
    console.log("LIVE graph search 'wiki': " + JSON.stringify(live));
    const stats = await until(() => js("(() => { const t = document.getElementById('g-stats').textContent; return /Checking/.test(t) ? null : t; })()"), { tries: 80 });
    console.log("LIVE graph stats: " + JSON.stringify(String(stats).slice(0, 400)));
    await js("window.__explore.chooseSource('platform')");
    const wiki = await js("({ list: document.getElementById('w-list').textContent.slice(0, 400), state: (document.querySelector('#w-list .state') || { dataset: {} }).dataset.state || null })");
    console.log("LIVE wiki list (platform): " + JSON.stringify(wiki));
    await js("window.__explore.show('context')");
    const traces = await until(() => js("(() => { const t = document.getElementById('c-traces').textContent; return /Checking/.test(t) ? null : t; })()"), { tries: 80 });
    console.log("LIVE llm traces: " + JSON.stringify(String(traces).slice(0, 400)));
    // Judged even live: whatever the gateway returned, the page drew elements, not their names.
    await js("(() => { const row = document.querySelector('#g-list .row'); if (row) row.click(); })()");
    const drew = await js("({ leak: document.body.textContent.includes('[object '), detail: document.getElementById('g-detail').textContent.slice(0, 200) })");
    expect("live: the stats and node detail render as text, not as [object …]", drew.leak === false, drew);
    console.log("LIVE node detail: " + JSON.stringify(drew.detail));
    first.win.destroy();
  }

  // 8 ── an agent / web tab cannot open the pane or reach its bridge
  const { TabSet } = require("./browser-tabs.cjs");
  const refused = new TabSet().add("agent", { kind: "internal" });
  expect("an agent cannot be given an Aither page tab", refused.ok === false && /agent may only open web tabs/.test(refused.error), refused);
  expect("a web or agent tab may not navigate to aither://explore", internal.navigationVerdict("web", "aither://explore/") === "deny"
    && internal.navigationVerdict("hosted", "aither://explore/") === "deny", null);
  const direct = await open(webPrefs, "aither://explore/");
  expect("a web tab's session cannot load aither://explore", Boolean(direct.error), direct.error);
  direct.win.destroy();
  const webPage = "data:text/html;charset=utf-8," + encodeURIComponent('<!doctype html><title>web</title><iframe id="f" src="aither://explore/"></iframe>');
  const { win: web } = await open(webPrefs, webPage);
  await sleep(1200);
  const probe = await web.webContents.executeJavaScript(`(async () => {
    let fetched = "blocked";
    try { const r = await fetch("aither://explore/"); fetched = r.status; } catch { fetched = "blocked"; }
    return { fetched, bridge: typeof window.aitherExplore, frames: 0 };
  })()`);
  const frames = web.webContents.mainFrame.framesInSubtree.map((f) => f.url);
  expect("a web page cannot fetch, frame or call the pane", probe.fetched === "blocked" && probe.bridge === "undefined" && !frames.some((u) => u.startsWith("aither:")), { probe, frames });
  web.destroy();
  // Another Aither page has no explore bridge, and main refuses its sender anyway.
  const other = await open(prefs, internal.internalUrl("settings"));
  const otherBridge = await other.win.webContents.executeJavaScript("typeof window.aitherExplore");
  expect("another aither:// page is not handed the explore bridge", otherBridge === "undefined", otherBridge);
  other.win.destroy();

  console.log(fails.length ? `${fails.length} FAILED` : "ALL PASS");
  app.exit(fails.length ? 1 : 0);
}).catch((error) => {
  console.log("BROKE " + ((error && error.stack) || error));
  app.exit(2);
});
