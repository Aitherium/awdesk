"use strict";

// Which account, which workspace (customer report 2026-11-19): the account indicator, the tenant's
// own brand + logo, the "which workspace?" prompt, and the membership rules behind them
// (desk-account.cjs + desk-tenant-auto.cjs). Every edge is faked: no network, a temp home.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const account = require("./desk-account.cjs");
const auto = require("./desk-tenant-auto.cjs");
const deskTenant = require("./desk-tenant.cjs");

const SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'><rect width='1' height='1'/></svg>";
const CONFIG_JS = (label, brand) => [
  "// NEVER put secrets here -- this file is public.",
  `window.__AITHER_TENANT__ = "${label}";`,
  `window.__AITHER_TENANT_BRAND__ = ${JSON.stringify(brand)};`,
  "",
].join("\n");

/** routes: url -> {status?, text?, body?, type?, json?} */
function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const hit = routes[String(url)];
    if (!hit) return { status: 404, headers: { get: () => "" }, text: async () => "", json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    const body = Buffer.from(hit.body != null ? hit.body : hit.text || "");
    return {
      status: hit.status || 200,
      headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? hit.type || "" : "") },
      text: async () => hit.text || "",
      json: async () => hit.json || {},
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    };
  };
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "desk-account-"));
}

// ── The indicator ────────────────────────────────────────────────────────────────

test("indicator: the apex is 'Aitherium', a tenant is named by its OWN brand, the account by email", () => {
  const signedIn = { signedIn: true, username: "jdoe", email: "j@example.test", memberships: ["tnt_acme"] };
  const apex = account.indicator({ account: signedIn, tenant: null });
  assert.equal(apex.workspace.name, "Aitherium");
  assert.equal(apex.workspace.apex, true);
  assert.equal(apex.line, "Aitherium — j@example.test");
  assert.equal(apex.member, null, "the apex is not a membership question");

  const tenant = { host: "acme.aitherium.com", name: "acme.aitherium.com", tenantId: "tnt_acme" };
  const branded = account.indicator({ account: signedIn, tenant,
    brand: { name: "ACME", accent: "#123456", logo: "data:image/svg+xml;base64,AAAA" } });
  assert.equal(branded.workspace.name, "ACME", "the brand's name beats the stored host name");
  assert.equal(branded.workspace.logo, "data:image/svg+xml;base64,AAAA");
  assert.equal(branded.workspace.accent, "#123456");
  assert.equal(branded.member, true);
  assert.equal(branded.line, "ACME — j@example.test");
  assert.match(branded.tooltip, /Workspace: ACME \(acme\.aitherium\.com\)/);
  assert.match(branded.tooltip, /Account: j@example\.test/);

  // No brand loaded yet: the stored tenant name, else the host.
  assert.equal(account.indicator({ account: signedIn, tenant: { host: "acme.aitherium.com", name: "Acme Co" } }).workspace.name, "Acme Co");
  assert.equal(account.indicator({ account: signedIn, tenant: { host: "acme.aitherium.com" } }).workspace.name, "acme.aitherium.com");
});

test("indicator: a workspace the account is NOT a member of says so; signed out says so", () => {
  const other = { signedIn: true, username: "x", email: "x@example.test", memberships: ["tnt_other"] };
  const v = account.indicator({ account: other, tenant: { host: "acme.aitherium.com", tenantId: "tnt_acme" } });
  assert.equal(v.member, false);
  assert.match(v.line, /not a member/);
  assert.match(v.tooltip, /Switch account/);
  const out = account.indicator({ account: { signedIn: false }, tenant: null });
  assert.equal(out.signedIn, false);
  assert.equal(out.line, "Aitherium — not signed in");
});

test("indicator: a non-data logo or a bad accent is never passed on", () => {
  const v = account.indicator({ account: { signedIn: true, email: "a@b.c" }, tenant: { host: "acme.aitherium.com" },
    brand: { name: "ACME", logo: "https://evil.example/x.svg", accent: "red;}" } });
  assert.equal(v.workspace.logo, undefined);
  assert.equal(v.workspace.accent, undefined);
});

