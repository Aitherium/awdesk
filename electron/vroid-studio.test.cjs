"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const studio = require("./vroid-studio.cjs");

test("Steam library paths are read from libraryfolders.vdf", () => {
  const vdf = '"libraryfolders"\n{\n "0"\n {\n  "path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n }\n "1" { "path" "E:\\\\SteamLibrary" }\n}';
  assert.deepEqual(studio.steamLibraries(vdf), ["C:\\Program Files (x86)\\Steam", "E:\\SteamLibrary"]);
});

test("the official installer's newest version wins; missing = the download page", () => {
  const local = "L:\\Local";
  const files = new Set([
    path.join(local, "Programs", "VRoidStudio", "2.9.1", "VRoidStudio.exe"),
    path.join(local, "Programs", "VRoidStudio", "2.14.0", "VRoidStudio.exe"),
  ]);
  const deps = {
    env: { LOCALAPPDATA: local },
    exists: (p) => files.has(p),
    readdir: () => ["2.9.1", "2.14.0"],
    readFile: () => { throw new Error("no steam"); },
  };
  const found = studio.detect(deps);
  assert.equal(found.installed, true);
  assert.match(found.exe, /2\.14\.0/);
  const none = studio.detect({ ...deps, exists: () => false });
  assert.equal(none.installed, false);
  assert.equal(none.downloadUrl, "https://vroid.com/en/studio");
});

test("slugs are roster-safe", () => {
  assert.equal(studio.slugFor("C:\\x\\My Cool_Avatar v2.vrm"), "my-cool-avatar-v2");
  assert.equal(studio.slugFor("C:\\x\\___.vrm"), "vroid-avatar");
});

test("an import is unrated, unassigned, and never overwrites a body he has", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-"));
  const roster = path.join(root, "characters");
  fs.mkdirSync(path.join(roster, "mira"), { recursive: true });
  fs.writeFileSync(path.join(roster, "mira", "model.vrm"), "OLD");
  const file = path.join(root, "Mira.vrm");
  fs.writeFileSync(file, "NEW");
  const r = studio.importVrm(file, { rosterDir: roster });
  assert.equal(r.name, "mira-2");
  assert.equal(fs.readFileSync(path.join(roster, "mira", "model.vrm"), "utf8"), "OLD");
  const rec = JSON.parse(fs.readFileSync(path.join(roster, "mira-2", "character.json"), "utf8"));
  assert.equal(rec.rating, undefined, "unrated until he rates it");
  assert.equal(rec.source, "vroid-studio");
});

test("the export watch fires once per NEW settled .vrm and never backfills an old file", async () => {
  const handlers = [];
  const sizes = { "D:\\dl\\new.vrm": [10, 20, 20], "D:\\dl\\old.vrm": [5, 5] };
  const t0 = 1_000_000;
  const got = [];
  const w = studio.watchExports({
    folders: ["D:\\dl"],
    settleMs: 5,
    now: () => t0,
    watch: (_dir, _opts, fn) => { handlers.push(fn); return { close() {} }; },
    stat: (p) => ({ size: sizes[p].length > 1 ? sizes[p].shift() : sizes[p][0], mtimeMs: p.includes("old") ? t0 - 60_000 : t0 + 10 }),
    onFile: (f) => got.push(f),
  });
  handlers[0]("rename", "new.vrm");
  handlers[0]("rename", "old.vrm");
  handlers[0]("rename", "notes.txt");
  await new Promise((r) => setTimeout(r, 80));
  handlers[0]("change", "new.vrm");
  await new Promise((r) => setTimeout(r, 40));
  w.stop();
  assert.deepEqual(got, ["D:\\dl\\new.vrm"]);
});
