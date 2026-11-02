"use strict";

// Controlled Folder Access, 2026-11-01: Defender refused the desk's electron.exe in
// Videos (event 1123) and Node's recursive mkdirSync LOOPED FOREVER on the main thread
// -- a screen recording froze the desk. These tests pin the replacement: one level at
// a time, a refusal throws at once, and captures fall back to ~/Aither Captures.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const snip = require("./snip-capture.cjs");
const core = require("./recorder-core.cjs");
const us = require("./universal-search.cjs");

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** An fs whose writes under `blocked` fail the way CFA does (ENOENT on mkdir, EPERM on write). */
function cfaFs(blocked) {
  const inside = (p) => path.resolve(String(p)).toLowerCase().startsWith(path.resolve(blocked).toLowerCase());
  return {
    ...fs,
    mkdirSync(p, opts) {
      if (opts && opts.recursive) throw new Error("recursive mkdir must never be called (it loops under CFA)");
      if (inside(p)) throw Object.assign(new Error(`ENOENT: no such file or directory, mkdir '${p}'`), { code: "ENOENT" });
      return fs.mkdirSync(p);
    },
    writeFileSync(p, ...rest) {
      if (inside(p)) throw Object.assign(new Error(`EPERM: operation not permitted, open '${p}'`), { code: "EPERM" });
      return fs.writeFileSync(p, ...rest);
    },
  };
}

test("ensureDirSafe creates every missing level without the recursive call", () => {
  const root = tmp("cd-ensure-");
  const deep = path.join(root, "a", "b", "c");
  const calls = [];
  const spy = { ...fs, mkdirSync(p, opts) { calls.push([p, opts]); return fs.mkdirSync(p, opts); } };
  snip.ensureDirSafe(deep, spy);
  assert.ok(fs.statSync(deep).isDirectory());
  assert.deepEqual(calls.map(([p]) => path.basename(p)), ["a", "b", "c"]);
  assert.ok(calls.every(([, opts]) => opts === undefined), "no {recursive: true}");
});

test("writableDir falls back when the preferred folder refuses, and caches the verdict", () => {
  snip.resetDirVerdicts();
  const root = tmp("cd-wd-");
  const blocked = path.join(root, "Pictures");
  fs.mkdirSync(blocked);
  const fsx = cfaFs(blocked);
  const preferred = path.join(blocked, "Aither Screenshots");
  const fallback = path.join(root, "Aither Captures", "Screenshots");
  const r = snip.writableDir([preferred, fallback], { fsImpl: fsx });
  assert.equal(r.ok, true);
  assert.equal(r.dir, path.resolve(fallback));
  assert.equal(r.fallback, true);
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0], /ENOENT/);
  // Second call: the refusal is cached, the preferred folder is not probed again.
  let probed = 0;
  const counting = { ...fsx, mkdirSync(p, o) { probed += 1; return fsx.mkdirSync(p, o); } };
  assert.equal(snip.writableDir([preferred, fallback], { fsImpl: counting }).dir, path.resolve(fallback));
  assert.equal(probed, 0);
});

test("writableDir reports every refusal when no folder can be written", () => {
  snip.resetDirVerdicts();
  const root = tmp("cd-none-");
  const fsx = cfaFs(root);
  const r = snip.writableDir([path.join(root, "x"), path.join(root, "y")], { fsImpl: fsx });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^2 folders refused the write/);
});

test("saveCapture lands in the fallback with a note when Pictures is protected", () => {
  snip.resetDirVerdicts();
  const root = tmp("cd-save-");
  const pictures = path.join(root, "Pictures");
  fs.mkdirSync(pictures);
  const fallback = path.join(root, "Aither Captures", "Screenshots");
  const v = snip.saveCapture({ png: Buffer.from([1, 2, 3]), dir: path.join(pictures, "Aither Screenshots"),
    fsImpl: cfaFs(pictures), fallbackDir: fallback, now: new Date(2026, 10, 1, 17, 30, 0) });
  assert.equal(v.ok, true);
  assert.equal(path.dirname(v.path), path.resolve(fallback));
  assert.ok(fs.existsSync(v.path));
  assert.match(v.note, /Controlled Folder Access/);
  assert.match(v.note, /Aither Captures/);
});

test("saveCapture in a writable folder has no note", () => {
  snip.resetDirVerdicts();
  const root = tmp("cd-ok-");
  const v = snip.saveCapture({ png: Buffer.from([1]), dir: path.join(root, "Shots"), fallbackDir: path.join(root, "fb") });
  assert.equal(v.ok, true);
  assert.equal(v.note, null);
  assert.equal(path.dirname(v.path), path.resolve(root, "Shots"));
});

test("finalizeRecording falls back from a protected Videos folder instead of hanging", async () => {
  snip.resetDirVerdicts();
  const root = tmp("cd-rec-");
  const videos = path.join(root, "Videos");
  fs.mkdirSync(videos);
  const temp = path.join(root, "rec-1-1.webm");
  fs.writeFileSync(temp, Buffer.alloc(64, 1));
  const fsx = cfaFs(videos);
  const fallback = snip.fallbackCaptureDir("Recordings", root);
  const real = snip.fallbackCaptureDir;
  snip.fallbackCaptureDir = (kind) => real(kind, root);
  try {
    const r = await core.finalizeRecording({ tempPath: temp, dir: path.join(videos, "Aither Recordings"),
      format: "webm", fsImpl: fsx, startedAt: new Date(2026, 10, 1, 17, 0, 0) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(path.dirname(r.path), path.resolve(fallback));
    assert.ok(fs.existsSync(r.path));
    assert.match(r.note, /Controlled Folder Access/);
  } finally {
    snip.fallbackCaptureDir = real;
  }
});

test("the screenshots search lists both the Pictures folder and the fallback", () => {
  const root = tmp("cd-us-");
  const a = path.join(root, "Aither Screenshots");
  const b = path.join(root, "Aither Captures", "Screenshots");
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(a, "Screenshot 2026-11-01 100000.png"), "");
  fs.writeFileSync(path.join(b, "Screenshot 2026-11-01 120000.png"), "");
  const p = us.screenshotsProvider({ dir: () => a, fallbackDir: () => b });
  const rows = p.search("screenshot");
  assert.deepEqual(rows.map((r) => r.title), ["Screenshot 2026-11-01 120000", "Screenshot 2026-11-01 100000"]);
  assert.equal(path.dirname(rows[0].target), b);
});
