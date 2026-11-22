"use strict";

/**
 * launcher-search-smoke -- every category the Alt+Space box answers, typed into the
 * REAL launcher (launcher-window.cjs createLauncher + launcher.html + its preload,
 * the real universal search, the real command center, the real command registry).
 *
 * The owner's list (2026-11-13): file search, app search, agent prompting, web
 * search, context search, tools, skills, AitherOS apps vs host OS apps. One query per
 * category; each check says what came back and what Enter did.
 *
 * Nothing leaves the smoke: a temp userData (never the owner's profile), the
 * clipboard reader/writer replaced, shell.openPath / the AppsFolder launch / the web
 * opener / the command runner / the chat sender all RECORD instead of acting. The
 * searches themselves are live (Start menu, Windows Search, adk discover, awfind,
 * awm recall, the gateway), so a source that is down is reported as DOWN with its
 * reason, and the checks that need it say "skipped" -- they never pass silently.
 *
 *   electron electron/launcher-search-smoke.cjs [--audit]
 *
 * --audit prints what every query returned and the per-provider latency table and
 * always exits 0 (a measurement, not a gate).
 * Exit 0 pass · 1 a check failed · 2 the run broke (could not judge).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const electron = require("electron");
const { app, BrowserWindow } = electron;

const AUDIT = process.argv.includes("--audit");
// LAUNCHER_SMOKE_SHOTS=<existing dir>: a PNG of the box after every query.
const SHOTS = process.env.LAUNCHER_SMOKE_SHOTS && fs.existsSync(process.env.LAUNCHER_SMOKE_SHOTS) ? process.env.LAUNCHER_SMOKE_SHOTS : "";
let shotNo = 0;
const userData = path.join(os.tmpdir(), `awdesk-launcher-search-smoke-${process.pid}`);
app.setPath("userData", userData);
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

const fails = [];
const skipped = [];
function expect(what, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`);
  if (!ok) fails.push(what);
}
function skip(what, why) {
  console.log(`SKIP ${what} :: ${why}`);
  skipped.push(what);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── nothing real is launched ────────────────────────────────────────────────
const did = { openPath: [], appsFolder: [], web: [], run: [], ask: [], clipWrite: [] };
const flags = { memoryDown: false };
// The AppsFolder launch (search-window.cjs openAppsFolderEntry) is a powershell.exe
// Start-Process reading its target from the environment: record it, start nothing.
const realExecFile = childProcess.execFile;
childProcess.execFile = function execFileGuard(file, args, opts, cb) {
  const env = opts && typeof opts === "object" && opts.env;
  if (env && env.AWDESK_APPS_FOLDER_TARGET) {
    did.appsFolder.push(String(env.AWDESK_APPS_FOLDER_TARGET));
    const done = typeof opts === "function" ? opts : cb;
    setImmediate(() => done(null, "", ""));
    return { kill() {}, on() {}, stdin: null };
  }
  return realExecFile.apply(this, arguments);
};
let clipText = "launcher smoke clipboard sample 7731";
electron.clipboard.readText = () => clipText;
electron.clipboard.writeText = (t) => { did.clipWrite.push(String(t)); };
const shellStub = { ...electron.shell, openPath: async (p) => { did.openPath.push(String(p)); return ""; } };
const electronStub = new Proxy(electron, { get: (t, k) => (k === "shell" ? shellStub : t[k]) });

app.whenReady().then(async () => {
  let win = null;
  try {
    const registry = require("./command-registry.cjs");
    const sw = require("./search-window.cjs");
    // The command center with ONE seam: memory recall (awm) can be made to time out, the
    // way it does when the memory store is unreachable. Everything else stays live.
    require("./command-center.cjs").sharedCommandCenter({
      execFile: (file, args, opts, cb) => {
        if (file === "awm" && flags.memoryDown) {
          setImmediate(() => cb(Object.assign(new Error("Command failed: awm recall"), { killed: true }), "", ""));
          return { kill() {}, on() {} };
        }
        return childProcess.execFile(file, args, opts, cb);
      },
    });
    sw.setWebOpener(async (url) => { did.web.push(String(url)); });
    const launcher = require("./launcher-window.cjs").createLauncher({
      electron: electronStub,
      registry,
      run: async (id, arg) => { did.run.push({ id, arg }); return { ok: true }; },
      ask: async (t) => { did.ask.push(String(t)); return { ok: true }; },
      quickMenu: { openRadial: () => ({ ok: false }), releaseSelection: () => ({ ok: true }) },
      cards: async () => [],
    });
    launcher.warm();
    // The Store-app list (Get-StartApps) loads in the background; a first query waits
    // 2 s for it at most. Give it its real time once so "notepad" is judged warm.
    const universal = sw.universal();
    const apps = universal.registry.get("apps");
    void apps.search("warm").catch(() => {});
    await sleep(AUDIT ? 9_000 : 6_000);

    launcher.press();
    await sleep(700);
    win = BrowserWindow.getAllWindows().find((w) => /launcher\.html/.test(w.webContents.getURL()));
    if (!win) { console.error("launcher window not found"); app.exit(2); return; }
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const type = (text) => js(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input")); })()`);
    const key = (k) => js(`document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true }))`);
    const rows = () => js(`[...document.querySelectorAll(".row:not(.more)")].map((r) => ({ group: r.dataset.group || "", kind: (r.querySelector(".kind")||{}).textContent || "", title: (r.querySelector(".title")||{}).textContent || "", sub: (r.querySelector(".sub")||{}).textContent || "" }))`);
    const groups = () => js(`[...document.querySelectorAll(".group-label span:first-child")].map((s) => s.textContent)`);
    const status = () => js(`document.getElementById("status").textContent`);
    const chip = () => js(`document.getElementById("chip").textContent`);
    // The status line is the only place the slow half announces itself: blank it with a
    // sentinel before typing, then wait for an answer that is not "still coming".
    const SENTINEL = "(smoke waiting)";
    const settled = async (ms = 45_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const s = await status();
        if (s !== SENTINEL && !/still (coming|searching)|^Searching/.test(s)) return true;
        await sleep(250);
      }
      return false;
    };
    const select = async (pred) => {
      const list = await rows();
      const all = await js(`[...document.querySelectorAll(".row")].map((r) => r.classList.contains("more"))`);
      let seen = -1; let at = -1;
      for (let i = 0; i < all.length; i += 1) { if (!all[i]) { seen += 1; if (at < 0 && pred(list[seen])) at = i; } }
      if (at < 0) return false;
      await js(`(() => { for (let i = 0; i < 400; i += 1) { const sel = [...document.querySelectorAll(".row")].findIndex((r) => r.classList.contains("sel")); if (sel === ${at}) break; document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); } })()`);
      return true;
    };
    /** Type, wait for the slow half, report. */
    const ask = async (text) => {
      const t0 = Date.now();
      await js(`document.getElementById("status").textContent = ${JSON.stringify(SENTINEL)}`);
      await type(text);
      const ok = await settled();
      const out = { query: text, settled: ok, ms: Date.now() - t0, groups: await groups(), rows: await rows(), status: await status(), chip: await chip() };
      if (SHOTS) {
        // A hidden window (the box hides on blur) never answers capturePage: show it, and never wait on it.
        if (!win.isVisible()) win.showInactive();
        win.webContents.invalidate();
        await sleep(500);
        const file = path.join(SHOTS, `${String(shotNo += 1).padStart(2, "0")}-${text.replace(/[^a-z0-9]+/gi, "-").slice(0, 30) || "empty"}.png`);
        const img = await Promise.race([win.webContents.capturePage(), sleep(5_000)]);
        if (img) fs.writeFileSync(file, img.toPNG());
      }
      if (AUDIT) {
        console.log(`\n── "${text}" · ${out.ms} ms · settled=${ok} · chip=${out.chip}`);
        console.log(`   groups: ${out.groups.join(" | ")}`);
        for (const r of out.rows.slice(0, 14)) console.log(`   [${r.group}] ${r.kind} :: ${r.title} :: ${r.sub.slice(0, 80)}`);
        console.log(`   status: ${out.status}`);
      }
      return out;
    };
    const enter = async () => { await key("Enter"); await sleep(900); return status(); };
    const reopen = async () => { if (!launcher.isVisible()) { launcher.press(); await sleep(500); launcher.release(); await sleep(150); } };

    await runCases({ ask, enter, select, reopen, status, rows, groups, type, key, js, universal, launcher, registry,
      setClip: (t) => { clipText = t; } });
  } catch (error) {
    console.error(`smoke broke: ${error && error.stack}`);
    fails.push("run broke");
  } finally {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* temp */ }
    if (skipped.length) console.log(`skipped ${skipped.length}: ${skipped.join("; ")}`);
    console.log(fails.length ? `FAILED ${fails.length}: ${fails.join("; ")}` : "ALL PASS");
    app.exit(fails.includes("run broke") ? 2 : (fails.length && !AUDIT) ? 1 : 0);
  }
});

