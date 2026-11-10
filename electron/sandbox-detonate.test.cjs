"use strict";

/**
 * The safety rules of "detonate a file in Windows Sandbox", tested without a
 * sandbox, a daemon or Electron. Every test names the failure it would catch if
 * the code were deleted.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const sandbox = require("./sandbox-detonate.cjs");

/** A temp file with known bytes, and its real SHA-256. */
function tempFile(t, name = "sample.exe", bytes = Buffer.from("MZ-not-really-an-executable")) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-sbx-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return { dir, file, sha256: require("node:crypto").createHash("sha256").update(bytes).digest("hex") };
}

/** A recording stand-in for the daemon. Ready by default; detonate returns a receipt. */
function fakeDaemon({ ready = true, receipt = null } = {}) {
  const calls = [];
  const callTool = async (name, args, opts = {}) => {
    calls.push({ name, args: { ...args }, confirm: opts.confirm === true });
    if (name === sandbox.TOOL_DOCTOR) {
      return ready
        ? { ok: true, result: { ok: true, ready: true } }
        : {
          ok: false,
          result: {
            ok: false,
            ready: false,
            admin_command: "Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All",
            owner_once: "1) In an administrator PowerShell run: Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All  2) Restart Windows.",
            error: "Containers-DisposableClientVM is disabled",
          },
        };
    }
    return {
      ok: true,
      result: receipt || {
        ok: true,
        exit_code: 0,
        run_dir: "C:\\Users\\t\\AppData\\Local\\sandbox-mcp\\runs\\2026-11-10T10-00-00",
        report: {
          processes: [{ name: "sample.exe" }, { name: "cmd.exe" }],
          lookups: [{ host: "example.test" }],
          connections: [],
          scheduled_tasks: [{ name: "updater" }],
          services: [],
        },
      },
    };
  };
  return { calls, callTool, names: () => calls.map((c) => c.name) };
}

const RUNS = path.join("C:", "Users", "t", "AppData", "Local", "sandbox-mcp", "runs");

// ── 1. nothing is called before the owner clicks ────────────────────────────

test("request() prepares a confirm card and calls NOTHING on the daemon", async (t) => {
  const { file, sha256 } = tempFile(t);
  const daemon = fakeDaemon();
  const det = sandbox.createSandboxDetonator({ callTool: daemon.callTool, root: RUNS, path });

  const { card, accepted } = await det.request(file);

  assert.equal(accepted, true);
  assert.equal(card.kind, "confirm");
  assert.equal(card.file, path.resolve(file), "the card names the exact file");
  assert.equal(card.size, fs.statSync(file).size, "the card names the size");
  assert.equal(card.sha256, sha256, "the card carries the real SHA-256");
  assert.match(card.lines.join("\n"), /networking off/);
  assert.deepEqual(daemon.calls, [], "no doctor and no detonate before the click");
});

test("confirm() is what calls the tool: exactly one detonate, with confirm=true", async (t) => {
  const { file } = tempFile(t);
  const daemon = fakeDaemon();
  const det = sandbox.createSandboxDetonator({ callTool: daemon.callTool, root: RUNS, path });

  const { token } = await det.request(file);
  const out = await det.confirm(token);

  assert.deepEqual(daemon.names(), [sandbox.TOOL_DOCTOR, sandbox.TOOL_DETONATE]);
  const detonate = daemon.calls.find((c) => c.name === sandbox.TOOL_DETONATE);
  assert.equal(detonate.confirm, true, "the route's 403 confirm_required must be answered");
  assert.equal(out.ran, true);
  assert.equal(out.card.kind, "report");
});

// ── 2. a desk:// link alone never detonates ─────────────────────────────────

test("a desk:// link only ever raises the SAME confirm card -- it never detonates", async (t) => {
  const { file } = tempFile(t);
  const daemon = fakeDaemon();
  const det = sandbox.createSandboxDetonator({ callTool: daemon.callTool, root: RUNS, path });
  const link = `desk://sandbox/detonate?path=${encodeURIComponent(file)}`;

  const { card, token } = await det.requestFromLink(link);

  assert.equal(card.kind, "confirm");
  assert.equal(card.file, path.resolve(file));
  assert.equal(typeof token, "string");
  assert.deepEqual(daemon.calls, [], "a link must never be a trigger");
  assert.equal(det.isBusy(), true, "the slot is held while the card waits");
});