// ── The tenant's own brand + logo ────────────────────────────────────────────────

test("loadWorkspaceBrand: name/accent from config.js, the favicon from the SAME host as data:", async () => {
  const calls = [];
  const fetchImpl = fakeFetch({
    "https://acme.aitherium.com/config.js": { text: CONFIG_JS("acme", { name: "ACME", accent: "#f4b740",
      favicon: "/assets/favicon.svg", logo_url: "/assets/acme-logo.svg" }) },
    "https://acme.aitherium.com/assets/favicon.svg": { body: SVG, type: "image/svg+xml" },
  }, calls);
  const brand = await account.loadWorkspaceBrand("acme.aitherium.com", { fetchImpl });
  assert.equal(brand.name, "ACME");
  assert.equal(brand.accent, "#f4b740");
  assert.equal(brand.logo, `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`);
  for (const c of calls) {
    assert.equal(c.init.credentials, "omit", "nothing of the user's rides along");
    assert.equal(c.init.redirect, "manual");
    assert.ok(c.url.startsWith("https://acme.aitherium.com/"), c.url);
  }
});

test("loadWorkspaceBrand: falls back to logo_url; refuses a wrong type, an oversize file, a foreign path", async () => {
  const base = { name: "ACME", favicon: "/assets/favicon.ico", logo_url: "/assets/acme-logo.png" };
  const fetchImpl = fakeFetch({
    "https://acme.aitherium.com/config.js": { text: CONFIG_JS("acme", base) },
    "https://acme.aitherium.com/assets/favicon.ico": { body: "x", type: "image/x-icon" },
    "https://acme.aitherium.com/assets/acme-logo.png": { body: "png", type: "image/png" },
  });
  assert.match((await account.loadWorkspaceBrand("acme.aitherium.com", { fetchImpl })).logo, /^data:image\/png;base64,/);

  const big = fakeFetch({
    "https://acme.aitherium.com/config.js": { text: CONFIG_JS("acme", { name: "ACME", favicon: "/f.svg" }) },
    "https://acme.aitherium.com/f.svg": { body: "x".repeat(account.MAX_LOGO_BYTES + 1), type: "image/svg+xml" },
  });
  assert.equal((await account.loadWorkspaceBrand("acme.aitherium.com", { fetchImpl: big })).logo, undefined);

  // A logo that points off the host (or climbs out of it) is never fetched.
  const calls = [];
  const foreign = fakeFetch({
    "https://acme.aitherium.com/config.js": { text: CONFIG_JS("acme",
      { name: "ACME", favicon: "https://evil.example/x.svg", logo_url: "/../../x.svg" }) },
  }, calls);
  const b = await account.loadWorkspaceBrand("acme.aitherium.com", { fetchImpl: foreign });
  assert.equal(b.logo, undefined);
  assert.deepEqual(calls.map((c) => c.url), ["https://acme.aitherium.com/config.js"]);
});

test("loadWorkspaceBrand: only a first-party host that declares a tenant", async () => {
  const calls = [];
  const fetchImpl = fakeFetch({ "https://docs.aitherium.com/config.js": { text: "window.x = 1;" } }, calls);
  assert.equal(await account.loadWorkspaceBrand("docs.aitherium.com", { fetchImpl }), null, "declares no tenant");
  assert.equal(await account.loadWorkspaceBrand("aitherium.com", { fetchImpl }), null, "the apex has no tenant brand");
  assert.equal(await account.loadWorkspaceBrand("example.com", { fetchImpl }), null, "not first-party");
  assert.equal(await account.loadWorkspaceBrand("a.b.aitherium.com", { fetchImpl }), null);
  assert.deepEqual(calls.map((c) => c.url), ["https://docs.aitherium.com/config.js"]);
});

// ── The "which workspace?" prompt ────────────────────────────────────────────────

