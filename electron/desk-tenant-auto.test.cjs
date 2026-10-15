"use strict";

// Desk opens the signed-in user's own workspace host with NO desk-tenant.json
// (desk-tenant-auto.cjs). Unit half: the identity -> label -> public config.js check.
// Integration half: living-desktop-window.cjs under a fake electron, a temp home with
// only an auth.json, and a fake network -- the overlay base must move to the tenant
// host and the config file must be written.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const auto = require("./desk-tenant-auto.cjs");
const deskTenant = require("./desk-tenant.cjs");
const deskSession = require("./desk-session.cjs");

const CONFIG_JS = (label, brand = { name: "Example Co", accent: "#f4b740" }) => [
  "// NEVER put secrets here -- this file is public.",
  `window.__AITHER_API_BASE__ = "https://${label}-api.aitherium.com";`,
  `window.__AITHER_TENANT__ = "${label}";`,
  `window.__AITHER_TENANT_BRAND__ = ${JSON.stringify(brand)};`,
  "",
].join("\n");

function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const hit = routes[String(url)];
    if (!hit) return { status: 404, text: async () => "", json: async () => ({}) };
    return { status: hit.status || 200, text: async () => hit.text || "", json: async () => hit.json || {} };
  };
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "desk-tenant-auto-"));
}

test("tenantIdentity keeps only the tenant fields and needs a tenant_id", () => {
  assert.deepEqual(auto.tenantIdentity({ tenant_id: "TNT_ACME", tenant_slug: "acme", workspace_slug: "w",
    username: "u", email: "e@x", roles: ["owner"] }), { tenantId: "tnt_acme", tenantSlug: "acme", workspaceSlug: "w" });
  assert.equal(auto.tenantIdentity({ username: "u" }), null);
  assert.equal(auto.tenantIdentity(null), null);
});

test("candidateLabels: canonical id first; platform and foreign slugs never asked", () => {
  assert.deepEqual(auto.candidateLabels({ tenantId: "tnt_example_co", tenantSlug: "example-co" }), ["example-co"]);
  // A slug whose canonical id is NOT the user's tenant is never a candidate.
  assert.deepEqual(auto.candidateLabels({ tenantId: "tnt_acme", tenantSlug: "docs", workspaceSlug: "api" }), ["acme"]);
  assert.deepEqual(auto.candidateLabels({ tenantId: "platform", tenantSlug: "aitherium" }), []);
  assert.deepEqual(auto.candidateLabels({ tenantId: "tnt_" }), []);
  assert.deepEqual(auto.candidateLabels(null), []);
});

test("declaredTenant / declaredBrand read the public config.js", () => {
  assert.equal(auto.declaredTenant(CONFIG_JS("acme")), "acme");
  assert.equal(auto.declaredTenant("window.__AITHER_API_BASE__ = 'x'"), null);
  assert.deepEqual(auto.declaredBrand(CONFIG_JS("acme")), { name: "Example Co", accent: "#f4b740" });
  assert.deepEqual(auto.declaredBrand("window.__AITHER_TENANT_BRAND__ = {broken"), {});
});

test("discoverTenantHost adopts only a host that declares the user's tenant", async () => {
  const calls = [];
  const fetchImpl = fakeFetch({ "https://acme.aitherium.com/config.js": { text: CONFIG_JS("acme") } }, calls);
  const found = await auto.discoverTenantHost({ tenantId: "tnt_acme" }, { fetchImpl });
  assert.equal(found.host, "acme.aitherium.com");
  assert.equal(found.name, "Example Co");
  // Public file, no credentials, no redirect following.
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.redirect, "manual");

  const other = fakeFetch({ "https://acme.aitherium.com/config.js": { text: CONFIG_JS("someone-else") } });
  assert.equal(await auto.discoverTenantHost({ tenantId: "tnt_acme" }, { fetchImpl: other }), null);
  const redirect = fakeFetch({ "https://acme.aitherium.com/config.js": { status: 302, text: CONFIG_JS("acme") } });
  assert.equal(await auto.discoverTenantHost({ tenantId: "tnt_acme" }, { fetchImpl: redirect }), null);
});

