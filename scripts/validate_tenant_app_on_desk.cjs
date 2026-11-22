#!/usr/bin/env node
"use strict";

/**
 * validate_tenant_app_on_desk -- click through a tenant's workspace ON THE RUNNING DESK
 * before a customer is told anything.
 *
 * Owner, 2026-11-12: several changes reached a customer on tests and curl probes alone;
 * nobody had looked at the real app on the real desk. This drives the desk the owner is
 * signed in on, over its own bridge (POST /commands/run), and writes a numbered JPEG
 * per step plus one results.json. It presses no key and moves no pointer.
 *
 *   node scripts/validate_tenant_app_on_desk.cjs --tenant garg --out C:\tmp\desk-validate
 *     [--home aitherium] [--container aitheros-vibe-api] [--live-container aitheros-gargbot]
 *     [--synthetic C:\path\with\roster.json+ground_truth.json] [--keep-open]
 *
 * A step is `pass`, `fail`, or `look`: `look` means the machine captured the screen and
 * a person (or the calling agent) must read the JPEG -- a screenshot nobody opened is
 * not a check. Exit 0 = no step failed; 1 = a step failed; 2 = the desk could not be
 * reached (never 0 on silence).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const WINSHOT = path.join(__dirname, "tenant-validate", "winshot.ps1");
const SCRATCH_FLOW = path.join(__dirname, "tenant-validate", "certtrack_scratch_flow.py");
const READONLY = path.join(__dirname, "tenant-validate", "certtrack_readonly_counts.py");

function parseArgs(argv) {
  const out = { tenant: "", home: "aitherium", out: "", container: "", liveContainer: "", synthetic: "", keepOpen: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; return String(argv[i] || ""); };
    if (a === "--tenant") out.tenant = next();
    else if (a === "--home") out.home = next();
    else if (a === "--out") out.out = next();
    else if (a === "--container") out.container = next();
    else if (a === "--live-container") out.liveContainer = next();
    else if (a === "--synthetic") out.synthetic = next();
    else if (a === "--keep-open") out.keepOpen = true;
  }
  return out;
}

function bridgePort(env = process.env) {
  if (env.DESK_BRIDGE_PORT) return Number(env.DESK_BRIDGE_PORT);
  try {
    const file = path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Desk", "bridge-port.txt");
    const n = Number(fs.readFileSync(file, "utf8").trim());
    if (n > 0) return n;
  } catch { /* fall through to the default */ }
  return 47931;
}

/** One bridge call. The desk's main thread stalls for seconds at a time (a workspace
 *  switch re-asks Identity), so a call gets 90 s and one retry before it is a failure. */
async function call(port, route, body, { timeoutMs = 90000, retries = 1 } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, {
        ...(body === undefined ? {} : {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      try { return { http: res.status, json: JSON.parse(text) }; } catch { return { http: res.status, json: null, text }; }
    } catch (err) {
      last = err;
      await sleep(3000);
    }
  }
  return { http: 0, json: null, error: String((last && (last.cause && last.cause.code)) || (last && last.message) || "no answer") };
}

const run = (port, id, arg) => call(port, "/commands/run", arg === undefined ? { id } : { id, arg });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── pure judges (scripts/validate_tenant_app_on_desk.test.cjs) ──────────────────────

/** `workspace.switch` must say where the desk is, in the answer, and be there. */
function judgeSwitch(answer, wantHost) {
  const v = answer && answer.json && answer.json.verdict;
  if (!v) return { verdict: "fail", why: "the bridge gave no verdict" };
  const line = String(v.line || "");
  if (!/^You are in /.test(line)) return { verdict: "fail", why: `the answer does not say where the desk is: ${line || "(empty)"}` };
  if (v.ok === false) return { verdict: "fail", why: v.error || line };
  if (wantHost && !line.includes(`(${wantHost})`)) return { verdict: "fail", why: `expected ${wantHost}; got: ${line}` };
  return { verdict: "pass", why: line };
}

/** An unknown name must be refused AND still say where the desk is. */
function judgeRefusal(answer) {
  const v = answer && answer.json && answer.json.verdict;
  if (!v) return { verdict: "fail", why: "the bridge gave no verdict" };
  if (v.ok !== false) return { verdict: "fail", why: "an unknown workspace name was accepted" };
  if (!/^You are in /.test(String(v.line || ""))) return { verdict: "fail", why: "the refusal does not say where the desk is" };
  return { verdict: "pass", why: v.error || v.line };
}

/** The fairy's numbers must agree with each other (fairy-counts.problems). */
function judgeCounts(answer) {
  const v = answer && answer.json && answer.json.verdict;
  if (!v || !v.counts) return { verdict: "fail", why: "the desk has no fairy.counts command (older build)" };
  if (Array.isArray(v.problems) && v.problems.length) return { verdict: "fail", why: v.problems.join("; ") };
  return { verdict: "pass", why: v.line };
}

function summarize(steps) {
  const count = (k) => steps.filter((s) => s.verdict === k).length;
  return { pass: count("pass"), fail: count("fail"), look: count("look"), ok: count("fail") === 0 };
}

// ── the desk's windows, captured without focusing them ──────────────────────────────

function deskPid() {
  const r = spawnSync("powershell", ["-NoProfile", "-Command",
    "(Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object -First 1).ProcessId"],
  { encoding: "utf8", windowsHide: true });
  return Number(String(r.stdout || "").trim()) || 0;
}

function winshot(args) {
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WINSHOT, ...args],
    { encoding: "utf8", windowsHide: true });
  try { return JSON.parse(String(r.stdout || "").trim() || "null"); } catch { return null; }
}