test("choiceDialog: one button per workspace + Cancel; a click maps back to an id FROM THE LIST", () => {
  const rows = [
    { tenantId: "tnt_acme", host: "acme.aitherium.com", name: "ACME" },
    { tenantId: "tnt_beta", host: "beta.aitherium.com", name: "" },
  ];
  const d = account.choiceDialog(rows, { currentHost: "beta.aitherium.com", who: "j@example.test" });
  assert.deepEqual(d.buttons, ["ACME", "beta.aitherium.com (open now)", "Cancel"]);
  assert.equal(d.cancelId, 2);
  assert.match(d.message, /j@example\.test belongs to 2 workspaces/);
  assert.equal(d.pick(0), "tnt_acme");
  assert.equal(d.pick(1), "tnt_beta");
  assert.equal(d.pick(2), null, "Cancel");
  assert.equal(d.pick(-1), null);
  assert.equal(d.pick("0"), null);
});

// ── Membership comes from Identity /auth/me, and only from there ─────────────────

test("tenantIdentity: memberships from allowed_tenants; '*' and platform never become workspaces", () => {
  const id = auto.tenantIdentity({ tenant_id: "tnt_acme", tenant_slug: "acme",
    allowed_tenants: ["tnt_acme", "acme", "beta-co", "*", "platform", "Bad Slug!", 42] });
  assert.deepEqual(id.memberships, ["tnt_acme", "tnt_beta_co"]);
  // A cross-tenant role's "*" on a CUSTOMER account names nothing (D-2716: a customer
  // workspace admin may hold `admin`, and Identity answers ["*"] for it).
  const admin = auto.tenantIdentity({ tenant_id: "tnt_acme", allowed_tenants: ["*"] });
  assert.deepEqual(admin.memberships, ["tnt_acme"]);
  const platform = auto.tenantIdentity({ tenant_id: "platform", allowed_tenants: ["*"] });
  assert.deepEqual(platform.memberships, []);
  assert.equal(auto.isMemberOf(id, "tnt_beta_co"), true);
  assert.equal(auto.isMemberOf(id, "beta-co"), true);
  assert.equal(auto.isMemberOf(id, "tnt_other"), false);
  assert.equal(auto.isMemberOf(admin, "tnt_other"), false);
});

function twoWorkspaceNet(calls) {
  return fakeFetch({
    "https://acme.aitherium.com/config.js": { text: CONFIG_JS("acme", { name: "ACME" }) },
    "https://beta-co.aitherium.com/config.js": { text: CONFIG_JS("beta-co", { name: "BETA" }) },
    "https://other.aitherium.com/config.js": { text: CONFIG_JS("other", { name: "OTHER" }) },
  }, calls);
}
const MEMBER = { tenantId: "tnt_acme", tenantSlug: "acme", workspaceSlug: "", memberships: ["tnt_acme", "tnt_beta_co"] };

test("sign-in with ONE workspace: opened directly, no prompt", async () => {
  const homedir = tempHome();
  let asked = 0;
  const r = await auto.autoResolveTenant({ tenantId: "tnt_acme", memberships: ["tnt_acme"] }, {
    current: () => deskTenant.resolveTenant({ argv: [], env: {}, homedir }), homedir,
    fetchImpl: twoWorkspaceNet([]), choose: async () => { asked += 1; return null; },
  });
  assert.equal(r.adopted, true);
  assert.equal(r.host, "acme.aitherium.com");
  assert.equal(asked, 0);
});

