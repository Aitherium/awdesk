"use strict";

/**
 * Browser sync against the REAL preferences store: two temp profiles, one account.
 *
 *   AW_SYNC_TOKEN_FILE=<file holding a platform bearer> node electron/browser-sync-live.cjs
 *
 * The unit tests run against a local stand-in; only this shows that the platform takes
 * the wire form as it is (Veil strips credential-shaped keys and values on the way in
 * and out, Directory caps and merges). It writes under its own throwaway prefix
 * (awbrowserlive<random>_*), never under the browser's, and removes every namespace it
 * wrote before it exits. The bearer is read from the file and never printed.
 *
 * Exit 0 all pass, 1 a check failed, 2 it could not run (no token file, store unreachable).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const nodeCrypto = require("node:crypto");
const sync = require("./browser-sync.cjs");
const { createLibrary } = require("./browser-library.cjs");

const origin = process.env.AW_SYNC_ORIGIN || "https://app.aitherium.com";
const tokenFile = process.env.AW_SYNC_TOKEN_FILE || "";
const prefix = `awbrowserlive${nodeCrypto.randomBytes(3).toString("hex")}`;

async function main() {
  let token = "";
  try { token = fs.readFileSync(tokenFile, "utf8").trim(); } catch { /* reported below */ }
  if (!token) { console.log("CANNOT RUN: AW_SYNC_TOKEN_FILE names no readable bearer file"); return 2; }
  // The account as the app works it out: the platform's session bearer is opaque, so Identity is asked.
  const account = sync.createAccountResolver({ check: (bearer) => require("./desk-session.cjs").checkToken(bearer) });
  const transport = sync.createPrefsTransport({ origin: () => origin, token: () => token, account });
  const first = await transport.pull();
  if (!first.ok) { console.log(`CANNOT RUN: ${origin} answered ${first.status} (${first.reason})`); return 2; }
  console.log(`store ${origin}${sync.PREFS_PATH} answered 200; test prefix ${prefix}`);

  const fails = [];
  const expect = (name, cond, detail) => {
    console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(detail)));
    if (!cond) fails.push(name);
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-sync-live-"));
  const device = (name) => {
    const dir = path.join(root, name);
    const d = { tabs: [], library: createLibrary({ file: path.join(dir, "browser-library.json") }) };
    d.sync = sync.createBrowserSync({ file: path.join(dir, "browser-sync.json"), library: d.library, tabs: () => d.tabs,
      deviceName: name, prefix, transport });
    return d;
  };
  const urls = (list) => list.map((e) => e.url).sort();
  const own = async () => sync.ownNamespaces((await transport.pull()).preferences, { prefix });

  try {
    const a = device("profile-a");
    const b = device("profile-b");
    a.library.toggleBookmark("https://example.com/keep", "Keep été 日本語");
    a.library.toggleBookmark("https://example.com/drop", "Drop");
    a.library.toggleBookmark("https://example.com/?token=NEVERSENT", "Secret link");
    a.library.visit("https://example.org/story", "Story");
    a.tabs = [{ by: "you", kind: "web", url: "https://example.org/story", title: "Story" },
      { by: "you", kind: "web", private: true, url: "https://example.net/private", title: "Private" },
      { by: "agent", kind: "web", url: "https://example.net/agent", title: "Agent" }];
    const s1 = await a.sync.setEnabled(true);
    a.sync.stop();
    expect("profile A syncs to the real store", s1.state === "ok", s1);
    const text = JSON.stringify(await own());
    expect("the store holds A's bookmark and tab", text.includes("example.com/keep") && text.includes("example.org/story"), Object.keys(JSON.parse(text)));
    expect("InPrivate, agent and secret-looking addresses are not in the store",
      !text.includes("example.net") && !text.includes("NEVERSENT"), null);

    const s2 = await b.sync.setEnabled(true);
    b.sync.stop();
    expect("profile B syncs", s2.state === "ok", s2);
    expect("B has A's bookmarks", urls(b.library.bookmarks()).join() === "https://example.com/drop,https://example.com/keep", urls(b.library.bookmarks()));
    expect("a non-ASCII title survives the round trip", (b.library.bookmarks().find((x) => x.url.endsWith("/keep")) || {}).title === "Keep été 日本語",
      b.library.bookmarks());
    expect("B has A's history", b.library.history(10).some((h) => h.url === "https://example.org/story"), b.library.history(10));
    const others = b.sync.otherDevices();
    expect("B sees A's open tab under \"Tabs from other devices\"", others.length === 1 && others[0].name === "profile-a"
      && others[0].tabs.length === 1 && others[0].tabs[0].url === "https://example.org/story", others);

    b.library.toggleBookmark("https://example.com/drop");
    const r3 = await b.sync.syncNow();
    expect("B deletes a bookmark and syncs", r3.ok === true, r3);
    const r4 = await a.sync.syncNow();
    expect("the delete reaches A", r4.ok && urls(a.library.bookmarks()).join() === "https://example.com/?token=NEVERSENT,https://example.com/keep", urls(a.library.bookmarks()));
    const r5 = await a.sync.syncNow();
    const r6 = await b.sync.syncNow();
    expect("a sync with nothing new writes nothing (the store returns what was sent)", r5.ok && r6.ok && r5.pushed === 0 && r6.pushed === 0, { a: r5, b: r6 });
    expect("the deleted bookmark did not come back", !urls(a.library.bookmarks()).includes("https://example.com/drop")
      && !urls(b.library.bookmarks()).includes("https://example.com/drop"), null);

    await a.sync.setEnabled(false);
    const afterOff = await own();
    expect("turning sync off on A withdraws A's tabs", !JSON.stringify(afterOff).includes("example.org/story\",\"t\":\"Story\"}]")
      && !Object.keys(afterOff).includes(`${prefix}_dev_${a.sync.status().deviceId}`), Object.keys(afterOff));
  } finally {
    // Remove everything this run wrote, whatever happened above.
    const left = await own();
    const patch = Object.fromEntries(Object.entries(left).map(([ns, v]) => [ns, Object.fromEntries(Object.keys(v).map((k) => [k, null]))]));
    if (Object.keys(patch).length) await transport.push(patch);
    const after = Object.keys(await own());
    expect("the test namespaces are removed from the account", after.length === 0, after);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
  }
  console.log(fails.length ? `FAILED ${fails.length}` : "ALL PASS");
  return fails.length ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }).catch((e) => { console.log("BROKE " + ((e && e.message) || e)); process.exitCode = 2; });
