"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  POSTURE_LABELS, SLEEP_NOT_DEPLOYED, createHousePostureClient, drawPostureDot, groupState,
  houseTooltipLine, housePostureTrayItems, postureWord, wordForLabel,
} = require("./house-posture.cjs");

/** A fake gateway: tool name -> answer (object/string) or Error; records every call. */
function fakeCall(answers) {
  const calls = [];
  const call = async (name, args) => {
    calls.push([name, args]);
    const key = args && args.name ? `${name}:${args.name}` : name;
    const a = key in answers ? answers[key] : answers[name];
    if (a instanceof Error) throw a;
    if (a === undefined) throw new Error(`unknown tool ${name}`);
    return typeof a === "string" ? a : JSON.stringify(a);
  };
  return { call, calls };
}

const HOUSE = {
  fleet_posture_status: { ok: true, label: "Dark", posture: { desired: "dark" }, surfaces: {} },
  fleet_group_status: { ok: true, groups: { vibe: {}, garg: { summary: "Garg" }, darkmatter: {}, zeta: {} } },
  "fleet_group_status:garg": { group: "garg", ok: true, up: true, state: "awake", units: { a: "up" } },
  "fleet_group_status:darkmatter": { group: "darkmatter", ok: true, up: false, state: "parked", units: { a: "parked" } },
  "fleet_group_status:vibe": { group: "vibe", ok: true, up: false, state: "waking", units: { a: "waking" }, eta_s: 40 },
  "fleet_group_status:zeta": { group: "zeta", ok: false, up: null, error: "cannot judge" },
};

test("labels match the phone card word for word", () => {
  assert.deepEqual(POSTURE_LABELS, {
    shop: "Shop open", after: "After hours", game: "Game on", dark: "Dark", auto: "On schedule",
  });
  assert.equal(wordForLabel("Shop open"), "shop");
  assert.equal(wordForLabel("nonsense"), "unknown");
});

test("postureWord: label first, then applied/desired, else unknown", () => {
  assert.equal(postureWord({ label: "Game on" }), "game");
  assert.equal(postureWord({ label: "unknown", posture: { applied: { word: "after" } } }), "after");
  assert.equal(postureWord({ label: "unknown", posture: { desired: "auto" } }), "auto");
  assert.equal(postureWord(null), "unknown");
});

test("groupState reads waking, awake, asleep, unknown", () => {
  assert.equal(groupState({ ok: true, up: true }), "awake");
  assert.equal(groupState({ ok: true, up: false, state: "parked" }), "asleep");
  assert.equal(groupState({ ok: true, up: false, units: { x: "waking" } }), "waking");
  assert.equal(groupState({ ok: false, up: null }), "unknown");
  assert.equal(groupState(null), "unknown");
});

test("read: posture word + groups in the owner's order, per-group state", async () => {
  const { call } = fakeCall(HOUSE);
  const view = await createHousePostureClient({ call }).read();
  assert.equal(view.ok, true);
  assert.equal(view.label, "Dark");
  assert.deepEqual(view.groups.map((g) => [g.name, g.state]),
    [["darkmatter", "asleep"], ["garg", "awake"], ["vibe", "waking"], ["zeta", "unknown"]]);
  assert.equal(view.groups[2].etaS, 40);
});

test("read: an unreachable house is unknown, never a posture; cached for the window", async () => {
  const { call, calls } = fakeCall({ fleet_posture_status: new Error("ECONNREFUSED"), fleet_group_status: new Error("ECONNREFUSED") });
  let t = 0;
  const client = createHousePostureClient({ call, now: () => t });
  const view = await client.read();
  assert.equal(view.ok, false);
  assert.equal(view.label, "unknown");
  assert.match(view.problem, /ECONNREFUSED/);
  assert.deepEqual(view.groups, []);
  const n = calls.length;
  await client.read();
  assert.equal(calls.length, n, "second read inside the cache window makes no call");
  t = 60_000;
  await client.read();
  assert.ok(calls.length > n);
});

