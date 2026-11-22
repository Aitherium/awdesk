"use strict";

// Inference: which models are serving, from the same platform pulse the Inference
// Ops widget polls (inference-widget.cjs). Read-only: actions stay in that window.
module.exports = {
  id: "inference",
  label: "Inference",
  hint: "Models serving now (the Inference Ops read-out)",
  view: "list",
  size: { w: 320, h: 224 },
  refreshMs: 15000,
  async read(ctx) {
    if (!ctx || typeof ctx.inference !== "function") return { ok: false, error: "inference is not connected" };
    const snap = await ctx.inference();
    if (!snap || !snap.ok) return { ok: false, error: (snap && snap.error) || "no answer from the platform" };
    if (!snap.reported) return { rows: [], sub: "inference topology not reported" };
    const models = (snap.rows || []).flatMap((r) => r.models || []);
    const serving = models.filter((m) => m.state === "serving").length;
    return {
      sub: `${serving}/${models.length} serving`,
      rows: models.map((m) => ({
        label: m.name || m.key,
        value: m.state + (typeof m.waiting === "number" && m.waiting > 0 ? ` · ${m.waiting} waiting` : ""),
        tone: m.state === "serving" ? "ok" : m.state === "down" || m.state === "failed" ? "bad" : "warn",
      })),
    };
  },
};