/** A source's "Not answering" row for one provider label, or null. */
function issueFor(out, label) {
  return out.rows.find((r) => r.group === "issues" && r.title.startsWith(label)) || null;
}

async function runCases(h) {
  const { ask, enter, select, reopen, universal, setClip } = h;
  const inGroup = (out, id) => out.rows.filter((r) => r.group === id);

  // ── the idle line names every source ──────────────────────────────────────
  {
    await reopen();
    const out = { status: await h.status() };
    await ask("x");
    await h.type("");
    await sleep(1_200);
    const again = await h.status();
    expect("idle: clearing the box returns to that line, not a stale result count", again === out.status || /^Searches AitherOS apps/.test(again) || /foreground|looking at/i.test(again), again);
    expect("idle: the status line names every source and the narrowing words",
      ["AitherOS apps", "PC apps", "files", "tools", "skills", "knowledge & memory", "the web", "narrow:"].every((w) => out.status.includes(w)), out.status);
  }

  // ── (a) host OS app ──────────────────────────────────────────────────────
  if (process.platform === "win32") {
    await reopen();
    const out = await ask("notepad");
    const app = inGroup(out, "apps").find((r) => /^Notepad$/i.test(r.title));
    expect("host app: “notepad” is in the group “Apps on this PC”", Boolean(app) && out.groups.includes("Apps on this PC"), out.groups);
    expect("host app: its row says PC app / Windows app", Boolean(app) && app.kind === "PC app" && /^Windows app/.test(app.sub), app);
    const before = did.appsFolder.length + did.openPath.length;
    await select((r) => r.group === "apps" && /^Notepad$/i.test(r.title));
    const after = await enter();
    expect("host app: Enter launches it (by AppID or shortcut path)", did.appsFolder.length + did.openPath.length === before + 1 && /opened Notepad/i.test(after),
      { after, appsFolder: did.appsFolder.slice(-1), openPath: did.openPath.slice(-1) });
  } else skip("host app", "the Start-menu provider is Windows-only");

  // ── (b) AitherOS apps ────────────────────────────────────────────────────
  {
    await reopen();
    const out = await ask("sprite");
    const first = out.rows.find((r) => r.group !== "verbs");
    expect("AitherOS app: “sprite” leads with the group “AitherOS apps”", out.groups[0] === "AitherOS apps" && first && first.title === "Sprite", { groups: out.groups, first });
    expect("AitherOS app: its row says AitherOS app, not Desk action", first && first.kind === "AitherOS app" && /^AitherOS app/.test(first.sub), first);
    expect("AitherOS app: it is not repeated under Desk actions", !inGroup(out, "actions").some((r) => /^Sprite…?$/.test(r.title)), inGroup(out, "actions").map((r) => r.title));
    const before = did.run.length;
    await select((r) => r.group === "osapps" && r.title === "Sprite");
    const after = await enter();
    expect("AitherOS app: Enter runs its registry row (osapp.sprite)", did.run.length === before + 1 && did.run[did.run.length - 1].id === "osapp.sprite" && /opened Sprite/.test(after),
      { after, ran: did.run.slice(-1) });
    await reopen();
    const strata = await ask("strata");
    expect("AitherOS app: “strata” finds Strata storage as an AitherOS app", inGroup(strata, "osapps").some((r) => r.title === "Strata storage"), strata.rows.slice(0, 4));
    await reopen();
    const both = await ask("app note");
    const gi = (label) => both.groups.indexOf(label);
    expect("apps scope: “app note” shows both groups, AitherOS apps first, and nothing else but Ask",
      gi("AitherOS apps") === 0 && gi("Apps on this PC") === 1 && both.rows.every((r) => ["osapps", "apps", "ask", "issues"].includes(r.group)) && both.chip === "Apps only",
      { groups: both.groups, chip: both.chip });
  }

  // ── (c) files ────────────────────────────────────────────────────────────
  {
    await reopen();
    const out = await ask("file package.json");
    const files = inGroup(out, "files");
    const down = issueFor(out, "Files");
    expect("files scope: “file package.json” answers with file rows only (or says why Files is down)",
      out.chip === "Files only" && (files.length > 0 || Boolean(down)) && out.rows.every((r) => ["files", "ask", "issues"].includes(r.group)),
      { chip: out.chip, files: files.length, down, status: out.status });
    if (files.length) {
      const before = did.openPath.length;
      await select((r) => r.group === "files");
      const after = await enter();
      expect("files: Enter opens the file by its remembered path", did.openPath.length === before + 1 && /package\.json/i.test(did.openPath[did.openPath.length - 1]) && /^opened /.test(after), { after });
    } else skip("files: Enter opens the file", down ? down.sub : "no file named package.json in the index");
  }

  // ── (d) agent prompting ──────────────────────────────────────────────────
  {
    await reopen();
    await ask("?what is on my calendar");
    let before = did.ask.length;
    let after = await enter();
    expect("ask: “?…” Enter sends the question to Aither", did.ask.length === before + 1 && did.ask[did.ask.length - 1] === "what is on my calendar", { after });
    await reopen();
    const plain = await ask("why is the fleet slow today");
    const last = plain.rows.filter((r) => r.group !== "issues").pop();
    expect("ask: plain text always ends in an “Ask Aither: …” row", Boolean(last) && last.group === "ask" && last.title === "Ask Aither: why is the fleet slow today", last);
    await reopen();
    const none = await ask("app zzqxnomatch");
    expect("ask: when nothing matches, the Ask row is the top row", none.rows.length > 0 && none.rows[0].group === "ask", none.rows.slice(0, 2));
    before = did.ask.length;
    after = await enter();
    expect("ask: Enter with nothing matched asks Aither with the typed words", did.ask.length === before + 1 && did.ask[did.ask.length - 1] === "zzqxnomatch", { after, asked: did.ask.slice(-1) });
  }

  // ── (e) spirit ───────────────────────────────────────────────────────────
  {
    await reopen();
    await ask("@find the release notes");
    const before = did.run.length;
    const after = await enter();
    expect("spirit: “@…” Enter runs spirit.go with the message", did.run.length === before + 1 && did.run[did.run.length - 1].id === "spirit.go"
      && did.run[did.run.length - 1].arg === "find the release notes", { after, ran: did.run.slice(-1) });
  }

  // ── (f) web ──────────────────────────────────────────────────────────────
  {
    await reopen();
    const out = await ask("web aitherium");
    const web = inGroup(out, "web");
    const down = issueFor(out, "Web");
    expect("web scope: “web aitherium” answers with web rows only (or says why the web is down)",
      out.chip === "Web only" && (web.length > 0 || Boolean(down)) && out.rows.every((r) => ["web", "ask", "issues"].includes(r.group)), { web: web.length, down, status: out.status });
    if (web.length) {
      const before = did.web.length;
      await select((r) => r.group === "web");
      const after = await enter();
      expect("web: Enter hands the address to the web opener (an Aither Browser tab in main.cjs)", did.web.length === before + 1 && /^https?:\/\//.test(did.web[did.web.length - 1]), { after, url: did.web.slice(-1) });
    } else skip("web: Enter opens the result", down ? down.sub : "no web rows");
  }

  // ── (g) context / knowledge / memory ─────────────────────────────────────
  {
    await reopen();
    const out = await ask("mem roadmap");
    const know = inGroup(out, "cc-knowledge");
    const down = issueFor(out, "Knowledge");
    expect("memory scope: “mem roadmap” answers from Knowledge only (plans, notebooks, memory)",
      out.chip === "Knowledge & memory only" && know.length > 0 && know.every((r) => ["plan", "notebook", "memory"].includes(r.kind))
      && out.rows.every((r) => ["cc-knowledge", "ask", "issues"].includes(r.group)), { kinds: [...new Set(know.map((r) => r.kind))], down, status: out.status });
    if (down) console.log(`  note: live memory recall is degraded right now :: ${down.sub}`);
    // Memory recall made to time out (the store unreachable): it must be a ROW with the
    // reason and the remedy, with the plans still listed -- never a silently short list.
    flags.memoryDown = true;
    await reopen();
    const broken = await ask("context roadmap plan");
    flags.memoryDown = false;
    const row = issueFor(broken, "Knowledge");
    expect("memory down: a “Knowledge answered only in part” row gives the reason and the remedy",
      Boolean(row) && row.kind === "not answering" && /awm took over \d+ s/.test(row.sub) && /search again|awm recall/.test(row.sub), row || broken.rows.slice(-3));
    expect("memory down: the plans still answer above it", inGroup(broken, "cc-knowledge").some((r) => r.kind === "plan"), inGroup(broken, "cc-knowledge").slice(0, 2));
    if (row) {
      const asked = did.ask.length;
      await select((r) => r.group === "issues" && r.title.startsWith("Knowledge"));
      const after = await enter();
      expect("memory down: Enter on that row repeats the reason and runs nothing", /source down — Knowledge/.test(after) && did.ask.length === asked, { after });
    }
  }

  // ── (h) tools · (i) skills ───────────────────────────────────────────────
  for (const [word, query, kind, chip] of [["tool", "tool git", "tool", "Tools only"], ["skill", "skill review", "skill", "Skills only"]]) {
    await reopen();
    const out = await ask(query);
    const rows = inGroup(out, "agents");
    const down = issueFor(out, "Agents, tools & skills");
    expect(`${word} scope: “${query}” lists ${kind}s only (or says why discovery is down)`,
      out.chip === chip && (rows.length > 0 || Boolean(down)) && rows.every((r) => r.kind === kind && new RegExp(`^${kind}`, "i").test(r.sub))
      && out.rows.every((r) => ["agents", "ask", "issues"].includes(r.group)), { n: rows.length, kinds: [...new Set(rows.map((r) => r.kind))], down, status: out.status });
    if (rows.length) {
      const before = did.ask.length;
      await select((r) => r.group === "agents");
      const after = await enter();
      const sent = did.ask[did.ask.length - 1] || "";
      expect(`${word}: Enter sends the words to Aither naming the ${kind}`, did.ask.length === before + 1 && new RegExp(`\\(Use the ${kind} "`).test(sent), { after, sent: sent.slice(0, 120) });
    } else skip(`${word}: Enter`, down ? down.sub : `no ${kind} matched`);
  }
  {
    await reopen();
    const out = await ask("review");
    const kinds = [...new Set(inGroup(out, "agents").map((r) => r.kind))];
    expect("unscoped: every discover row says whether it is an agent, a tool, a skill or a pack",
      kinds.every((k) => ["agent", "tool", "skill", "pack", "lane"].includes(k)) && (kinds.length > 0 || Boolean(issueFor(out, "Agents, tools & skills"))), kinds);
  }

  // ── (j) desk actions ─────────────────────────────────────────────────────
  {
    await reopen();
    const out = await ask("action snip");
    const rows = inGroup(out, "actions");
    expect("desk actions scope: “action snip” lists desk actions only", out.chip === "Desk actions only" && rows.length > 0 && rows.every((r) => r.kind === "action" && r.sub === "Desk action")
      && out.rows.every((r) => ["actions", "ask", "issues"].includes(r.group)), rows.slice(0, 3));
    const before = did.run.length;
    await select((r) => r.group === "actions");
    const after = await enter();
    expect("desk action: Enter runs the registry row", did.run.length === before + 1 && /^ran /.test(after), { after, ran: did.run.slice(-1) });
  }

  // ── (k) clipboard + screenshots ──────────────────────────────────────────
  {
    await reopen();
    const out = await ask("smoke clipboard sample");
    const clip = inGroup(out, "clipboard");
    expect("clipboard: text on the clipboard is found", clip.some((r) => /launcher smoke clipboard sample 7731/.test(r.title)), clip);
    const before = did.clipWrite.length;
    await select((r) => r.group === "clipboard");
    const after = await enter();
    expect("clipboard: Enter copies it back", did.clipWrite.length === before + 1 && /copied/.test(after), { after });
    // A credential-shaped clipboard is never a row (built at runtime; no key in this file).
    const secret = `${"gh"}${"p_"}${"A1b2C3d4E5f6G7h8I9j0".repeat(2).slice(0, 36)}`;
    setClip(secret);
    await reopen();
    const hidden = await ask("clipboard");
    expect("clipboard: credential-shaped text is never listed", !hidden.rows.some((r) => r.title.includes(secret.slice(0, 12)) || r.sub.includes(secret.slice(0, 12))), inGroup(hidden, "clipboard").length);
    setClip("launcher smoke clipboard sample 7731");
    await reopen();
    const shots = await ask("screenshot");
    const rows = inGroup(shots, "screenshots");
    if (rows.length) expect("screenshots: “screenshot” lists the newest captures", rows.every((r) => r.kind === "screenshot"), rows.slice(0, 2));
    else skip("screenshots", "the screenshots folder is empty on this host");
  }

  if (!AUDIT) return;
  // ── the measurement: per-provider latency, asked directly ─────────────────
  console.log("\n── provider latency (ms) per query");
  for (const q of ["notepad", "roadmap", "git"]) {
    const line = [];
    await Promise.all(universal.registry.list().map(async (p) => {
      const t0 = Date.now();
      let verdict = "ok";
      let n = 0;
      try {
        const r = await p.search(q, {});
        const items = Array.isArray(r) ? r : (r && r.items) || [];
        n = items.length;
        if (r && r.ok === false) verdict = `ERR ${r.reason}`;
        else if (r && r.note) verdict = `note ${r.note}`;
      } catch (e) { verdict = `THREW ${e.message}`; }
      line.push(`   ${q.padEnd(8)} ${p.id.padEnd(13)} ${String(Date.now() - t0).padStart(6)} ms  rows=${n}  ${verdict.slice(0, 200)}`);
    }));
    console.log(line.sort().join("\n"));
  }
}