test("a malformed or non-local link is refused with no card action", async () => {
  const det = sandbox.createSandboxDetonator({ callTool: fakeDaemon().callTool, root: RUNS, path });
  for (const link of [
    "desk://browse?url=https://example.test",
    "desk://sandbox/detonate",
    "desk://sandbox/detonate?path=relative%2Fsample.exe",
    "desk://sandbox/detonate?path=%5C%5Cserver%5Cshare%5Csample.exe",
    "https://example.test/sandbox/detonate?path=C%3A%5Csample.exe",
  ]) {
    const out = await det.requestFromLink(link);
    assert.equal(out.accepted, false, link);
    assert.equal(out.card.kind, "problem", link);
    assert.equal(det.isBusy(), false, `${link} must not hold the slot`);
  }
});

// ── 3. network is ALWAYS off ────────────────────────────────────────────────

test("the detonate call's network is 'off' and there is no way to ask for another", async (t) => {
  const { file } = tempFile(t);
  const daemon = fakeDaemon();
  const det = sandbox.createSandboxDetonator({ callTool: daemon.callTool, root: RUNS, path });

  const { token } = await det.request(file);
  await det.confirm(token);

  const detonate = daemon.calls.find((c) => c.name === sandbox.TOOL_DETONATE);
  assert.deepEqual(detonate.args, { target: path.resolve(file), network: "off" });
  assert.equal(sandbox.NETWORK, "off");
});

// ── 4. doctor not ready: show the exact fix, call nothing else ──────────────

test("doctor not ready shows its exact fix text and calls no detonate", async (t) => {
  const { file } = tempFile(t);
  const daemon = fakeDaemon({ ready: false });
  const det = sandbox.createSandboxDetonator({ callTool: daemon.callTool, root: RUNS, path });

  const { token } = await det.request(file);
  const out = await det.confirm(token);

  assert.deepEqual(daemon.names(), [sandbox.TOOL_DOCTOR], "nothing but the doctor was called");
  assert.equal(out.ran, false);
  assert.equal(out.card.kind, "doctor");
  assert.match(out.card.fixText, /Containers-DisposableClientVM/, "the administrator command is shown verbatim");
  assert.match(out.card.fixText, /Restart Windows/, "the reboot step is shown verbatim");
  assert.equal(out.card.action, null, "the desk never runs the fix and never elevates");
  assert.equal(det.isBusy(), false, "a not-ready answer frees the slot");
});

// ── 5. guest text is plain and capped ───────────────────────────────────────

test("guest text is flattened to plain text and capped, never treated as markup", (t) => {
  const { file } = tempFile(t);
  const receipt = {
    ok: true,
    exit_code: 0,
    run_dir: path.join(RUNS, "run-1"),
    report: { summary: `<img src=x onerror="alert(1)">${"A".repeat(5000)}` },
  };
  const card = sandbox.reportCard({ ok: true, result: receipt }, { root: RUNS, path });

  assert.ok(card.guestText.includes("<img"), "the bytes of guest output survive as TEXT");
  assert.ok(card.guestText.length <= sandbox.MAX_GUEST_CHARS, "guest output is capped");
  assert.doesNotMatch(card.guestText, /\u0000/, "control bytes are dropped");

  const element = { textContent: "", innerHTML: "untouched" };
  sandbox.setText(element, receipt.report.summary, 40);
  assert.ok(element.textContent.length <= 40);
  assert.equal(element.innerHTML, "untouched", "setText only writes textContent");

  const source = fs.readFileSync(path.join(__dirname, "sandbox-detonate.cjs"), "utf8");
  assert.doesNotMatch(source, /\.innerHTML/, "this module has no HTML sink at all");

  // The report card's own words are the required ones.
  assert.match(card.lines.join("\n"), /heuristics, not a safety verdict/);
  assert.equal(card.findingsNote, "heuristics, not a safety verdict");
});

test("report counts are read from the receipt and never invented", () => {
  const card = sandbox.reportCard({
    ok: true,
    result: {
      ok: true,
      exit_code: 0,
      run_dir: path.join(RUNS, "run-2"),
      report: {
        processes: [{}, {}],
        dns_lookups: [{}],
        connections: [{}, {}, {}],
        autoruns: [{}],
        scheduled_tasks: [{}, {}],
      },
    },
  }, { root: RUNS, path });

  assert.deepEqual(card.counts, { processes: 2, lookups: 1, connections: 3, persistence: 3 });
  assert.match(card.countLine, /Processes: 2/);

  const empty = sandbox.reportCard({ ok: true, result: { ok: true, exit_code: 0, report: {} } }, { root: RUNS, path });
  assert.equal(empty.counts.processes, null, "an unreported count is null, not a fabricated zero");
  assert.match(empty.countLine, /Processes: not reported/);
  assert.equal(empty.openFolder, false, "no run folder -> no Open folder button");
});

