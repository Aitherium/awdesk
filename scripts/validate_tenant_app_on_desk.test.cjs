"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const v = require("./validate_tenant_app_on_desk.cjs");

const answer = (verdict) => ({ http: 200, json: { ok: true, id: "workspace.switch", verdict } });

test("a switch passes only when the answer says where the desk is, and it is the place asked for", () => {
  const ok = answer({ ok: true, changed: true, host: "garg.aitherium.com", line: "You are in GARG (garg.aitherium.com) as the platform owner." });
  assert.equal(v.judgeSwitch(ok, "garg.aitherium.com").verdict, "pass");
  assert.equal(v.judgeSwitch(ok, "dgg.aitherium.com").verdict, "fail", "the wrong workspace");
  assert.equal(v.judgeSwitch(answer({ ok: true, line: "Done." })).verdict, "fail", "an answer that does not say where");
  assert.equal(v.judgeSwitch(answer({ ok: false, line: "You are in Aitherium (aitherium.com).", error: "No workspace named x" })).verdict, "fail");
  assert.equal(v.judgeSwitch({ http: 200, json: null }).verdict, "fail", "no verdict at all");
});

test("an unknown workspace must be refused and still say where the desk is", () => {
  const refused = answer({ ok: false, line: "You are in Aitherium (aitherium.com) as the platform owner.", error: "No workspace named \"x\" -- choose one of: Aitherium, GARG" });
  assert.equal(v.judgeRefusal(refused).verdict, "pass");
  assert.equal(v.judgeRefusal(answer({ ok: true, changed: true, line: "You are in X (x)." })).verdict, "fail", "accepted");
  assert.equal(v.judgeRefusal(answer({ ok: false, error: "no" })).verdict, "fail", "refused without saying where");
});

test("the fairy's counts fail when an identity is broken or the desk cannot answer", () => {
  const good = { http: 200, json: { verdict: { ok: true, line: "34 need you · all workspaces.", counts: { needYou: 34 }, problems: [] } } };
  assert.equal(v.judgeCounts(good).verdict, "pass");
  const bad = { http: 200, json: { verdict: { ok: false, counts: { needYou: 34 }, problems: ["badge 1 is not needYou 34"] } } };
  assert.match(v.judgeCounts(bad).why, /badge 1 is not needYou 34/);
  assert.equal(v.judgeCounts({ http: 404, json: { ok: false } }).verdict, "fail", "an older desk has no fairy.counts");
});

test("a run is ok only when nothing failed; 'look' steps are counted, never passed silently", () => {
  const s = v.summarize([{ verdict: "pass" }, { verdict: "look" }, { verdict: "look" }]);
  assert.deepEqual(s, { pass: 1, fail: 0, look: 2, ok: true });
  assert.equal(v.summarize([{ verdict: "pass" }, { verdict: "fail" }]).ok, false);
});

test("arguments: tenant and out are read; the bridge port comes from the desk's own file", () => {
  const a = v.parseArgs(["--tenant", "garg", "--out", "C:\\x", "--container", "aitheros-vibe-api", "--keep-open"]);
  assert.equal(a.tenant, "garg");
  assert.equal(a.home, "aitherium");
  assert.equal(a.container, "aitheros-vibe-api");
  assert.equal(a.keepOpen, true);
  assert.equal(v.bridgePort({ DESK_BRIDGE_PORT: "49031" }), 49031);
});

test("the in-container helpers exist, write nothing to a tenant, and print counts only", () => {
  const dir = path.join(__dirname, "tenant-validate");
  const flow = fs.readFileSync(path.join(dir, "certtrack_scratch_flow.py"), "utf8");
  assert.match(flow, /GARGBOT_DB_PATH/, "the drop flow runs on a scratch database");
  assert.match(flow, /dr\.file_support_ticket = fake_ticket/, "no ticket leaves the process");
  assert.match(flow, /r'''__DATA__'''/, "synthetic data is injected, never read from a tenant");
  const ro = fs.readFileSync(path.join(dir, "certtrack_readonly_counts.py"), "utf8");
  assert.ok(!/\.(add|delete|commit)\(/.test(ro), "the live-tenant helper must not write");
  assert.match(ro, /rollback\(\)/);
  assert.ok(fs.existsSync(path.join(dir, "winshot.ps1")));
});
