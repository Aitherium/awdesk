"use strict";

/**
 * Do the Aither Browser's page scripts work on a REAL page? A real Electron run
 * that exits by itself (`npm run test:browser`), like console-smoke.cjs.
 *
 * browser-policy.test.cjs proves every script PARSES; only a live DOM shows what
 * they find. Its first run (2026-10-03) caught a <select> inside its <label>
 * reporting its label as "Support topic 1. Multiplayer Other" -- the exact layout
 * of the pixiv form the agent was filling when the owner asked for this overhaul.
 *
 * Own entry point: no single-instance lock, no tray, a hidden window, a data: page.
 * Exit 0 all pass, 1 a check failed, 2 the run itself broke, 3 it hung.
 */
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const bw = require("./browser-window.cjs");

app.setPath("userData", path.join(os.tmpdir(), `awdesk-browser-smoke-${process.pid}`));
process.on("unhandledRejection", (e) => { console.log("REJECT " + ((e && e.stack) || e)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 60000);
const FORM = `<!doctype html><html><body><form action="/send">
<label>Name<div><input></div></label>
<label>E-mail address<div><input type="email"></div></label>
<label>Support topic<div><select><option value=""></option><option value="mp">1. Multiplayer</option><option value="other">Other</option></select></div></label>
<label for="pw">Password</label><input id="pw" type="password" value="hunter2">
<textarea aria-label="Details"></textarea>
<label><input type="checkbox" id="agree"> Agree to the Privacy Policy</label>
<div role="checkbox" aria-checked="false" aria-label="Fancy" tabindex="0" onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked') !== 'true')">x</div>
<input type="hidden" name="secret" value="nope">
<button>Send</button>
</form>
<iframe srcdoc="<p>captcha</p>"></iframe>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(FORM));
  const wc = win.webContents;
  const run = (action, args) => wc.executeJavaScriptInIsolatedWorld(1017, [{ code: bw.scriptFor(action, args) }], false);
  const fails = [];
  const expect = (name, cond, detail) => { console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(detail))); if (!cond) fails.push(name); };

  const snap = await run("snapshot", {});
  const by = (label) => snap.elements.find((e) => e.label === label);
  expect("snapshot lists 8 visible controls, not the hidden input", snap.count === 8, snap.elements.map((e) => e.label));
  expect("labels from wrapping <label>", by("Name") && by("E-mail address") && by("Support topic"), snap.elements);
  expect("label[for] label", by("Password") && by("Password").type === "password", by("Password"));
  expect("password value never leaves", by("Password").value === "(filled)", by("Password"));
  expect("select options listed", JSON.stringify(by("Support topic").options) === JSON.stringify(["", "1. Multiplayer", "Other"]), by("Support topic"));
  expect("iframe note", snap.frames === 1 && /iframes/.test(snap.note), snap);

  const name = by("Name").ref;
  const typed = await run("type", { target: { ref: name }, text: "David" });
  expect("type by ref, read back, returns label", typed.ok && typed.label === "Name", typed);
  const sel = await run("select", { target: { ref: by("Support topic").ref }, option: "Other" });
  expect("select by visible text", sel.ok && sel.selected === "Other", sel);
  const part = await run("select", { target: { ref: by("Support topic").ref }, option: "multi" });
  expect("select by partial text", part.ok && part.selected === "1. Multiplayer", part);
  const miss = await run("select", { target: { ref: by("Support topic").ref }, option: "Nope" });
  expect("select miss returns options", !miss.ok && miss.options.length === 3, miss);
  const agree = by("Agree to the Privacy Policy");
  const chk = await run("check", { target: { ref: agree.ref }, checked: true });
  expect("check a checkbox", chk.ok && chk.checked === true, chk);
  const aria = await run("check", { target: { ref: by("Fancy").ref }, checked: true });
  expect("check an aria checkbox", aria.ok && aria.checked === true, aria);
  const notText = await run("type", { target: { ref: by("Send").ref }, text: "x" });
  expect("type into a button is refused", !notText.ok, notText);
  const bySel = await run("type", { target: { selector: "textarea" }, text: "hello" });
  expect("type by selector", bySel.ok && bySel.label === "Details", bySel);
  const hl = await run("highlight", { target: { ref: name } });
  expect("highlight", hl.ok, hl);

  // AitherDesktop push: the machine layer, field NAMES and labels -- never a value.
  const { CONTEXT_SCRIPT } = require("./browser-context-push.cjs");
  const ctx = await wc.executeJavaScriptInIsolatedWorld(1017, [{ code: CONTEXT_SCRIPT }], false);
  expect("context script reads the page", ctx && typeof ctx.title === "string" && Array.isArray(ctx.forms), ctx);
  const fields = (ctx.forms[0] || { fields: [] }).fields;
  expect("context lists the form's fields by label", fields.some((f) => f.label === "Password") && fields.some((f) => f.label === "Name"), ctx.forms);
  // The page URL is a data: URL holding the whole HTML, so judge what the script READ, not the URL.
  const read = JSON.stringify({ ...ctx, url: "", pathname: "" });
  expect("context push carries no typed value or password", !read.includes("David") && !read.includes("hunter2") && !read.includes("nope"), read);

  // A navigation clears the refs: a stale ref must say so, never hit another element.
  await win.loadURL("data:text/html,<input aria-label=Other>");
  const stale = await run("type", { target: { ref: name }, text: "x" });
  expect("stale ref after navigation", !stale.ok && /stale/.test(stale.error), stale);
  // Page JS cannot see the isolated world's ref map.
  const leak = await wc.executeJavaScript("typeof window.__aitherRefs");
  await run("snapshot", {});
  const leak2 = await wc.executeJavaScript("typeof window.__aitherRefs");
  expect("page world cannot see refs", leak === "undefined" && leak2 === "undefined", { leak, leak2 });

  const shot = await wc.capturePage();
  expect("capturePage yields an image", shot.getSize().width > 0, shot.getSize());
  console.log(fails.length ? `FAILED ${fails.length}` : "ALL PASS");
  app.exit(fails.length ? 1 : 0);
});