test("autoResolveTenant writes desk-tenant.json once and never over a configured tenant", async () => {
  const homedir = tempHome();
  const fetchImpl = fakeFetch({ "https://acme.aitherium.com/config.js": { text: CONFIG_JS("acme") } });
  const fromDisk = () => deskTenant.resolveTenant({ argv: [], env: {}, homedir });
  const r = await auto.autoResolveTenant({ tenantId: "tnt_acme" }, { current: fromDisk, homedir, fetchImpl });
  assert.equal(r.adopted, true);
  const written = JSON.parse(fs.readFileSync(deskTenant.configPath(homedir), "utf8"));
  assert.deepEqual(written, { host: "acme.aitherium.com", source: "sign-in", tenant_id: "tnt_acme",
    name: "Example Co", accent: "#f4b740" });
  // The file now resolves exactly like a hand-written one (and says it was auto-written).
  const resolved = fromDisk();
  assert.equal(resolved.tenant.origin, "https://acme.aitherium.com/");
  assert.equal(resolved.tenant.auto, true);
  assert.equal(resolved.tenant.tenantId, "tnt_acme");
  assert.equal(deskTenant.overlayBaseUrl(resolved.tenant), "https://acme.aitherium.com/");

  const again = await auto.autoResolveTenant({ tenantId: "tnt_acme" }, { current: fromDisk, homedir, fetchImpl });
  assert.deepEqual(again, { adopted: false, reason: "already this account's workspace" });
  const configured = await auto.autoResolveTenant({ tenantId: "tnt_acme" },
    { current: () => ({ tenant: { host: "x.aitherium.com", auto: false } }), homedir: tempHome(), fetchImpl });
  assert.equal(configured.adopted, false);
  const platform = await auto.autoResolveTenant({ tenantId: "platform" },
    { current: () => ({ tenant: null }), homedir: tempHome(), fetchImpl });
  assert.equal(platform.adopted, false);
});

test("another account signing in replaces a sign-in-written workspace; a platform account clears it", async () => {
  const homedir = tempHome();
  const fetchImpl = fakeFetch({
    "https://acme.aitherium.com/config.js": { text: CONFIG_JS("acme") },
    "https://beta-co.aitherium.com/config.js": { text: CONFIG_JS("beta-co", { name: "Beta" }) },
  });
  const opts = { current: () => deskTenant.resolveTenant({ argv: [], env: {}, homedir }), homedir, fetchImpl };
  assert.equal((await auto.autoResolveTenant({ tenantId: "tnt_acme" }, opts)).adopted, true);
  // A different account on the same PC: its own workspace, not the last one's.
  const swapped = await auto.autoResolveTenant({ tenantId: "tnt_beta_co" }, opts);
  assert.equal(swapped.adopted, true);
  assert.equal(swapped.replaced, true);
  assert.equal(opts.current().tenant.host, "beta-co.aitherium.com");
  assert.equal(opts.current().tenant.name, "Beta");
  // A platform account (no workspace host): back to the apex, no file left to delete.
  const cleared = await auto.autoResolveTenant({ tenantId: "platform" }, opts);
  assert.equal(cleared.cleared, true);
  assert.equal(fs.existsSync(deskTenant.configPath(homedir)), false);
  assert.equal(opts.current().tenant, null);
});

