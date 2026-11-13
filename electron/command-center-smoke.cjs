"use strict";

/**
 * command-center-smoke -- the Alt+Space command center against the LIVE sources.
 *
 * Loads the REAL launcher (launcher-window.cjs createLauncher + launcher.html +
 * launcher-preload.cjs) with the real command center (gateway :8182, harness daemon
 * :8362, gh, awm, awrise), types one query per category into the one box and saves a
 * screenshot of each. Then it starts ONE throwaway shell session on the harness
 * daemon, finds it in the box, steers it (Ctrl+Enter, type, Enter) and stops it
 * (Ctrl+. twice), reads the daemon's transcript to prove the steer landed, opens the
 * graph pane on a person, and removes the session it started.
 *
 *   electron electron/command-center-smoke.cjs [shots-dir]
 *
 * Exit 0 pass · 1 a check failed · 2 the run broke (could not judge).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const electron = require("electron");
const { app, BrowserWindow } = electron;
// A window behind others is "occluded" and Chromium stops painting it: every capture
// then returns the frame from before the last change (measured: the graph pane open in
// the DOM, absent from the PNG). Keep it painting.
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

const SHOTS = path.resolve(process.argv.find((a, i) => i >= 2 && !a.startsWith("-") && !a.endsWith(".cjs")) || path.join(os.tmpdir(), "awdesk-cc-shots"));
const fails = [];
function expect(what, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 300)}`}`);
  if (!ok) fails.push(what);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cardsFromGateway() {
  try {
    const text = await require("./gateway-mcp.cjs").callTool("decisions_list", {});
    const data = JSON.parse(text);
    return (data.decisions || []).slice(0, 60).map((d, i) => ({
      id: d.id, title: d.title, summary: d.summary, kind: d.kind, urgency: d.urgency, needsYou: true, stale: false, position: i,
      defaultKey: d.default_key || "", options: (d.options || []).map((o, j) => ({ index: j + 1, key: o.key, label: o.label, recommended: o.recommended === true })),
    }));
  } catch {
    return [];
  }
}

app.whenReady().then(async () => {
  let launcherWin = null;
  let sessionId = "";
  const harness = require("./harness-relay.cjs").relayHarness;
  try {
    fs.mkdirSync(SHOTS, { recursive: false });
  } catch (error) {
    if (error.code !== "EEXIST") { console.error(`cannot make ${SHOTS}: ${error.message}`); app.exit(2); return; }
  }
  try {
    const asked = [];
    const cards = await cardsFromGateway();
    const launcher = require("./launcher-window.cjs").createLauncher({
      electron,
      registry: { byId: () => null, rowsFor: () => [] },
      run: async () => ({ ok: true }),
      ask: async (t) => { asked.push(t); return { ok: true }; },
      quickMenu: { openRadial: () => ({ ok: false }), releaseSelection: () => ({ ok: true }) },
      cards: async () => cards,
    });
    launcher.warm();
    // Warm the sources once so each screenshot shows the steady state, not the first load.
    const center = require("./command-center.cjs").sharedCommandCenter();
    const health = await center.warmAll();
    for (const h of health) console.log(`  source ${h.error ? "DOWN" : "ok  "} ${h.label}: ${h.rows} rows${h.error ? ` — ${h.error}` : ""}`);

    // A throwaway daemon-owned session so steer/stop have something that is ours to stop.
    const made = await harness({ method: "POST", path: "/sessions", body: { harness: "terminal", cwd: os.tmpdir(), title: "cc-steer-test" } });
    sessionId = made.ok && made.data ? String(made.data.id || made.data.session_id || "") : "";
    expect("the harness daemon started a test session", Boolean(sessionId), made.ok ? made.data : made);

    launcher.press();
    await sleep(600);
    launcherWin = BrowserWindow.getAllWindows().find((w) => /launcher\.html/.test(w.webContents.getURL()));
    if (!launcherWin) { console.error("launcher window not found"); app.exit(2); return; }
    const js = (code) => launcherWin.webContents.executeJavaScript(code, true);
    const type = async (text) => {
      await js(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input")); })()`);
    };
    const key = (k, ctrl = false) => js(`document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, ctrlKey: ${ctrl}, bubbles: true }))`);
    const rows = () => js(`[...document.querySelectorAll(".row")].map((r) => ({ kind: (r.querySelector(".kind")||{}).textContent || "", title: (r.querySelector(".title")||{}).textContent || "" }))`);
    const groups = () => js(`[...document.querySelectorAll(".group-label span:first-child")].map((s) => s.textContent)`);
    const status = () => js(`document.getElementById("status").textContent`);
    const shot = async (name) => {
      // A hidden or unfocused window paints nothing new: show it, repaint, then capture.
      if (!launcherWin.isVisible()) launcherWin.showInactive();
      launcherWin.moveTop();
      launcherWin.webContents.invalidate();
      await sleep(700);
      const img = await launcherWin.webContents.capturePage();
      if (process.env.CC_SMOKE_DEBUG) console.log("  debug", name, launcherWin.isVisible(), await js(`JSON.stringify({ cls: document.getElementById("pane").className, rect: document.getElementById("pane").getBoundingClientRect(), disp: getComputedStyle(document.getElementById("pane")).display })`));
      const file = path.join(SHOTS, `${name}.png`);
      fs.writeFileSync(file, img.toPNG());
      console.log(`  shot ${file}`);
      return file;
    };
    const waitFor = async (pred, ms = 25_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await pred()) return true; await sleep(400); }
      return false;
    };
    const select = async (pred) => {
      const list = await rows();
      const at = list.findIndex(pred);
      if (at < 0) return false;
      await js(`(() => { const nodes = document.querySelectorAll(".row"); nodes[${at}].dispatchEvent(new MouseEvent("mouseenter")); })()`);
      // Selection is keyboard-driven: walk the cursor there.
      await js(`(() => { for (let i = 0; i < 200; i += 1) { const sel = [...document.querySelectorAll(".row")].findIndex((r) => r.classList.contains("sel")); if (sel === ${at}) break; document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); } })()`);
      return true;
    };

    // 0. The empty box: Needs you + Working now.
    await type("");
    await waitFor(async () => (await groups()).length > 0, 8_000);
    expect("the empty box shows the live groups", (await groups()).some((g) => /Working now|Needs you/.test(g)), await groups());
    await select((r) => r.kind === "session" || r.kind === "run");
    await shot("00-empty-box");

    const CASES = process.env.CC_SMOKE_ONLY_GRAPH ? [] : [
      ["01-agents", "agents", "Agents & runs", (r) => /fleet-agent|local-agent/.test(r.kind)],
      ["02-sessions", "claude", "Agents & runs", (r) => r.kind === "session"],
      ["03-runs", "runs", "Agents & runs", (r) => r.kind === "run"],
      ["04-work-projects", "projects", "Work", (r) => r.kind === "project"],
      ["05-work-prs", "prs", "Work", (r) => r.kind === "pr"],
      ["06-work-cards", "post", "Needs you", (r) => r.kind === "card"],
      ["07-knowledge", "roadmap", "Knowledge", (r) => /plan|memory|notebook/.test(r.kind)],
      ["08-time-schedules", "schedules", "Time", (r) => r.kind === "schedule"],
      ["09-time-calendar", "calendar", "Time", (r) => r.kind === "event"],
      ["10-people", "jason", "People", (r) => r.kind === "person"],
    ];
    for (const [name, query, group, pred] of CASES) {
      await type(query);
      const ok = await waitFor(async () => (await rows()).some(pred) && !/still coming/.test(await status()), 30_000);
      const got = await rows();
      expect(`"${query}" returns ${group} rows`, ok, got.filter(pred).slice(0, 3));
      await select(pred);
      await shot(name);
    }

    // Graph on a person.
    await type("jason");
    await waitFor(async () => (await rows()).some((r) => r.kind === "person"));
    await select((r) => r.kind === "person");
    await key("g", true);
    const graphed = await waitFor(async () => js(`document.getElementById("pane").classList.contains("open") && !!document.querySelector("#pane-body svg")`), 40_000);
    const nodeCount = await js(`document.querySelectorAll("#pane-body svg circle").length`);
    expect("Ctrl+G draws the person's neighbourhood", graphed && nodeCount > 1, { nodeCount, title: await js(`document.getElementById("pane-title").textContent`), notes: await js(`document.getElementById("pane-notes").textContent`) });
    await shot("11-graph-person");
    await key("Escape");

    // Graph on a run.
    await type("runs");
    await waitFor(async () => (await rows()).some((r) => r.kind === "run"));
    await select((r) => r.kind === "run");
    await key("g", true);
    await waitFor(async () => js(`!!document.querySelector("#pane-body svg")`), 40_000);
    await shot("12-graph-run");
    await key("Escape");

    // Steer + stop the throwaway session.
    if (sessionId) {
      await sleep(21_000); // the sessions snapshot refreshes every 20 s
      await type("cc-steer-test");
      const found = await waitFor(async () => (await rows()).some((r) => r.kind === "session" && /cc-steer-test/.test(r.title)), 30_000);
      expect("the test session is found in the box", found, await rows());
      await select((r) => r.kind === "session" && /cc-steer-test/.test(r.title));
      await key("Enter", true);
      const chip = await js(`document.getElementById("chip").textContent`);
      expect("Ctrl+Enter turns the box into the steer message", /Steer/.test(chip), chip);
      await type("echo cc-steer-ok");
      await shot("13-steer-typing");
      await key("Enter");
      const steered = await waitFor(async () => /steered/.test(await status()), 15_000);
      expect("steer reports it was delivered", steered, await status());
      await sleep(2_500);
      const tr = await harness({ method: "GET", path: `/sessions/${sessionId}/events?since=0` });
      const text = JSON.stringify((tr.data && tr.data.events) || []);
      expect("the daemon's transcript shows the steer", /cc-steer-ok/.test(text), text.slice(-300));
      await type("cc-steer-test");
      await waitFor(async () => (await rows()).some((r) => r.kind === "session"));
      await select((r) => r.kind === "session" && /cc-steer-test/.test(r.title));
      await key(".", true);
      const armed = await status();
      await key(".", true);
      const stopped = await waitFor(async () => /interrupted/.test(await status()), 15_000);
      expect("Ctrl+. twice stops the session", /again/.test(armed) && stopped, { armed, now: await status() });
      await shot("14-stopped");
      await key("t", true);
      await waitFor(async () => js(`document.getElementById("pane").classList.contains("open")`), 15_000);
      await shot("15-transcript");
    }
    console.log(`asked chat ${asked.length}x`);
  } catch (error) {
    console.error(`smoke broke: ${error && error.stack}`);
    fails.push("run broke");
  } finally {
    if (sessionId) {
      const gone = await harness({ method: "DELETE", path: `/sessions/${sessionId}` });
      console.log(`  removed test session ${sessionId}: ${gone.ok ? "ok" : JSON.stringify(gone)}`);
    }
    console.log(fails.length ? `FAILED ${fails.length}: ${fails.join("; ")}` : "ALL PASS");
    app.exit(fails.includes("run broke") ? 2 : fails.length ? 1 : 0);
  }
});