test("sign-in with SEVERAL workspaces: asked once; the pick is pinned; a later sign-in does not ask", async () => {
  const homedir = tempHome();
  const current = () => deskTenant.resolveTenant({ argv: [], env: {}, homedir });
  const offered = [];
  const r = await auto.autoResolveTenant(MEMBER, { current, homedir, fetchImpl: twoWorkspaceNet([]),
    choose: async (list) => { offered.push(list.map((w) => w.tenantId)); return "tnt_beta_co"; } });
  assert.equal(r.adopted, true);
  assert.equal(r.host, "beta-co.aitherium.com");
  assert.equal(r.chosen, true);
  assert.deepEqual(offered, [["tnt_acme", "tnt_beta_co"]], "only the account's own workspaces are offered");
  const written = JSON.parse(fs.readFileSync(deskTenant.configPath(homedir), "utf8"));
  assert.equal(written.tenant_id, "tnt_beta_co");
  assert.equal(written.source, "sign-in");

  // Same account again (a restart): a member workspace is already pinned -- no second prompt.
  const again = await auto.autoResolveTenant(MEMBER, { current, homedir, fetchImpl: twoWorkspaceNet([]),
    choose: async () => { throw new Error("must not ask again"); } });
  assert.deepEqual(again, { adopted: false, reason: "already this account's workspace" });
});

test("the chooser can pick, never add: a foreign id or a cancel lands on the HOME workspace", async () => {
  for (const answer of ["tnt_other", null, undefined]) {
    const homedir = tempHome();
    const r = await auto.autoResolveTenant(MEMBER, {
      current: () => deskTenant.resolveTenant({ argv: [], env: {}, homedir }), homedir,
      fetchImpl: twoWorkspaceNet([]), choose: async () => answer,
    });
    assert.equal(r.host, "acme.aitherium.com", `answer ${answer}`);
    assert.equal(r.chosen, false);
  }
});

test("a non-platform account never even probes a tenant it is not a member of", async () => {
  const calls = [];
  const homedir = tempHome();
  await auto.autoResolveTenant({ tenantId: "tnt_acme", memberships: ["tnt_acme"] }, {
    current: () => deskTenant.resolveTenant({ argv: [], env: {}, homedir }), homedir, fetchImpl: twoWorkspaceNet(calls),
  });
  assert.deepEqual(calls.map((c) => c.url), ["https://acme.aitherium.com/config.js"]);
});

test("openMemberWorkspace: Identity re-asked; a non-member tenant is refused; a member one is pinned", async () => {
  const homedir = tempHome();
  const check = async (t) => (t === "tok"
    ? { state: "valid", identity: MEMBER }
    : { state: "invalid" });
  const calls = [];
  const refused = await auto.openMemberWorkspace("tok", "tnt_other", { check, homedir, fetchImpl: twoWorkspaceNet(calls) });
  assert.equal(refused.opened, false);
  assert.match(refused.refused, /not a member/);
  assert.equal(calls.length, 0, "no host is probed for a workspace the account cannot open");
  assert.equal(fs.existsSync(deskTenant.configPath(homedir)), false);

  const noSession = await auto.openMemberWorkspace("stolen", "tnt_beta_co", { check, homedir, fetchImpl: twoWorkspaceNet([]) });
  assert.equal(noSession.opened, false);
  assert.equal(await auto.openMemberWorkspace("", "tnt_beta_co", { check, homedir }).then((r) => r.opened), false);

  auto._resetForTests();
  const seen = [];
  auto.onWorkspaceChange((r) => seen.push(r));
  const ok = await auto.openMemberWorkspace("tok", "beta-co", { check, homedir, fetchImpl: twoWorkspaceNet([]) });
  assert.equal(ok.opened, true);
  assert.equal(ok.host, "beta-co.aitherium.com");
  assert.equal(seen.length, 1, "every window is told");
  auto._resetForTests();
});

test("listMemberWorkspaces: only hosts that declare the tenant; platform lists nothing", async () => {
  const list = await auto.listMemberWorkspaces({ tenantId: "tnt_acme", memberships: ["tnt_acme", "tnt_gone"] },
    { fetchImpl: twoWorkspaceNet([]) });
  assert.deepEqual(list.map((w) => [w.tenantId, w.host, w.name]), [["tnt_acme", "acme.aitherium.com", "ACME"]]);
  assert.deepEqual(await auto.listMemberWorkspaces({ tenantId: "platform", memberships: [] },
    { fetchImpl: twoWorkspaceNet([]) }), []);
});
