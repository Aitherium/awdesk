"use strict";

// awsh sessions the harness daemon is running (terminal-client.cjs list()).
module.exports = {
  id: "sessions",
  label: "awsh sessions",
  hint: "Shells and coding agents running under awsh",
  view: "list",
  size: { w: 288, h: 224 },
  refreshMs: 10000,
  async read(ctx) {
    if (!ctx || typeof ctx.sessions !== "function") return { ok: false, error: "awsh is not connected" };
    const r = await ctx.sessions();
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || "the awsh daemon did not answer" };
    const rows = (r.sessions || []).map((s) => ({
      label: s.label || s.harness || s.id,
      value: s.state || "",
      tone: s.state === "running" ? "ok" : s.state === "exited" ? "muted" : "warn",
    }));
    return { rows, sub: `${rows.length} session${rows.length === 1 ? "" : "s"}` };
  },
};
