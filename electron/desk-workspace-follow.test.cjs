"use strict";

// The desk remembers the workspace the owner picks inside the Aitherium account menu
// (desk-workspace-follow.cjs): classification of a top-level navigation, the reload rule,
// and that the owner-only paths are the only things it ever calls.

const test = require("node:test");
const assert = require("node:assert/strict");
const follow = require("./desk-workspace-follow.cjs");

const none = null;
const ownerOnGarg = { host: "garg.aitherium.com", ownerSwitch: true };
const customer = { host: "garg.aitherium.com", ownerSwitch: false };

test("a customer workspace host is an open of its canonical tenant id", () => {
  const v = follow.classifyNavigation("https://garg.aitherium.com/workspace/dashboard", none);
  assert.deepEqual(v, { action: "open", label: "garg", host: "garg.aitherium.com", tenantId: "tnt_garg" });
  assert.equal(follow.classifyNavigation("https://my-co.aitherium.com/", none).tenantId, "tnt_my_co");
});

test("the apex or the app host is a Back only while the owner has a workspace open", () => {
  assert.equal(follow.classifyNavigation("https://app.aitherium.com/workspace/dashboard", ownerOnGarg).action, "back");
  assert.equal(follow.classifyNavigation("https://aitherium.com/", ownerOnGarg).action, "back");
  assert.equal(follow.classifyNavigation("https://app.aitherium.com/", none).action, "noop");
  assert.equal(follow.classifyNavigation("https://app.aitherium.com/", customer).action, "noop");
});

test("the host the desk is already on, platform labels, API hosts, http and foreign hosts do nothing", () => {
  assert.equal(follow.classifyNavigation("https://garg.aitherium.com/x", ownerOnGarg).action, "noop");
  assert.equal(follow.classifyNavigation("https://garg-api.aitherium.com/api/auth/login", none).action, "noop");
  assert.equal(follow.classifyNavigation("https://idp.aitherium.com/auth", none).action, "noop");
  assert.equal(follow.classifyNavigation("http://garg.aitherium.com/", none).action, "noop");
  assert.equal(follow.classifyNavigation("https://garg.aitherium.com.evil.io/", none).action, "noop");
  assert.equal(follow.classifyNavigation("https://evil.io/", none).action, "noop");
  assert.equal(follow.classifyNavigation("not a url", none).action, "noop");
  assert.equal(follow.classifyNavigation("https://a.b.aitherium.com/", none).action, "noop");
});

test("followNavigation calls open with the tenant id, and back only with a workspace open", async () => {
  const opened = [];
  let backed = 0;
  const hooks = (tenant) => ({
    currentTenant: () => tenant,
    open: async (id) => { opened.push(id); return { opened: true }; },
    back: async () => { backed += 1; return { removed: true }; },
  });
  const a = await follow.followNavigation("https://garg.aitherium.com/workspace/dashboard", hooks(none));
  assert.deepEqual(opened, ["tnt_garg"]);
  assert.equal(a.done, true);
  const b = await follow.followNavigation("https://app.aitherium.com/", hooks(ownerOnGarg));
  assert.equal(backed, 1);
  assert.equal(b.done, true);
  await follow.followNavigation("https://app.aitherium.com/", hooks(none));
  assert.equal(backed, 1);
});

test("a refused open (not the owner, host does not declare it) is not done and never throws", async () => {
  const r = await follow.followNavigation("https://garg.aitherium.com/", {
    currentTenant: () => none,
    open: async () => ({ opened: false, refused: "not the platform owner" }),
  });
  assert.equal(r.done, false);
  const t = await follow.followNavigation("https://garg.aitherium.com/", {
    currentTenant: () => { throw new Error("resolver down"); },
    open: async () => ({ opened: true }),
  });
  assert.equal(t.done, true);
});

test("the overlay does not reload when the page already is on the workspace's host", () => {
  assert.equal(follow.needsReload("https://garg.aitherium.com/workspace/dashboard", "https://garg.aitherium.com/"), false);
  assert.equal(follow.needsReload("https://app.aitherium.com/workspace/dashboard", "https://aitherium.com/"), false);
  assert.equal(follow.needsReload("https://app.aitherium.com/x", "https://garg.aitherium.com/"), true);
  assert.equal(follow.needsReload("", "https://garg.aitherium.com/"), true);
});