test("a hand-written desk-tenant.json is never replaced, cleared or forgotten", async () => {
  const homedir = tempHome();
  fs.mkdirSync(path.join(homedir, ".aither"), { recursive: true });
  const file = deskTenant.configPath(homedir);
  const original = JSON.stringify({ host: "acme.aitherium.com", name: "Acme" });
  fs.writeFileSync(file, original);
  const fetchImpl = fakeFetch({ "https://beta-co.aitherium.com/config.js": { text: CONFIG_JS("beta-co") } });
  const opts = { current: () => deskTenant.resolveTenant({ argv: [], env: {}, homedir }), homedir, fetchImpl };
  assert.equal(opts.current().tenant.auto, false);
  assert.deepEqual(await auto.autoResolveTenant({ tenantId: "tnt_beta_co" }, opts),
    { adopted: false, reason: "tenant already configured" });
  assert.equal(deskTenant.persistAutoTenant({ host: "beta-co.aitherium.com" }, { homedir }).written, false);
  assert.equal(deskTenant.forgetAutoTenant({ homedir }).removed, false);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("adopter: the Online tab's bearer alone finds the workspace; one notice; sign-out forgets it", async (t) => {
  const homedir = tempHome();
  auto._resetForTests();
  t.after(() => auto._resetForTests());
  const fetchImpl = fakeFetch({ "https://acme.aitherium.com/config.js": { text: CONFIG_JS("acme") } });
  const current = () => deskTenant.resolveTenant({ argv: [], env: {}, homedir });
  const notices = [];
  auto.onWorkspaceChange((r) => notices.push(r));
  const checked = [];
  const check = async (token) => {
    checked.push(token);
    return { state: "valid", username: "jdoe", identity: { tenantId: "tnt_acme", tenantSlug: "acme", workspaceSlug: "" } };
  };
  assert.equal((await auto.adoptFromToken("", { check, current, homedir, fetchImpl })).adopted, false);
  assert.equal(checked.length, 0, "no bearer, no Identity call");
  const r = await auto.adoptFromToken("online-tab-bearer", { check, current, homedir, fetchImpl });
  assert.equal(r.adopted, true);
  assert.deepEqual(checked, ["online-tab-bearer"]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].host, "acme.aitherium.com");
  // The same account again (the Living Desktop's sync, a re-sign-in): nothing new.
  await auto.adoptIdentity({ tenantId: "tnt_acme" }, { current, homedir, fetchImpl });
  assert.equal(notices.length, 1);
  // An explicit Sign out takes the sign-in-written workspace with it.
  assert.equal(auto.signedOut({ homedir }).removed, true);
  assert.equal(notices.length, 2);
  assert.equal(notices[1].cleared, true);
  assert.equal(current().tenant, null);
  // A rejected bearer adopts nothing.
  const dead = await auto.adoptFromToken("dead", { check: async () => ({ state: "invalid", username: "" }), current, homedir, fetchImpl });
  assert.equal(dead.adopted, false);
});

test("persistAutoTenant refuses a non-aitherium host", () => {
  const homedir = tempHome();
  assert.equal(deskTenant.persistAutoTenant({ host: "evil.example.com" }, { homedir }).written, false);
  assert.equal(fs.existsSync(deskTenant.configPath(homedir)), false);
});

test("checkToken / resolveSession carry the tenant identity (and nothing secret)", async () => {
  const fetchImpl = fakeFetch({ "https://idp.aitherium.com/identity/auth/me": {
    json: { username: "jdoe", tenant_id: "tnt_acme", tenant_slug: "acme", email: "j@x", roles: ["owner"] } } });
  const v = await deskSession.checkToken("tok", { fetchImpl });
  assert.equal(v.state, "valid");
  assert.deepEqual(v.identity, { tenantId: "tnt_acme", tenantSlug: "acme", workspaceSlug: "" });
  const verdict = await deskSession.resolveSession({ cookieToken: "tok", check: async () => v });
  assert.deepEqual(verdict.identity, v.identity);
});

/** living-desktop-window.cjs with an inert electron (as living-desktop-focus.test.cjs). */
function loadWindowModule() {
  const fake = {
    BrowserWindow: function BrowserWindow() {},
    ipcMain: { on() {}, handle() {} },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getPrimaryDisplay: () => ({ workArea: {} }) },
    session: { fromPartition: () => ({ cookies: { get: async () => [], set: async () => {}, remove: async () => {} } }) },
    shell: { openExternal: async () => {} },
  };
  const original = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === "electron") return fake;
    return original.call(this, request, ...rest);
  };
  try {
    const file = require.resolve("./living-desktop-window.cjs");
    delete require.cache[file];
    return require(file);
  } finally {
    Module._load = original;
  }
}

test("Desk: a signed-in tenant user with no desk-tenant.json lands on the workspace host", async (t) => {
  const homedir = tempHome();
  fs.mkdirSync(path.join(homedir, ".aither"), { recursive: true });
  fs.writeFileSync(path.join(homedir, ".aither", "auth.json"), JSON.stringify({
    active_profile: "portal",
    profiles: { portal: { access_token: "tok-not-a-secret", endpoint: "https://aitherium.com",
      user: { username: "jdoe" } } },
  }));
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME,
    LIVING_DESKTOP_URL: process.env.LIVING_DESKTOP_URL, AITHER_DESK_TENANT_HOST: process.env.AITHER_DESK_TENANT_HOST };
  const savedFetch = globalThis.fetch;
  process.env.USERPROFILE = homedir;
  process.env.HOME = homedir;
  delete process.env.LIVING_DESKTOP_URL;
  delete process.env.AITHER_DESK_TENANT_HOST;
  globalThis.fetch = fakeFetch({
    "https://idp.aitherium.com/identity/auth/me": { json: { username: "jdoe", tenant_id: "tnt_acme" } },
    "https://acme.aitherium.com/config.js": { text: CONFIG_JS("acme") },
  });
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    globalThis.fetch = savedFetch;
    deskTenant._resetForTests();
  });
  deskTenant._resetForTests();
  const win = loadWindowModule();
  assert.equal(new URL(win.desktopStatus().url).hostname, "aitherium.com", "no config: the apex");
  const acct = await win.refreshAccount();
  assert.equal(acct.signedIn, true);
  assert.equal(new URL(win.desktopStatus().url).hostname, "acme.aitherium.com");
  assert.equal(new URL(win.desktopAppUrl()).hostname, "acme.aitherium.com");
  assert.equal(JSON.parse(fs.readFileSync(deskTenant.configPath(homedir), "utf8")).host, "acme.aitherium.com");
});

