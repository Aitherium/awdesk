"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const share = require("./share-detect.cjs");

test("capture apps are recognised by image name, case-insensitively", () => {
  assert.deepEqual(share.sharingFrom(["explorer.exe", "OBS64.EXE"]), ["OBS"]);
  assert.deepEqual(share.sharingFrom(["CptHost.exe", "Zoom.exe"]), ["Zoom screen share"]);
  assert.deepEqual(share.sharingFrom(["Zoom.exe", "Discord.exe"]), [], "Zoom open but not sharing is not a share");
});

test("tasklist csv is parsed", () => {
  const text = '"System Idle Process","0","Services","0","8 K"\r\n"obs64.exe","1234","Console","1","200,000 K"\r\n';
  assert.deepEqual(share.parseTasklist(text), ["System Idle Process", "obs64.exe"]);
});

test("the watch reports changes only, and a failed poll changes nothing", async () => {
  const seen = [];
  let answer = ["obs64.exe"];
  const w = share.createShareWatch({ onChange: (l) => seen.push(l), list: async () => answer });
  await w.tick();
  await w.tick();
  answer = null; // tasklist failed
  await w.tick();
  answer = [];
  await w.tick();
  assert.deepEqual(seen, [["OBS"], []]);
});
