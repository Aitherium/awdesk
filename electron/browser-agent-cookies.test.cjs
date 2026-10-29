"use strict";

/**
 * browser-agent-cookies.test.cjs -- BROWSER-M3: an agent tab is created in its OWN
 * session unless the owner allowed the site, and the owner's list is what the
 * toolbar shows and revokes. Pure: no Electron, no window.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const cookies = require("./browser-agent-cookies.cjs");
const { normalizeLayout } = require("./browser-rail.cjs");

const OWNER = "persist:aither-browser";

test("an agent tab is created on persist:agent by default; an owner tab never is", () => {
  assert.equal(cookies.partitionFor({ by: "agent", url: "https://mail.example.com/inbox", ownerPartition: OWNER }),
    cookies.AGENT_PARTITION);
  assert.equal(cookies.AGENT_PARTITION, "persist:agent");
  assert.equal(cookies.partitionFor({ by: "you", url: "https://mail.example.com/inbox", ownerPartition: OWNER }), OWNER);
  // The owner's partition comes from the caller -- the module never spells it twice.
  assert.equal(cookies.partitionFor({ by: "you", url: "https://x.test/", ownerPartition: "persist:other" }), "persist:other");
});

test("with a site allow-listed the agent tab is created on the OWNER's partition", () => {
  const sites = ["mail.example.com"];
  assert.equal(cookies.partitionFor({ by: "agent", url: "https://mail.example.com/inbox", sites, ownerPartition: OWNER }), OWNER);
  // Per site, exactly: another site, and a subdomain of the allowed one, keep the agent session.
  assert.equal(cookies.partitionFor({ by: "agent", url: "https://bank.example.com/", sites, ownerPartition: OWNER }),
    cookies.AGENT_PARTITION);
  assert.equal(cookies.partitionFor({ by: "agent", url: "https://a.mail.example.com/", sites, ownerPartition: OWNER }),
    cookies.AGENT_PARTITION);
  // A port is not part of the site; http and https are the same site by host.
  assert.equal(cookies.partitionFor({ by: "agent", url: "http://mail.example.com:8080/x", sites, ownerPartition: OWNER }), OWNER);
});

test("revoking returns the site to the agent partition", () => {
  const allowed = cookies.allow([], "https://mail.example.com/inbox");
  assert.deepEqual(allowed, { ok: true, host: "mail.example.com", sites: ["mail.example.com"] });
  const url = "https://mail.example.com/inbox";
  assert.equal(cookies.partitionFor({ by: "agent", url, sites: allowed.sites, ownerPartition: OWNER }), OWNER);
  const revoked = cookies.revoke(allowed.sites, url);
  assert.deepEqual(revoked, { ok: true, host: "mail.example.com", sites: [] });
  assert.equal(cookies.partitionFor({ by: "agent", url, sites: revoked.sites, ownerPartition: OWNER }),
    cookies.AGENT_PARTITION);
  // Revoking a site that was never allowed is not an error, and changes nothing else.
  const two = ["a.test", "b.test"];
  assert.deepEqual(cookies.revoke(two, "c.test").sites, two);
});

test("a page with no site cannot be allowed or revoked", () => {
  for (const url of ["aither://settings", "about:blank", "data:text/html,x", "", null, "not a url"]) {
    assert.equal(cookies.hostOf(url), "", `${url} has no site`);
    const allowed = cookies.allow([], url);
    assert.equal(allowed.ok, false);
    assert.match(allowed.error, /no site/);
  }
});

test("the stored list is sanitized: hosts only, lower case, unique, capped", () => {
  assert.deepEqual(cookies.normalizeSites(["Mail.Example.com", "mail.example.com", "https://x.test/a", "*.y.test",
    "z.test:8080", "-bad.test", "", null, 42, "localhost"]), ["mail.example.com", "localhost"]);
  assert.deepEqual(cookies.normalizeSites("not-an-array"), []);
  const many = Array.from({ length: cookies.MAX_SITES + 10 }, (_, i) => `s${i}.test`);
  assert.equal(cookies.normalizeSites(many).length, cookies.MAX_SITES);
  const full = cookies.allow(many, "https://one-more.test/");
  assert.equal(full.ok, false);
  assert.match(full.error, /revoke one first/);
  // Trailing dot (a fully-qualified name) is the same site.
  assert.deepEqual(cookies.normalizeSites(["mail.example.com."]), ["mail.example.com"]);
});

test("stateFor is what the toolbar renders: the page's site, its state, the whole list", () => {
  const sites = ["mail.example.com", "docs.example.com"];
  assert.deepEqual(cookies.stateFor(sites, "https://mail.example.com/inbox"),
    { host: "mail.example.com", allowed: true, sites });
  assert.deepEqual(cookies.stateFor(sites, "https://shop.example.com/"),
    { host: "shop.example.com", allowed: false, sites });
  assert.deepEqual(cookies.stateFor(sites, "aither://settings"), { host: "", allowed: false, sites });
});

test("prefs round-trip: the allow-list survives normalizeLayout, and junk in the file cannot wedge it", () => {
  const prefs = normalizeLayout({ agentCookieSites: ["Mail.Example.com", "https://bad.test/x", "docs.example.com"] });
  assert.deepEqual(prefs.agentCookieSites, ["mail.example.com", "docs.example.com"]);
  const again = normalizeLayout(JSON.parse(JSON.stringify(prefs)));
  assert.deepEqual(again.agentCookieSites, prefs.agentCookieSites, "the file it writes reads back the same");
  assert.deepEqual(normalizeLayout({}).agentCookieSites, [], "default is OFF for every site");
  assert.deepEqual(normalizeLayout({ agentCookieSites: "nope" }).agentCookieSites, []);
  // The rest of the layout is untouched by the new key.
  assert.equal(normalizeLayout({ agentCookieSites: ["a.test"], railWidth: 250 }).railWidth, 250);
});