function windows(pid) {
  const list = winshot(["-ProcId", String(pid), "-List"]);
  return Array.isArray(list) ? list : (list ? [list] : []);
}

function inContainer(container, script, env = {}) {
  const args = ["-d", process.env.AITHER_FLEET_DISTRO || "awnix", "-u", "root", "podman", "exec", "-i"];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push(container, "python", "-");
  const r = spawnSync("wsl", args, { input: script, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const line = String(r.stdout || "").split(/\r?\n/).reverse().find((l) => l.startsWith("RESULT "));
  if (!line) return { ok: false, error: String(r.stderr || r.stdout || "no RESULT line").slice(-600) };
  try { return { ok: true, result: JSON.parse(line.slice(7)) }; } catch (e) { return { ok: false, error: String(e) }; }
}

// ── the run ─────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tenant || !args.out) {
    console.error("usage: validate_tenant_app_on_desk.cjs --tenant <name> --out <dir> [--home aitherium] "
      + "[--container <test-tenant-backend>] [--live-container <tenant-backend>] [--synthetic <dir>] [--keep-open]");
    return 2;
  }
  fs.mkdirSync(args.out, { recursive: true });
  const port = bridgePort();
  const steps = [];
  let n = 0;
  const file = (name) => path.join(args.out, `${String(n += 1).padStart(2, "0")}-${name}`);
  const add = (id, what, judged, extra = {}) => { steps.push({ id, what, ...judged, ...extra }); console.log(`${judged.verdict.toUpperCase().padEnd(4)} ${id}  ${what}: ${judged.why || ""}`); };
  const save = (name, value) => { const f = file(name); fs.writeFileSync(f, JSON.stringify(value, null, 1)); return f; };

  let health;
  try { health = await call(port, "/health"); } catch { health = null; }
  if (!health || health.http !== 200) {
    console.error(`DEAD: the desk bridge does not answer on 127.0.0.1:${port}`);
    return 2;
  }
  const pid = deskPid();
  const shoot = (hwnd, name) => {
    const f = file(name);
    const r = winshot(["-ProcId", String(pid), "-Hwnd", String(hwnd), "-Out", f]);
    return r && r.ok ? f : "";
  };

  // a. where am I; into the tenant; an unknown name; (back home at the end)
  const where = await run(port, "workspace.switch");
  add("a1", "the desk says where it is", judgeSwitch(where), { proof: save("where.json", where.json) });
  const names = ((where.json && where.json.verdict && where.json.verdict.workspaces) || []).join(", ");
  const into = await run(port, "workspace.switch", args.tenant);
  const host = into.json && into.json.verdict && into.json.verdict.host;
  add("a2", `switch to ${args.tenant}`, judgeSwitch(into, host || undefined), { proof: save("switch-in.json", into.json), workspaces: names });
  const bogus = await run(port, "workspace.switch", "no-such-workspace-xyz");
  add("a3", "an unknown workspace is refused and the desk still says where it is", judgeRefusal(bogus), { proof: save("switch-unknown.json", bogus.json) });

  // b. the tenant's app window and overlay, as the owner sees them
  await run(port, "desktop.app.open");
  await sleep(15000);
  const status = await call(port, "/desktop/status");
  const wins = windows(pid).filter((w) => w.visible && w.w > 600);
  const app = wins.find((w) => w.x < 0) || wins.sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const overlay = wins.find((w) => app && w.hwnd !== app.hwnd);
  if (app) {
    const f = shoot(app.hwnd, `${args.tenant}-app-window.jpg`);
    add("b1", "the tenant app window: brand, the tenant's own apps, nothing covering the taskbar, the companion",
      { verdict: f ? "look" : "fail", why: f ? `read ${f} (window title: ${app.title})` : "the window could not be captured" }, { proof: f, title: app.title });
  } else {
    add("b1", "the tenant app window", { verdict: "fail", why: "no app window opened" });
  }
  if (overlay) {
    const f = shoot(overlay.hwnd, `${args.tenant}-overlay.jpg`);
    add("b2", "the overlay dock in the tenant (black when another window covers it)", { verdict: f ? "look" : "fail", why: f ? `read ${f}` : "not captured" }, { proof: f });
  }
  save("desktop-status.json", status.json);

  // the fairy: numbers that agree, and the windows that carry them
  const counts = await run(port, "fairy.counts");
  add("fairy", "the fairy's badge, 'N more waiting' and companion badges agree", judgeCounts(counts), { proof: save("fairy-counts.json", counts.json) });
  const swarm = windows(pid).find((w) => w.title === "Aither swarm" && w.visible);
  if (swarm) add("fairy-look", "the fairy swarm as drawn", { verdict: "look", why: "compare with fairy-counts.json" }, { proof: shoot(swarm.hwnd, "fairy-swarm.jpg") });

  // d/e. the live tenant, READ ONLY, counts and header names only
  if (args.liveContainer) {
    const r = inContainer(args.liveContainer, fs.readFileSync(READONLY, "utf8"));
    const sheets = r.ok ? ((r.result.audit_xlsx || {}).sheets || []) : [];
    const good = r.ok && r.result.audit_xlsx.zip_magic && sheets.length > 0 && sheets[0].headers.length > 0;
    add("d", "the audit workbook the Download button serves opens (sheets, headers, rows)",
      { verdict: good ? "pass" : "fail", why: r.ok ? sheets.map((s) => `${s.sheet}: ${s.rows} rows, ${s.headers.length} columns`).join("; ") : r.error },
      { proof: save("live-audit-facts.json", r.ok ? r.result : r) });
    const have = r.ok ? (r.result.have || []).map((h) => h.text).join("; ") : "";
    add("e", "what the tenant already holds (counts only)", { verdict: r.ok && have ? "pass" : "fail", why: have || "nothing reported" });
  }

  // f/h. the drop flow and a bad upload, on a SCRATCH database in a test tenant's backend
  if (args.container && args.synthetic) {
    const roster = JSON.parse(fs.readFileSync(path.join(args.synthetic, "roster.json"), "utf8"));
    const truth = JSON.parse(fs.readFileSync(path.join(args.synthetic, "ground_truth.json"), "utf8"));
    if (roster.synthetic !== true) {
      add("f", "three-file drop", { verdict: "fail", why: "refused: the roster is not marked synthetic" });
    } else {
      const data = { employees: roster.employees, files: truth.files.map((f) => ({ employee: f.employee, kind: f.kind, cert: f.cert, number: f.number, expires: f.expires })) };
      const script = fs.readFileSync(SCRATCH_FLOW, "utf8").replace("r'''__DATA__'''", `r'''${JSON.stringify(data)}'''`);
      for (const variant of ["clean", "messy"]) {
        const r = inContainer(args.container, script, { VARIANT: variant });
        const proof = save(`scratch-flow-${variant}.json`, r.ok ? r.result : r);
        if (!r.ok) { add(`f-${variant}`, "three-file drop on a scratch database", { verdict: "fail", why: r.error }, { proof }); continue; }
        const s = r.result.steps;
        const kinds = (s.three_file_drop.files || []).map((f) => f.kind);
        const classified = ["roster", "certifications", "licenses"].every((k) => kinds.includes(k));
        add(`f-${variant}-classify`, `three files told apart by content (${variant} synthetic data)`,
          { verdict: classified ? "pass" : "fail", why: (s.three_file_drop.files || []).map((f) => f.text).join(" | ") }, { proof });
        const re = s.redrop_export || {};
        const done = s.redrop_export_confirmed || {};
        add(`f-${variant}-redrop`, "the app's own export, dropped back, asks ONE confirm and is then accepted",
          { verdict: re.ask === "confirm" && done.http === 200 && !done.ask ? "pass" : "fail", why: `${re.text || ""}${re.question ? ` -> ${re.question}` : ""}` }, { proof });
        if (variant === "clean") {
          const b = s.bad_upload || {};
          const good = b.tickets_filed === 1 && b.has_header_row === true && b.leaks_a_data_cell === false
            && (b.responses || []).every((x) => x.http === 422);
          add("h", "a bad upload, twice: one ticket, the header row only, no data cell (ticket captured, never sent)",
            { verdict: good ? "pass" : "fail", why: `tickets ${b.tickets_filed}, header row ${b.has_header_row}, data cell leaked ${b.leaks_a_data_cell}` }, { proof });
        }
      }
    }
  }

  // a. and back
  if (!args.keepOpen) {
    const back = await run(port, "workspace.switch", args.home);
    add("a4", `back to ${args.home}`, judgeSwitch(back), { proof: save("switch-back.json", back.json) });
  }

  const summary = summarize(steps);
  const resultFile = path.join(args.out, "results.json");
  fs.writeFileSync(resultFile, JSON.stringify({ tenant: args.tenant, at: new Date().toISOString(), bridge: port, summary, steps }, null, 1));
  console.log(`\n${summary.pass} pass, ${summary.fail} fail, ${summary.look} to look at -> ${resultFile}`);
  return summary.ok ? 0 : 1;
}

module.exports = { parseArgs, bridgePort, judgeSwitch, judgeRefusal, judgeCounts, summarize };

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => { console.error(`DEAD: ${err && err.message}`); process.exit(2); });
}
