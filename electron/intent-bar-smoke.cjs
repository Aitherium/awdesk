"use strict";

/**
 * intent-bar-smoke -- the REAL launcher window (launcher-window.cjs + launcher.html +
 * launcher-preload.cjs) with the REAL intent bar, never shown (show:false), driven by
 * keystrokes in its renderer and photographed with capturePage. The planner is a
 * fake MicroScheduler that answers one fixed plan; the commands record instead of run.
 *
 *   npx electron electron/intent-bar-smoke.cjs [outDir]
 *
 * Checks: `>` lists commands with their effect badge; `>timer 10m tea` carries the
 * argument; a sentence ends in "Do it"; Enter on it runs the window step and shows the
 * confirm line for the write; Enter again runs exactly that step; time-to-input-ready.
 * Exit 0 pass · 1 a check failed · 2 the run broke.
 */
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const electron = require("electron");
const { app } = electron;

const OUT = path.resolve(process.argv.find((a, i) => i > 1 && !a.startsWith("-") && !a.endsWith(".cjs")) || path.join(os.tmpdir(), "intent-bar-smoke"));
fs.mkdirSync(OUT, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "intent-bar-smoke-ud-")));

const fails = [];
function expect(what, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
  if (!ok) fails.push(what);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const ib = require("./intent-bar.cjs");
  const ran = [];
  const memory = ib.createBarMemory({ file: path.join(app.getPath("userData"), "bar.json") });
  memory.togglePin("fleet.open");
  memory.touch("snip.region");
  const bar = ib.createIntentBar({
    memory,
    chat: async () => ({ ok: true, model: "bonsai2-27b (fake)", text: JSON.stringify({
      say: "A whiteboard is open; switching the GPU to game mode needs your OK.",
      steps: [{ tool: "board.new" }, { tool: "timer.start", args: { text: "25m focus" } }, { tool: "fleet.gaming" }],
    }) }),
    runTool: async (id, args) => { ran.push([id, args]); return { ok: true, did: `${id} ran` }; },
  });
  const quickMenu = { openRadial: () => ({ ok: false }) };
  const launcher = require("./launcher-window.cjs").createLauncher({
    electron, registry: require("./command-registry.cjs"), quickMenu,
    run: async (id, arg) => { ran.push([id, arg]); return { ok: true }; },
    ask: async () => ({ ok: true }), intentBar: () => bar,
    universalSearch: () => ({ run: async (term, opts) => ({ ok: true, query: term, phase: opts.phase, groups: [], errors: [], notes: [], total: 0 }) }),
  });
  const t0 = Date.now();
  launcher.warm();
  const win = electron.BrowserWindow.getAllWindows()[0];
  expect("the launcher window exists and is NOT shown", Boolean(win) && !win.isVisible());
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once("did-finish-load", r) : r()));
  const ready = Date.now() - t0;
  const js = (code) => win.webContents.executeJavaScript(code, true);
  expect("the input is in the page and focusable", await js("Boolean(document.getElementById('input'))"));
  console.log(`INFO window warm -> page loaded in ${ready} ms (Alt+Space then only shows + focuses it)`);

  async function type(text, settle = 450) {
    await js(`(() => { const i = document.getElementById('input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); })()`);
    await wait(settle);
  }
  async function key(k) {
    await js(`document.getElementById('input').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`);
    await wait(500);
  }
  async function shot(name) {
    const img = await win.webContents.capturePage();
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    console.log(`SHOT ${file} ${img.getSize().width}x${img.getSize().height}`);
    return img.getSize().width > 0;
  }
  const rows = () => js("[...document.querySelectorAll('#results .row')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())");

  await type("", 600);
  const emptyRows = await rows();
  expect("the empty box lists Pinned and Recent", emptyRows.some((r) => /★ Fleet window/.test(r)) && emptyRows.some((r) => /Snip a region/.test(r)), emptyRows.slice(0, 6));
  await shot("1-empty-pinned-recent");

  await type(">whiteboard");
  const cmd = await rows();
  expect("`>whiteboard` leads with New whiteboard, badged `opens`", /New whiteboard.*opens/.test(cmd[0] || ""), cmd.slice(0, 3));
  expect("the chip says Desk commands", (await js("document.getElementById('chip').textContent")) === "> Desk commands");
  await shot("2-command-whiteboard");

  await type(">timer 10m tea");
  const timer = await rows();
  expect("`>timer 10m tea` offers the timer WITH its argument", /Start a timer… — “10m tea”/.test(timer[0] || ""), timer.slice(0, 2));
  await key("Enter");
  expect("Enter ran timer.start with “10m tea”", ran.some((r) => r[0] === "timer.start" && r[1] === "10m tea"), ran);
  await shot("3-command-timer");

  await type("whiteboard, a 25 minute focus timer, then game mode", 700);
  const sentence = await rows();
  expect("a sentence ends in Do it, then Ask Aither", sentence.some((r) => /^⚡ Do it: whiteboard/.test(r)) && /Ask Aither/.test(sentence[sentence.length - 1] || ""), sentence);
  // Keyboard only: arrow down to the Do it row, then Enter.
  const at = sentence.findIndex((r) => /Do it:/.test(r));
  for (let i = 0; i < at; i += 1) await key("ArrowDown");
  ran.length = 0;
  await key("Enter");
  await wait(400);
  const out = await js("document.getElementById('output-body').textContent");
  const status = await js("document.getElementById('status').textContent");
  expect("the window + timer steps ran at once", ran.map((r) => r[0]).join(",") === "board.new,timer.start", ran);
  expect("the plan shows inline", /✓ New whiteboard/.test(out) && /waiting: GPU sleep/.test(out), out);
  expect("the write waits on ONE confirm line", /^Enter to confirm: GPU sleep \(game on\) \[write\] — Esc cancels$/.test(status), status);
  await shot("4-intent-plan-confirm");
  await key("Enter");
  await wait(300);
  expect("Enter confirmed exactly the waiting step", ran.map((r) => r[0]).join(",") === "board.new,timer.start,fleet.gaming", ran);
  await shot("5-intent-confirmed");

  console.log(fails.length ? `FAILED ${fails.length}: ${fails.join(" | ")}` : "ALL PASS");
  app.exit(fails.length ? 1 : 0);
}).catch((error) => {
  console.error(`BROKE ${String((error && error.stack) || error)}`);
  app.exit(2);
});
