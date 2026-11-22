"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tenant = require("./desk-tenant.cjs");

function home(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-tenant-"));
  if (config !== undefined) {
    fs.mkdirSync(path.join(dir, ".aither"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".aither", "desk-tenant.json"),
      typeof config === "string" ? config : JSON.stringify(config));
  }
  return dir;
}

const resolve = (opts) => tenant.resolveTenant({ argv: [], env: {}, ...opts });

test("missing file, no env, no arg -> no tenant, no warnings (behaviour unchanged)", () => {
  const r = resolve({ homedir: home() });
  assert.equal(r.tenant, null);
  assert.deepEqual(r.warnings, []);
  assert.equal(tenant.baseUrl(r.tenant, "https://aitherium.com/"), "https://aitherium.com/");
  assert.equal(tenant.decorateTitle("Desk", r.tenant), "Desk");
  assert.deepEqual(tenant.tenantTrayItems(r.tenant, () => {}), []);
});

test("valid file -> tenant origin, name, accent, icon", () => {
  const r = resolve({ homedir: home({ host: "Acme.Aitherium.com", name: "Acme Co", accent: "#12abef",
    icon_url: "https://acme.aitherium.com/icon.png" }) });
  assert.deepEqual(r.warnings, []);
  assert.equal(r.tenant.host, "acme.aitherium.com");
  assert.equal(r.tenant.origin, "https://acme.aitherium.com/");
  assert.equal(r.tenant.name, "Acme Co");
  assert.equal(r.tenant.accent, "#12abef");
  assert.equal(r.tenant.iconUrl, "https://acme.aitherium.com/icon.png");
  assert.equal(r.tenant.source, "file");
  assert.equal(tenant.baseUrl(r.tenant, "https://aitherium.com/"), "https://acme.aitherium.com/");
  assert.equal(tenant.decorateTitle("Aither Browser", r.tenant), "Aither Browser · Acme Co");
});

test("overlay URL built from the tenant base keeps ?mode=overlay on the tenant host", () => {
  const r = resolve({ homedir: home({ host: "acme.aitherium.com" }) });
  const url = new URL(tenant.baseUrl(r.tenant));
  url.searchParams.set("mode", "overlay");
  assert.equal(url.href, "https://acme.aitherium.com/?mode=overlay");
});

test("https:// form with trailing slash is accepted", () => {
  assert.deepEqual(tenant.validateHost("https://acme.aitherium.com/"), { ok: true, host: "acme.aitherium.com", firstParty: true });
});

const HOSTILE = [
  "http://acme.aitherium.com",
  "javascript:alert(1)",
  "file:///etc/passwd",
  "aitherium.com",
  "a.b.aitherium.com",
  "evil.com",
  "acme.aitherium.com.evil.com",
  "evilaitherium.com",
  "acme.aitherium.com:8443",
  "https://acme.aitherium.com:8443",
  "https://acme.aitherium.com:443/",
  "https://acme.aitherium.com/path",
  "https://acme.aitherium.com/?x=1",
  "https://user@acme.aitherium.com",
  "acme.aitherium.com@evil.com",
  "evil.com#.aitherium.com",
  "evil.com\\.aitherium.com",
  "acme.aitherium.com.",
  "-acme.aitherium.com",
  "acme .aitherium.com",
  "127.0.0.1",
  "[::1]",
  "",
  "   ",
];

for (const raw of HOSTILE) {
  test(`hostile host rejected and falls back to apex: ${JSON.stringify(raw)}`, () => {
    assert.equal(tenant.validateHost(raw).ok, false);
    const r = resolve({ homedir: home({ host: raw }) });
    assert.equal(r.tenant, null);
    if (raw.trim()) assert.equal(r.warnings.length, 1);
    assert.equal(tenant.baseUrl(r.tenant, "https://aitherium.com/"), "https://aitherium.com/");
  });
}

test("non-string host values are rejected", () => {
  for (const host of [42, ["acme.aitherium.com"], { host: "acme.aitherium.com" }, true]) {
    const r = resolve({ homedir: home({ host }) });
    assert.equal(r.tenant, null);
    assert.equal(r.warnings.length, 1);
  }
});

test("exact host in the config file's allowed_hosts is accepted; others are not", () => {
  const dir = home({ host: "workspace.acme.example", allowed_hosts: ["workspace.acme.example"] });
  const r = resolve({ homedir: dir });
  assert.equal(r.tenant.host, "workspace.acme.example");
  // allowed_hosts is exact: a sibling or a parent is still refused
  assert.equal(tenant.validateHost("other.acme.example", ["workspace.acme.example"]).ok, false);
  assert.equal(tenant.validateHost("acme.example", ["workspace.acme.example"]).ok, false);
  // an allowed_hosts entry cannot smuggle a scheme or path
  assert.equal(tenant.validateHost("evil.com", ["http://evil.com"]).ok, false);
});

