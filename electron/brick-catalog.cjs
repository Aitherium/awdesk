"use strict";

/**
 * brick-catalog.cjs -- the aw* stack as a catalog (owner, 2026-10-04: "awfirewall /
 * awtunnel / aw*stack bricks"), for aither://bricks.
 *
 * The catalog and each brick's page are awkno's (`awkno list --plain`, `awkno --plain
 * <name>`), so a brick added to the family appears with no edit here. What is
 * INSTALLED, its version, and upgrade / test / rollback stay bricks-client.cjs's job
 * (`adk bricks`, shared with Settings > Updates); the page joins the two by id.
 * Read-only: nothing here runs a brick.
 */

const NAME = /^[a-z][a-z0-9-]{1,40}$/;

/** "BRICKS (85)\n    awwall   Fail-closed egress ..." -> [{section, name, summary}] */
function parseList(text) {
  const out = [];
  let section = "";
  for (const raw of String(text || "").split(/\r?\n/)) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\u001b\[[0-9;]*m/g, "");
    const head = line.match(/^([A-Z][A-Z &-]+?)\s*\((\d+)\)\s*$/);
    if (head) { section = head[1].trim().toLowerCase(); continue; }
    const row = line.match(/^\s{2,}([a-z][a-z0-9-]+)\s{2,}(.*)$/);
    if (row && section) out.push({ section, name: row[1], summary: row[2].trim() });
  }
  return out;
}

function createBrickCatalog({ execFile = require("node:child_process").execFile } = {}) {
  const run = (args) => new Promise((resolve) => {
    execFile("awkno", args, { timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" } }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });

  async function list() {
    const r = await run(["list", "--plain"]);
    if (r.error && !r.stdout) {
      return { ok: false, error: r.error.code === "ENOENT" ? "awkno is not installed" : (r.stderr.trim() || String(r.error.message)) };
    }
    return { ok: true, items: parseList(r.stdout) };
  }

  async function page(name) {
    if (!NAME.test(String(name || ""))) return { ok: false, error: "not a brick name" };
    const r = await run(["--plain", String(name)]);
    if (!r.stdout.trim()) return { ok: false, error: r.stderr.trim() || "no page" };
    // eslint-disable-next-line no-control-regex
    return { ok: true, name, text: r.stdout.replace(/\u001b\[[0-9;]*m/g, "").slice(0, 60_000) };
  }

  // awpack: first-party agent packs (list / show / install / verify / remove). The verbs are
  // a fixed list and the id is validated before any spawn; the page never names a command.
  const runPack = (args) => new Promise((resolve) => {
    execFile("awpack", [...args, "--json"], { timeout: 300_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const text = String(stdout || "");
        const at = text.indexOf("{");
        let data;
        try { data = at >= 0 ? JSON.parse(text.slice(at)) : null; } catch { data = null; }
        if (error && error.code === "ENOENT") return resolve({ ok: false, error: "awpack is not installed" });
        if (!data) return resolve({ ok: false, error: String(stderr || text).trim().split("\n").pop() || "awpack gave no answer" });
        resolve(data.ok === false ? { ok: false, error: String(data.detail || "refused"), data } : { ok: true, data });
      });
  });

  async function packs() {
    const r = await runPack(["list"]);
    return r.ok ? { ok: true, packs: (r.data.packs || []).map((p) => ({ id: String(p.id), version: String(p.version || ""),
      status: String(p.status || ""), summary: String(p.summary || "") })) } : r;
  }

  function packAct(verb, id) {
    if (!["show", "install", "verify", "remove"].includes(verb)) return Promise.resolve({ ok: false, error: "unknown pack verb" });
    if (!NAME.test(String(id || ""))) return Promise.resolve({ ok: false, error: "not a pack id" });
    return runPack([verb, String(id)]);
  }

  return { list, page, packs, packAct };
}

module.exports = { createBrickCatalog, parseList };