test("setPosture refuses an unknown word before any call; sends word (+until)", async () => {
  const { call, calls } = fakeCall({ fleet_posture_set: { ok: true, word: "game" } });
  const client = createHousePostureClient({ call });
  const bad = await client.setPosture("party");
  assert.equal(bad.ok, false);
  assert.equal(calls.length, 0);
  const ok = await client.setPosture("game", "2h");
  assert.equal(ok.ok, true);
  assert.equal(ok.message, "House is now Game on");
  assert.deepEqual(calls[0], ["fleet_posture_set", { word: "game", until: "2h" }]);
});

test("setPosture reports pending and refusals in words", async () => {
  const pend = createHousePostureClient({ call: fakeCall({ fleet_posture_set: { ok: true, pending: true } }).call });
  assert.equal((await pend.setPosture("shop")).message, "Shop open: still applying");
  const no = createHousePostureClient({ call: fakeCall({ fleet_posture_set: { ok: false, error: "owner only" } }).call });
  assert.deepEqual(await no.setPosture("shop"), { ok: false, message: "owner only" });
});

test("wake and sleep call the group tools; an absent park tool says so", async () => {
  const { call, calls } = fakeCall({ fleet_group_wake: { ok: true, state: "starting", eta_s: 90 } });
  const client = createHousePostureClient({ call });
  assert.equal((await client.wake("garg")).message, "garg is waking up -- about 90 s");
  assert.deepEqual(calls[0], ["fleet_group_wake", { name: "garg" }]);
  const sleep = await client.sleep("garg");
  assert.equal(sleep.ok, false);
  assert.equal(sleep.message, SLEEP_NOT_DEPLOYED);
  const ok = createHousePostureClient({ call: fakeCall({ fleet_group_park: { ok: true } }).call });
  assert.equal((await ok.sleep("dgg")).message, "dgg is going to sleep");
});

test("tray rows: header, posture radio, one actionable row per group", async () => {
  const view = await createHousePostureClient({ call: fakeCall(HOUSE).call }).read();
  const did = [];
  const rows = housePostureTrayItems(view, {
    setPosture: (w) => did.push(["set", w]), wake: (n) => did.push(["wake", n]), sleep: (n) => did.push(["sleep", n]),
  });
  assert.equal(rows[0].label, "● House: Dark");
  const posture = rows.find((r) => r.label === "Posture");
  assert.deepEqual(posture.submenu.map((r) => r.label), ["Shop open", "After hours", "Game on", "Dark", "On schedule"]);
  assert.equal(posture.submenu.find((r) => r.checked).label, "Dark");
  posture.submenu[2].click();
  const dm = rows.find((r) => /darkmatter/.test(r.label || ""));
  assert.match(dm.label, /asleep -- Wake/);
  dm.click();
  const garg = rows.find((r) => /garg/.test(r.label || ""));
  assert.match(garg.label, /awake -- Sleep/);
  garg.click();
  const vibe = rows.find((r) => /vibe/.test(r.label || ""));
  assert.equal(vibe.enabled, false);
  assert.deepEqual(did, [["set", "game"], ["wake", "darkmatter"], ["sleep", "garg"]]);
  assert.equal(rows[rows.length - 1].type, "separator");
});

test("tray rows before the first read and when the house is down", () => {
  assert.equal(housePostureTrayItems(null)[0].label, "● House: checking…");
  const rows = housePostureTrayItems({ ok: false, word: "unknown", label: "unknown", problem: "HTTP 503: down", groups: [] });
  assert.equal(rows[0].label, "● House: unknown");
  assert.match(rows[1].label, /HTTP 503/);
  assert.equal(houseTooltipLine(null), "");
  assert.equal(houseTooltipLine({ label: "Shop open" }), "House: Shop open");
});

test("drawPostureDot paints the top-left corner in the posture colour, leaves the rest", () => {
  const w = 20;
  const px = Buffer.alloc(w * w * 4, 0);
  assert.equal(drawPostureDot(px, w, w, "shop"), "shop");
  const centre = (4 * w + 4) * 4;
  assert.deepEqual([px[centre + 2], px[centre + 1], px[centre], px[centre + 3]], [0x30, 0xa4, 0x6c, 0xff]);
  const far = ((w - 1) * w + (w - 1)) * 4;
  assert.equal(px[far + 3], 0, "bottom-right (the inbox badge's corner) untouched");
  assert.equal(drawPostureDot(Buffer.alloc(w * w * 4), w, w, "bogus"), "unknown");
});