test("allowed_hosts does NOT authorise an env/arg host without the file listing it", () => {
  const r = resolve({ homedir: home(), env: { AITHER_DESK_TENANT_HOST: "workspace.acme.example" } });
  assert.equal(r.tenant, null);
  assert.equal(r.warnings.length, 1);
});

test("malformed JSON -> warning, apex", () => {
  const r = resolve({ homedir: home("{ not json") });
  assert.equal(r.tenant, null);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /malformed JSON/);
});

test("JSON that is not an object -> warning, apex", () => {
  for (const body of ["[]", "null", "\"acme.aitherium.com\""]) {
    const r = resolve({ homedir: home(body) });
    assert.equal(r.tenant, null);
    assert.equal(r.warnings.length, 1);
  }
});

test("BOM-prefixed file (PowerShell Set-Content) still parses", () => {
  const r = resolve({ homedir: home(`﻿${JSON.stringify({ host: "acme.aitherium.com" })}`) });
  assert.equal(r.tenant.host, "acme.aitherium.com");
});

test("env host is used when no file; name defaults to the host", () => {
  const r = resolve({ homedir: home(), env: { AITHER_DESK_TENANT_HOST: "acme.aitherium.com" } });
  assert.equal(r.tenant.source, "env");
  assert.equal(r.tenant.name, "acme.aitherium.com");
});

test("argv beats env beats file; branding only follows the file's own host", () => {
  const dir = home({ host: "filed.aitherium.com", name: "Filed Inc", accent: "#000" });
  const r = resolve({ homedir: dir, argv: ["desk.exe", "--tenant-host=argd.aitherium.com"],
    env: { AITHER_DESK_TENANT_HOST: "envd.aitherium.com" } });
  assert.equal(r.tenant.host, "argd.aitherium.com");
  assert.equal(r.tenant.source, "argv");
  assert.equal(r.tenant.name, "argd.aitherium.com");
  assert.equal(r.tenant.accent, null);
  assert.equal(r.argHost, "argd.aitherium.com");
});

test("a hostile argv falls through to a valid file host, with a warning", () => {
  const r = resolve({ homedir: home({ host: "acme.aitherium.com" }), argv: ["--tenant-host=evil.com"] });
  assert.equal(r.tenant.host, "acme.aitherium.com");
  assert.equal(r.argHost, null);
  assert.equal(r.warnings.length, 1);
});

test("name is stripped of control / bidi characters and capped", () => {
  const r = resolve({ homedir: home({ host: "acme.aitherium.com", name: `A‮cme\n${"x".repeat(200)}` }) });
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u001f‮]/.test(r.tenant.name));
  assert.ok(r.tenant.name.length <= 64);
});

test("bad accent and off-host icon_url are dropped", () => {
  const r = resolve({ homedir: home({ host: "acme.aitherium.com", accent: "red;}", icon_url: "https://evil.com/i.png" }) });
  assert.equal(r.tenant.accent, null);
  assert.equal(r.tenant.iconUrl, null);
  const r2 = resolve({ homedir: home({ host: "acme.aitherium.com", icon_url: "http://acme.aitherium.com/i.png" }) });
  assert.equal(r2.tenant.iconUrl, null);
});

test("tray row opens the tenant origin", () => {
  const r = resolve({ homedir: home({ host: "acme.aitherium.com", name: "Acme" }) });
  const opened = [];
  const rows = tenant.tenantTrayItems(r.tenant, (url) => opened.push(url));
  assert.equal(rows.length, 1);
  assert.match(rows[0].label, /^Open workspace/);
  rows[0].click();
  assert.deepEqual(opened, ["https://acme.aitherium.com/"]);
});

test("persistFirstRunHost writes once, never overwrites, refuses hostile hosts", () => {
  const dir = home();
  assert.equal(tenant.persistFirstRunHost("evil.com", { homedir: dir }).written, false);
  assert.equal(fs.existsSync(tenant.configPath(dir)), false);
  const first = tenant.persistFirstRunHost("Acme.aitherium.com", { homedir: dir });
  assert.equal(first.written, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(tenant.configPath(dir), "utf8")), { host: "acme.aitherium.com" });
  const second = tenant.persistFirstRunHost("other.aitherium.com", { homedir: dir });
  assert.equal(second.written, false);
  assert.equal(resolve({ homedir: dir }).tenant.host, "acme.aitherium.com");
});

test("unreadable config path (a directory) -> warning, apex", () => {
  const dir = home();
  fs.mkdirSync(tenant.configPath(dir), { recursive: true });
  const r = resolve({ homedir: dir });
  assert.equal(r.tenant, null);
  assert.equal(r.warnings.length, 1);
});