// ── 6. Open folder refuses anything outside the runs root ───────────────────

test("open folder refuses a path outside the runs root and never calls openPath", async () => {
  const opened = [];
  const outside = path.join("C:", "Users", "t", "Desktop", "run-1");
  const out = await sandbox.openRunFolder(outside, {
    root: RUNS,
    path,
    openPath: async (p) => { opened.push(p); return ""; },
  });

  assert.equal(out.ok, false);
  assert.equal(out.reason, "outside_runs_root");
  assert.deepEqual(opened, [], "shell.openPath was never reached");

  const traversal = await sandbox.openRunFolder(path.join(RUNS, "..", "..", "Windows"), {
    root: RUNS, path, openPath: async (p) => { opened.push(p); return ""; },
  });
  assert.equal(traversal.ok, false, "'..' is resolved before the containment check");
  assert.deepEqual(opened, []);
});

test("open folder opens a real run folder under the runs root", async () => {
  const opened = [];
  const inside = path.join(RUNS, "2026-11-10T10-00-00");
  const out = await sandbox.openRunFolder({ runDir: inside }, {
    root: RUNS,
    path,
    openPath: async (p) => { opened.push(p); return ""; },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(opened, [path.resolve(inside)]);
});

// ── 7. one at a time ────────────────────────────────────────────────────────

test("a second request while one holds the slot gets a busy card, not a second call", async (t) => {
  const { file } = tempFile(t);
  const daemon = fakeDaemon();
  const det = sandbox.createSandboxDetonator({ callTool: daemon.callTool, root: RUNS, path });

  const first = await det.request(file);
  assert.equal(first.card.kind, "confirm");

  const second = await det.request(file);
  assert.equal(second.accepted, false);
  assert.equal(second.card.kind, "busy");
  assert.equal(second.card.action, null);
  assert.deepEqual(daemon.calls, [], "neither request touched the daemon");

  // Confirming with the stale/second card's absent token is refused too.
  const stale = await det.confirm("sbx-does-not-exist");
  assert.equal(stale.card.kind, "problem");
  assert.equal(stale.ran, false);

  await det.confirm(first.token);
  assert.equal(det.isBusy(), false, "the slot is released after the run");
});

test("confirming twice runs the detonation once", async (t) => {
  const { file } = tempFile(t);
  const daemon = fakeDaemon();
  const det = sandbox.createSandboxDetonator({ callTool: daemon.callTool, root: RUNS, path });

  const { token } = await det.request(file);
  await det.confirm(token);
  await det.confirm(token);

  assert.equal(daemon.calls.filter((c) => c.name === sandbox.TOOL_DETONATE).length, 1);
});

test("cancel frees the slot without calling anything", async (t) => {
  const { file } = tempFile(t);
  const daemon = fakeDaemon();
  const det = sandbox.createSandboxDetonator({ callTool: daemon.callTool, root: RUNS, path });

  const { token } = await det.request(file);
  det.cancel(token);

  assert.equal(det.isBusy(), false);
  assert.deepEqual(daemon.calls, []);
});

// ── path / size helpers ─────────────────────────────────────────────────────

test("inspectTarget refuses a folder, a missing file and a relative path", (t) => {
  const { dir } = tempFile(t);
  assert.equal(sandbox.inspectTarget(dir).reason, "not_a_file");
  assert.equal(sandbox.inspectTarget(path.join(dir, "nope.exe")).reason, "path_missing");
  assert.equal(sandbox.inspectTarget("sample.exe").reason, "bad_path");
  assert.equal(sandbox.inspectTarget("\\\\server\\share\\a.exe").reason, "bad_path");
});

test("sizeLabel is exact bytes first and a human scale second", () => {
  assert.match(sandbox.sizeLabel(0), /^0 bytes \(0\)$/);
  assert.match(sandbox.sizeLabel(1024), /1,024 bytes \(1\.0 KiB\)/);
});
