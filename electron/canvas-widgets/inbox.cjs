"use strict";

// Decisions waiting in the Inbox -- the same count the tray badge and the Inbox tab show.
module.exports = {
  id: "inbox",
  label: "Inbox",
  hint: "Decision cards waiting for you",
  view: "stat",
  size: { w: 224, h: 128 },
  refreshMs: 5000,
  async read(ctx) {
    if (!ctx || typeof ctx.inbox !== "function") return { ok: false, error: "the inbox is not connected yet" };
    const n = Number(await ctx.inbox()) || 0;
    return { value: n, sub: n === 1 ? "decision waiting" : "decisions waiting", tone: n > 0 ? "warn" : "ok" };
  },
};