test("the shipped modules route the overlay base, browser home, titles and tray through the resolver", () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
  const overlay = read("living-desktop-window.cjs");
  // overlayBaseUrl (first-party only), never baseUrl: the overlay holds the desk IPC planes
  assert.match(overlay, /(?:const|let) BASE_URL = process\.env\.LIVING_DESKTOP_URL \|\| deskTenant\.overlayBaseUrl\(TENANT,/);
  assert.doesNotMatch(overlay, /deskTenant\.baseUrl\(/);
  assert.match(overlay, /title: deskTenant\.decorateTitle\("AitherOS Aitheros Online", TENANT\)/);
  const browser = read("browser-window.cjs");
  assert.match(browser, /deskTenant\.baseUrl\(deskTenant\.currentTenant\(\), "https:\/\/aitherium\.com"\)/);
  assert.match(browser, /title: deskTenant\.decorateTitle\("Aither Browser"/);
  const main = read("main.cjs");
  assert.match(main, /deskTenant\.decorateTitle\(badgeTooltip\(/);
  assert.match(main, /deskTenant\.tenantTrayItems\(deskTenant\.currentTenant\(\)/);
  assert.match(main, /deskTenant\.persistFirstRunHost\(tenantArg\)/);
});

test("SECURITY: an allowed_hosts tenant never becomes the overlay origin (browser/tray only)", () => {
  const r = resolve({ homedir: home({ host: "workspace.acme.example", name: "Acme",
    allowed_hosts: ["workspace.acme.example"] }) });
  assert.equal(r.tenant.host, "workspace.acme.example");
  assert.equal(r.tenant.firstParty, false);
  // overlay keeps the apex; browser home + tray still go to the tenant
  assert.equal(tenant.overlayBaseUrl(r.tenant, "https://aitherium.com/"), "https://aitherium.com/");
  assert.equal(tenant.baseUrl(r.tenant, "https://aitherium.com/"), "https://workspace.acme.example/");
  // a forged firstParty flag on a non-aitherium host is still refused
  assert.equal(tenant.overlayBaseUrl({ ...r.tenant, firstParty: true }, "https://aitherium.com/"),
    "https://aitherium.com/");
});

test("a first-party tenant IS the overlay origin", () => {
  const r = resolve({ homedir: home({ host: "acme.aitherium.com" }) });
  assert.equal(r.tenant.firstParty, true);
  assert.equal(tenant.overlayBaseUrl(r.tenant, "https://aitherium.com/"), "https://acme.aitherium.com/");
  assert.equal(tenant.overlayBaseUrl(null, "https://aitherium.com/"), "https://aitherium.com/");
});

test("CRASH: a host object with a hostile toString does not throw (fail open to apex)", () => {
  for (const host of [{ toString: 1 }, { toString: 1, valueOf: 1 }, [{ toString: 1 }]]) {
    const r = resolve({ homedir: home({ host }) });
    assert.equal(r.tenant, null);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /rejected file host <(object|array)>/);
  }
  // the same through the real file reader + process-wide currentTenant()
  const dir = home('{"host":{"toString":1},"name":{"toString":1},"allowed_hosts":[{"toString":1}]}');
  const r = tenant.resolveTenant({ argv: [], env: {}, homedir: dir });
  assert.equal(r.tenant, null);
});

test("currentTenant() never throws even if the resolver does; logs and returns null", () => {
  const logged = [];
  tenant._resetForTests();
  tenant._setResolverForTests(() => { throw new TypeError("boom"); });
  try {
    assert.equal(tenant.currentTenant({ log: (m) => logged.push(m) }), null);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /resolver failed/);
    assert.equal(tenant.currentResolution().argHost, null);
  } finally {
    tenant._setResolverForTests(() => tenant.resolveTenant());
    tenant._resetForTests();
  }
});

test("allowed_hosts refuses apex lookalikes", () => {
  for (const host of ["aitherium.com.evil.io", "my-aitherium.example", "aitherium.co"]) {
    assert.equal(tenant.validateHost(host, [host]).ok, false, host);
    const r = resolve({ homedir: home({ host, allowed_hosts: [host] }) });
    assert.equal(r.tenant, null, host);
  }
});

test("argv/env cannot select an allowed_hosts entry; only the file's own host may", () => {
  const dir = home({ host: "acme.aitherium.com", allowed_hosts: ["workspace.acme.example"] });
  const viaEnv = resolve({ homedir: dir, env: { AITHER_DESK_TENANT_HOST: "workspace.acme.example" } });
  assert.equal(viaEnv.tenant.host, "acme.aitherium.com");
  assert.equal(viaEnv.warnings.length, 1);
  const viaArg = resolve({ homedir: dir, argv: ["--tenant-host=workspace.acme.example"] });
  assert.equal(viaArg.tenant.host, "acme.aitherium.com");
  assert.equal(viaArg.argHost, null);
});