test("Desk: NO auth.json, signed in only on the Online tab -> the windows still move to the workspace", async (t) => {
  const homedir = tempHome(); // nothing in it: no auth.json, no desk-tenant.json
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME,
    LIVING_DESKTOP_URL: process.env.LIVING_DESKTOP_URL, AITHER_DESK_TENANT_HOST: process.env.AITHER_DESK_TENANT_HOST };
  const savedFetch = globalThis.fetch;
  process.env.USERPROFILE = homedir;
  process.env.HOME = homedir;
  delete process.env.LIVING_DESKTOP_URL;
  delete process.env.AITHER_DESK_TENANT_HOST;
  globalThis.fetch = fakeFetch({
    "https://idp.aitherium.com/identity/auth/me": { json: { username: "jdoe", tenant_id: "tnt_acme" } },
    "https://acme.aitherium.com/config.js": { text: CONFIG_JS("acme") },
  });
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    globalThis.fetch = savedFetch;
    deskTenant._resetForTests();
    auto._resetForTests();
  });
  deskTenant._resetForTests();
  auto._resetForTests();
  const win = loadWindowModule();
  // The Living Desktop's own doors (partition cookie, auth.json) know nobody.
  const acct = await win.refreshAccount();
  assert.equal(acct.signedIn, false);
  assert.equal(new URL(win.desktopStatus().url).hostname, "aitherium.com");
  // main's watchOnlineAuth: the Online tab's bearer (browserWindow.onlineToken()).
  const r = await auto.adoptFromToken("online-tab-bearer");
  assert.equal(r.adopted, true);
  assert.equal(new URL(win.desktopStatus().url).hostname, "acme.aitherium.com");
  assert.equal(new URL(win.desktopAppUrl()).hostname, "acme.aitherium.com");
  // ...and the Aither Browser's pinned Online tab, its taskbar and app launches follow.
  const internal = require("./browser-internal.cjs");
  assert.equal(internal.onlineUrl({}), "https://acme.aitherium.com/");
  // Sign out from the Desk: the sign-in-written workspace goes with the account.
  await win.signOut();
  assert.equal(fs.existsSync(deskTenant.configPath(homedir)), false);
  assert.equal(new URL(win.desktopStatus().url).hostname, "aitherium.com");
  assert.equal(internal.onlineUrl({}), "https://app.aitherium.com/");
});

test("Online tab URL: a first-party tenant only (the tab carries the desk-host preload)", () => {
  const internal = require("./browser-internal.cjs");
  const firstParty = { host: "acme.aitherium.com", origin: "https://acme.aitherium.com/", firstParty: true };
  assert.equal(internal.onlineUrl({}, firstParty), "https://acme.aitherium.com/");
  assert.equal(internal.onlineUrl({}, null), "https://app.aitherium.com/");
  const foreign = { host: "workspace.acme.example", origin: "https://workspace.acme.example/", firstParty: false };
  assert.equal(internal.onlineUrl({}, foreign), "https://app.aitherium.com/");
  // DESK_ONLINE_URL (developer override) still wins.
  assert.equal(internal.onlineUrl({ DESK_ONLINE_URL: "https://app.aitherium.com/?x=1" }, firstParty),
    "https://app.aitherium.com/?x=1");
});

test("main wires both sign-in doors and every surface to the one adopter", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const browser = fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");
  // The Online tab's own sign-in looks the workspace up from that session's bearer.
  assert.match(main, /watchOnlineAuth\(\(signedIn\) => \{[\s\S]{0,400}if \(signedIn\) void adoptWorkspaceFromOnline\(\)/);
  assert.match(main, /deskTenantAuto\.adoptFromToken\(await browserWindow\.onlineToken\(\)\)/);
  // One change notice moves the browser's Online tab + taskbar, the tray and its tooltip.
  assert.match(main, /deskTenantAuto\.onWorkspaceChange\(\(result\) => \{[\s\S]{0,300}browserWindow\.followTenant\(\)/);
  assert.match(browser, /function followTenant\(\)/);
  assert.match(browser, /followTenant,/);
});
