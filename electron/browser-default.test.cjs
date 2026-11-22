"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const d = require("./browser-default.cjs");

const EXE = "C:\\Program Files\\Aither\\Desk.exe";

test("the open command quotes every path and carries the URL flag", () => {
  assert.equal(d.openCommand({ exe: EXE }), `"${EXE}" --browser-url "%1"`);
  assert.equal(d.openCommand({ exe: "C:\\e\\electron.exe", appArgs: ["D:\\desk"] }), `"C:\\e\\electron.exe" "D:\\desk" --browser-url "%1"`);
  assert.throws(() => d.openCommand({ exe: "relative.exe" }));
  assert.throws(() => d.openCommand({ exe: 'C:\\a"b.exe' }));
});

test("registration covers http and https, and lists the app", () => {
  const cmds = d.registerCommands({ exe: EXE });
  const flat = cmds.map((c) => c.join(" "));
  assert.ok(cmds.every((c) => c[0] === "add" && c[1].startsWith("HKCU\\")), "HKCU only, adds only");
  assert.ok(!flat.some((l) => l.includes("FileAssociations")), "no file types: file: pages are refused");
  for (const want of ["URLAssociations /v http ", "URLAssociations /v https "]) {
    assert.ok(flat.some((l) => l.includes(want)), want);
  }
  assert.ok(flat.some((l) => l.startsWith("add HKCU\\Software\\RegisteredApplications /v Aither Browser ")));
});

test("unregister deletes exactly the keys registration wrote", () => {
  const written = new Set(d.registerCommands({ exe: EXE }).map((c) => c[1]));
  for (const [, key] of d.unregisterCommands()) {
    assert.ok([...written].some((k) => k === key || k.startsWith(`${key}\\`)), key);
  }
});

test("argv: only http(s) opens; anything else is refused", () => {
  assert.equal(d.urlFromArgv(["x.exe", "--browser-url", "https://example.com/a?b=1"]), "https://example.com/a?b=1");
  assert.equal(d.urlFromArgv(["--browser-url=http://x.test"]), "http://x.test/");
  for (const bad of [["--browser-url", "C:\\Users\\me\\Doc.pdf"],["--browser-url", "javascript:alert(1)"], ["--browser-url", "C:\\x\\evil.exe"], ["--browser-url"], ["https://x.test"], []]) {
    assert.equal(d.urlFromArgv(bad), null, JSON.stringify(bad));
  }
});

test("register runs every add, opens Settings, and rolls back on a refusal", async () => {
  const calls = [];
  let opened = null;
  const ok = d.createDefaultBrowser({
    platform: "win32", exe: EXE, env: { SystemRoot: "C:\\Windows" },
    execFile: async (_f, args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; },
    openExternal: async (u) => { opened = u; },
  });
  const r = await ok.register();
  assert.equal(r.ok, true);
  assert.equal(calls.length, d.registerCommands({ exe: EXE }).length);
  assert.equal(opened, d.settingsUri());

  const seen = [];
  let n = 0;
  const bad = d.createDefaultBrowser({
    platform: "win32", exe: EXE, env: {},
    execFile: async (_f, args) => { seen.push(args[0]); n += 1; return n === 3 ? { code: 1, stdout: "", stderr: "Access is denied." } : { code: 0, stdout: "", stderr: "" }; },
  });
  const r2 = await bad.register();
  assert.equal(r2.ok, false);
  assert.match(r2.error, /rolled back/);
  assert.equal(seen.filter((v) => v === "delete").length, d.unregisterCommands().length);
});

test("registered() is true only when the command points at this desk", async () => {
  const mk = (stdout) => d.createDefaultBrowser({ platform: "win32", exe: EXE, env: {}, execFile: async () => ({ code: 0, stdout, stderr: "" }) });
  assert.equal(await mk(`    (Default)    REG_SZ    ${d.openCommand({ exe: EXE })}`).registered(), true);
  assert.equal(await mk(`    (Default)    REG_SZ    "C:\\old\\Desk.exe" --browser-url "%1"`).registered(), false);
  assert.equal(await d.createDefaultBrowser({ platform: "linux" }).registered(), false);
});
