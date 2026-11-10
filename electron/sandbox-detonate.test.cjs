"use strict";

/**
 * The safety rules of "detonate a file in Windows Sandbox", tested without a
 * sandbox, a daemon or Electron. Every test names the failure it would catch if
 * the code were deleted.
 *
 * The receipt fixtures are the REAL shapes, not invented ones:
 *   - awdk/adk/desktop/tools.py `_sandbox_receipt`:
 *       {ok, command, exit_code, timed_out, data, run_dir, report,
 *        findings_are, error}
 *   - and, past _MAX_SANDBOX_CHARS, the CURRENT capped shape:
 *       {ok, command, exit_code, timed_out, run_dir, sha256, findings_are,
 *        error, truncated: true, preview,
 *        counts: {processes, lookups, connections, services, persistence,
 *                 scheduled_tasks, findings}}
 *     (the OLD capped shape kept no run_dir/exit_code/counts/sha256:
 *       {ok, command, truncated: true, preview, findings_are})
 *   - awdk/adk/desktop/sandbox.py `read_report`:
 *       {found, path, truncated, json, text} -- only the fields the desk reads
 *       are modelled here; the desk ignores awdk's data_note
 *   - shanselman/sandbox-mcp v1.2.0 src/detonate.js `detonate()` / `findings()`:
 *       data = {file, hostPath, sha256, tree, lookups, connections, diff,
 *               findings, windows, crashes, runDir, outDir, exitCode, ...}, with
 *       diff.services, diff.values and diff.files.added.
 */

const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const sandbox = require("./sandbox-detonate.cjs");

const sha = (bytes) => nodeCrypto.createHash("sha256").update(bytes).digest("hex");

function tempDir(t, prefix = "awdesk-sbx-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A temp file with known bytes, and their SHA-256. */
function tempFile(t, name = "sample.exe", bytes = Buffer.from("MZ-not-really-an-executable")) {
  const dir = tempDir(t);
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return { dir, file, bytes, sha256: sha(bytes) };
}

const RUNS = path.join("C:", "Users", "t", "AppData", "Local", "sandbox-mcp", "runs");

/** awdk's read_report() wrapper (adk/desktop/sandbox.py `read_report`). */
function readReport() {
  return { found: false, path: null, truncated: false, json: null, text: null };
}

/**
 * A recording stand-in for the daemon. Ready by default; detonate returns a
 * receipt in awdk's shape. `digest: "target"` makes the fake hash the file it
 * was asked to run, exactly as upstream does when it copies the file into the
 * guest (detonate.js line 134), so the desk's digest check is exercised for real.
 */
function fakeDaemon({ ready = true, receipt = null, digest = "target", runDir = path.join(RUNS, "run-1") } = {}) {
  const calls = [];
  const callTool = async (name, args, opts = {}) => {
    calls.push({ name, args: { ...args }, confirm: opts.confirm === true });
    if (name === sandbox.TOOL_DOCTOR) {
      return ready
        ? { ok: true, result: { ok: true, command: "doctor", exit_code: 0, timed_out: false, data: {}, report: readReport() } }
        : {
          ok: false,
          result: {
            ok: false,
            ready: false,
            command: "doctor",
            exit_code: 1,
            timed_out: false,
            data: {},
            admin_command: "Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All",
            owner_once: "1) In an administrator PowerShell run: Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All  2) Restart Windows.",
            findings_are: "heuristics, not a verdict",
            error: "Containers-DisposableClientVM is disabled",
          },
        };
    }
    if (receipt) return { ok: true, result: receipt };
    const data = { file: path.basename(String(args.target)), tree: [], lookups: [], connections: [] };
    if (digest === "target") data.sha256 = sha(fs.readFileSync(args.target));
    else if (digest) data.sha256 = digest;
    return {
      ok: true,
      result: {
        ok: true, command: "detonate", exit_code: 0, timed_out: false,
        data, run_dir: runDir, report: readReport(),
        findings_are: "heuristics, not a verdict", error: "",
      },
    };
  };
  return { calls, callTool, names: () => calls.map((c) => c.name), detonate: () => calls.find((c) => c.name === sandbox.TOOL_DETONATE) };
}

/** A detonator wired to temp staging/runs folders (never the real ones). */
function makeDetonator(t, { daemon = fakeDaemon(), root = null } = {}) {
  const staging = tempDir(t, "awdesk-stage-");
  const runs = root || tempDir(t, "awdesk-runs-");
  const det = sandbox.createSandboxDetonator({ callTool: daemon.callTool, staging, root: runs, path });
  return { det, daemon, staging, runs };
}

// ── 1. nothing is called before the owner clicks ────────────────────────────

test("request() stages a copy, shows its hash, and calls NOTHING on the daemon", async (t) => {
  const { file, sha256 } = tempFile(t);
  const { det, daemon } = makeDetonator(t);

  const { card, accepted } = await det.request(file);

  assert.equal(accepted, true);
  assert.equal(card.kind, "confirm");
  assert.equal(card.file, path.resolve(file), "the card names the file the owner picked");
  assert.equal(card.size, fs.statSync(file).size, "the card names the size");
  assert.equal(card.sha256, sha256, "the card carries the real SHA-256 of the copy");
  assert.ok(card.stagingPath, "the card names the staged copy that will run");
  assert.equal(card.sha256, sha(fs.readFileSync(card.stagingPath)), "the hash is the COPY's");
  assert.deepEqual(fs.readFileSync(card.stagingPath), fs.readFileSync(file), "the copy is the same bytes");
  assert.equal(card.maxBytes, sandbox.MAX_STAGED_BYTES);
  assert.equal(sandbox.MAX_STAGED_BYTES, 2 * 1024 * 1024 * 1024, "the cap is 2 GiB");
  assert.match(card.lines.join("\n"), /networking off/);
  assert.match(card.lines.join("\n"), /2,147,483,648 bytes/, "the size cap is stated on the card");
  assert.deepEqual(daemon.calls, [], "no doctor and no detonate before the click");
});

test("confirm() runs the STAGED COPY, exactly once, with confirm=true", async (t) => {
  const { file } = tempFile(t);
  const { det, daemon } = makeDetonator(t);

  const { token, card } = await det.request(file);
  const out = await det.confirm(token);

  assert.deepEqual(daemon.names(), [sandbox.TOOL_DOCTOR, sandbox.TOOL_DETONATE]);
  const detonate = daemon.detonate();
  assert.equal(detonate.confirm, true, "the route's 403 confirm_required must be answered");
  assert.equal(detonate.args.target, card.stagingPath, "the sandbox runs the copy the card hashed");
  assert.notEqual(detonate.args.target, path.resolve(file), "never the path the owner picked");
  assert.equal(out.ran, true);
  assert.equal(out.card.kind, "report");
  assert.equal(out.card.digestMismatch, false, "the receipt's digest matches the card");
  assert.equal(fs.existsSync(card.stagingPath), false, "the staged copy is removed after the run");
  assert.deepEqual(fs.readdirSync(path.dirname(path.dirname(card.stagingPath))), [], "its request folder is gone");
});

test("the digest is still the card's when the ORIGINAL file is replaced while the card is open", async (t) => {
  const { file, sha256 } = tempFile(t);
  const { det, daemon } = makeDetonator(t);

  const { token, card } = await det.request(file);
  // The classic TOCTOU: the path shown on the card is rewritten before the click.
  fs.writeFileSync(file, Buffer.from("evil bytes, not the file on the card"));

  const out = await det.confirm(token);

  assert.equal(out.ran, true);
  assert.equal(daemon.detonate().args.target, card.stagingPath, "the copy is what runs");
  assert.equal(out.card.digest.executed, sha256, "the executed digest is the approved one");
  assert.equal(out.card.digestMismatch, false);
});

// ── 2. a copy that changes under the card refuses the run ───────────────────

test("a staged copy rewritten after the card is shown refuses the run, with no daemon call", async (t) => {
  const { file } = tempFile(t);
  const { det, daemon } = makeDetonator(t);

  const { token, card } = await det.request(file);
  fs.writeFileSync(card.stagingPath, Buffer.from("replaced by someone else"));

  const out = await det.confirm(token);

  assert.equal(out.ran, false);
  assert.equal(out.card.kind, "problem");
  assert.equal(out.card.reason, "staged_changed");
  assert.deepEqual(daemon.calls, [], "the doctor and detonate were never reached");
  assert.equal(fs.existsSync(card.stagingPath), false, "the refused copy is cleaned up");
});

test("a staged copy deleted before the click refuses the run", async (t) => {
  const { file } = tempFile(t);
  const { det, daemon } = makeDetonator(t);

  const { token, card } = await det.request(file);
  fs.unlinkSync(card.stagingPath);

  const out = await det.confirm(token);

  assert.equal(out.ran, false);
  assert.equal(out.card.reason, "staged_missing");
  assert.deepEqual(daemon.calls, []);
});

test("a receipt whose executed digest differs from the card gets a loud mismatch line", async (t) => {
  const { file, sha256 } = tempFile(t);
  const wrong = "0".repeat(64);
  const daemon = fakeDaemon({ digest: wrong });
  const { det } = makeDetonator(t, { daemon });

  const { token } = await det.request(file);
  const out = await det.confirm(token);

  assert.equal(out.card.digestMismatch, true);
  assert.equal(out.card.digest.expected, sha256);
  assert.equal(out.card.digest.executed, wrong);
  assert.match(out.card.lines.join("\n"), /DIGEST MISMATCH/);
  assert.match(out.card.lines.join("\n"), new RegExp(wrong), "the digest the sandbox ran is shown");
});

// ── 3. a desk:// link alone never detonates ─────────────────────────────────

test("a desk:// link only ever raises the SAME confirm card -- it never detonates", async (t) => {
  const { file } = tempFile(t);
  const { det, daemon } = makeDetonator(t);
  const link = `desk://sandbox/detonate?path=${encodeURIComponent(file)}`;

  const { card, token } = await det.requestFromLink(link);

  assert.equal(card.kind, "confirm");
  assert.equal(card.file, path.resolve(file));
  assert.equal(typeof token, "string");
  assert.deepEqual(daemon.calls, [], "a link must never be a trigger");
  assert.equal(det.isBusy(), true, "the slot is held while the card waits");
});

test("a malformed or non-local link is refused with no card action", async (t) => {
  const { det } = makeDetonator(t);
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

// ── 4. network is ALWAYS off ────────────────────────────────────────────────

test("the detonate call's network is 'off' and there is no way to ask for another", async (t) => {
  const { file } = tempFile(t);
  const { det, daemon } = makeDetonator(t);

  const { token } = await det.request(file);
  await det.confirm(token);

  const detonate = daemon.detonate();
  assert.deepEqual(Object.keys(detonate.args).sort(), ["network", "target"], "no other knob exists");
  assert.equal(detonate.args.network, "off");
  assert.equal(sandbox.NETWORK, "off");
});

// ── 5. doctor not ready: show the exact fix, call nothing else ──────────────

test("doctor not ready shows its exact fix text and calls no detonate", async (t) => {
  const { file } = tempFile(t);
  const { det, daemon } = makeDetonator(t, { daemon: fakeDaemon({ ready: false }) });

  const { token, card } = await det.request(file);
  const out = await det.confirm(token);

  assert.deepEqual(daemon.names(), [sandbox.TOOL_DOCTOR], "nothing but the doctor was called");
  assert.equal(out.ran, false);
  assert.equal(out.card.kind, "doctor");
  assert.match(out.card.fixText, /Containers-DisposableClientVM/, "the administrator command is shown verbatim");
  assert.match(out.card.fixText, /Restart Windows/, "the reboot step is shown verbatim");
  assert.equal(out.card.action, null, "the desk never runs the fix and never elevates");
  assert.equal(det.isBusy(), false, "a not-ready answer frees the slot");
  assert.equal(fs.existsSync(card.stagingPath), false, "the staged copy is removed when the doctor says no");
});

// ── 6. guest text is plain and capped ───────────────────────────────────────

test("guest text is the upstream findings list, flattened to plain text and capped", () => {
  const receipt = {
    ok: true,
    command: "detonate",
    exit_code: 0,
    timed_out: false,
    data: {
      file: "sample.exe",
      sha256: "a".repeat(64),
      tree: [{ pid: 1, depth: 0, path: "C:\\guest\\sample.exe" }],
      lookups: [],
      connections: [],
      findings: [
        { level: "high", text: `<img src=x onerror="alert(1)">${"A".repeat(5000)}` },
      ],
    },
    run_dir: path.join(RUNS, "run-1"),
    report: readReport(),
  };
  const card = sandbox.reportCard({ ok: true, result: receipt }, { root: RUNS, path });

  assert.ok(card.guestText.includes("<img"), "the bytes of guest output survive as TEXT");
  assert.ok(card.guestText.startsWith("high: "), "the finding level is kept");
  assert.ok(card.guestText.length <= sandbox.MAX_GUEST_CHARS, "guest output is capped");
  // eslint-disable-next-line no-control-regex -- asserting a control byte was dropped
  assert.doesNotMatch(card.guestText, /\u0000/, "control bytes are dropped");

  const element = { textContent: "", innerHTML: "untouched" };
  sandbox.setText(element, receipt.data.findings[0].text, 40);
  assert.ok(element.textContent.length <= 40);
  assert.equal(element.innerHTML, "untouched", "setText only writes textContent");

  const source = fs.readFileSync(path.join(__dirname, "sandbox-detonate.cjs"), "utf8");
  assert.doesNotMatch(source, /\.innerHTML/, "this module has no HTML sink at all");
  assert.doesNotMatch(source, /readFileSync\(/, "no whole-file read on the main thread");
  assert.doesNotMatch(source, /openSync\(/, "no synchronous file hashing");

  // The report card's own words are the required ones.
  assert.match(card.lines.join("\n"), /heuristics, not a safety verdict/);
  assert.equal(card.findingsNote, "heuristics, not a safety verdict");
});

// ── 7. counts come from the REAL receipt fields ─────────────────────────────

/** A receipt shaped exactly like awdk's _sandbox_receipt over upstream's detonate JSON. */
function realReceipt(overrides = {}) {
  return {
    ok: true,
    command: "detonate",
    exit_code: 0,
    timed_out: false,
    findings_are: "heuristics, not a verdict",
    error: "",
    run_dir: path.join(RUNS, "run-2"),
    report: readReport(),
    data: {
      file: "sample.exe",
      hostPath: "C:\\Users\\t\\Downloads\\sample.exe",
      sha256: "b".repeat(64),
      tree: [{ pid: 10, depth: 0 }, { pid: 11, depth: 1 }, { pid: 12, depth: 1 }],
      lookups: [{ name: "example.test", ok: false }],
      connections: [{ address: "1.2.3.4", port: 443 }, { address: "5.6.7.8", port: 80 }],
      windows: [],
      crashes: [],
      findings: [{ level: "info", text: "the file dropped a marker on the desktop" }],
      diff: {
        files: { added: [{ path: "C:\\Windows\\System32\\Tasks\\Updater" }, { path: "C:\\Users\\WDAGUtilityAccount\\Desktop\\x.txt" }] },
        services: [{ name: "evil", change: "added" }, { name: "theirs", change: "removed" }],
        values: [{ name: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run\\x", change: "added" }],
      },
      ...overrides,
    },
  };
}

test("report counts are read from the real receipt fields and never invented", () => {
  const card = sandbox.reportCard({ ok: true, result: realReceipt() }, { root: RUNS, path });

  assert.deepEqual(card.counts, {
    processes: 3, lookups: 1, connections: 2, services: 1, persistence: 3, scheduled_tasks: 1, findings: 1,
  });
  assert.match(card.countLine, /Processes: 3/);
  assert.match(card.countLine, /Services added: 1/);
  assert.match(card.countLine, /Scheduled tasks: 1/);
  assert.match(card.countLine, /Persistence entries: 3/);

  const empty = sandbox.reportCard({
    ok: true,
    result: realReceipt({ tree: undefined, lookups: undefined, connections: undefined, findings: undefined, diff: undefined }),
  }, { root: RUNS, path });
  assert.deepEqual(empty.counts, {
    processes: null, lookups: null, connections: null, services: null, persistence: null, scheduled_tasks: null, findings: null,
  });
  assert.equal(empty.counts.processes, null, "an unreported count is null, not a fabricated zero");
  assert.match(empty.countLine, /Processes: not reported/);
  assert.equal(empty.openFolder, true, "the run folder the receipt names is offered");

  const noFolder = sandbox.reportCard({ ok: true, result: { ...realReceipt(), run_dir: null } }, { root: RUNS, path });
  assert.equal(noFolder.openFolder, false, "no run folder -> no Open folder button");
});

test("an empty diff is a reported zero, while a missing diff is 'not reported'", () => {
  const emptyDiff = sandbox.reportCard({
    ok: true,
    result: realReceipt({ diff: { files: { added: [] }, services: [], values: [] } }),
  }, { root: RUNS, path });
  assert.equal(emptyDiff.counts.persistence, 0, "an observed diff with nothing in it is a real 0");
});

/** awdk's CURRENT capped receipt: the summary it reports when the JSON is too big. */
function cappedReceipt(overrides = {}) {
  return {
    ok: true,
    command: "detonate",
    exit_code: 0,
    timed_out: false,
    run_dir: path.join(RUNS, "run-9"),
    sha256: "c".repeat(64),
    findings_are: "heuristics, not a verdict",
    error: "",
    counts: { processes: 14, lookups: 3, connections: 2, services: 0, persistence: 2, scheduled_tasks: 1, findings: 5 },
    truncated: true,
    preview: '{"ok": true, "command": "detonate", "data": {"tree": [',
    ...overrides,
  };
}

test("a capped receipt in awdk's CURRENT shape keeps its exit code, counts, digest and run folder", () => {
  const receipt = cappedReceipt();
  const card = sandbox.reportCard({ ok: true, result: receipt }, { root: RUNS, path, expectedSha256: receipt.sha256 });
  const text = card.lines.join("\n");

  assert.equal(card.capped, true);
  assert.equal(card.exitCode, 0, "the capped shape keeps exit_code");
  assert.match(text, /Exit 0/);
  assert.deepEqual(card.counts, receipt.counts, "the counts are awdk's own summary, verbatim");
  assert.match(card.countLine, /Processes: 14/);
  assert.match(card.countLine, /Scheduled tasks: 1/);
  assert.match(card.countLine, /Findings: 5/);
  assert.equal(card.digest.executed, receipt.sha256, "the digest comes from the capped receipt's own sha256");
  assert.equal(card.digest.match, true, "the digest comparison still fires on a capped receipt");
  assert.match(text, /matching the staged copy/);
  assert.equal(card.runDir, path.resolve(receipt.run_dir));
  assert.equal(card.openFolder, true, "Open folder is offered from run_dir");
  assert.match(text, /Report too large to show here; open the run folder\./);
  assert.match(text, /Run folder: .*run-9/);
  assert.doesNotMatch(text, /did not report a run folder/);
  assert.equal(card.guestText, "", "the JSON preview is never passed off as sandbox output");
});

test("a capped receipt whose digest differs from the card's still shouts", () => {
  const card = sandbox.reportCard({ ok: true, result: cappedReceipt() }, { root: RUNS, path, expectedSha256: "d".repeat(64) });

  assert.equal(card.digest.executed, "c".repeat(64));
  assert.equal(card.digestMismatch, true, "a capped receipt cannot hide a divergent digest");
  assert.match(card.lines.join("\n"), /DIGEST MISMATCH/);
});

test("an OLD capped receipt names the older awdk, and claims nothing else", () => {
  // The pre-fix shape: no run_dir, no exit_code, no counts, no sha256. The card
  // must not tell the owner to open a folder it simultaneously says does not exist.
  const card = sandbox.reportCard({
    ok: true,
    result: {
      ok: true,
      command: "detonate",
      truncated: true,
      preview: '{"ok": true, "command": "detonate", "data": {"tree": [',
      findings_are: "heuristics, not a verdict",
    },
  }, { root: RUNS, path });
  const text = card.lines.join("\n");

  assert.equal(card.capped, true);
  assert.equal(card.runDir, null);
  assert.equal(card.openFolder, false);
  assert.match(text, /Report too large; this awdk is older -- update it to see the run folder\./);
  assert.doesNotMatch(text, /Report too large to show here/, "never says 'open the run folder' when there is none");
  assert.doesNotMatch(text, /did not report a run folder/, "no second, contradictory line");
  assert.doesNotMatch(text, /Exit \?/, "an unknown exit code is named, not '?'");
  assert.match(text, /Exit: not reported/);
});

test("a truncated report.json says where the rest of it is", () => {
  const card = sandbox.reportCard({
    ok: true,
    result: { ...realReceipt(), report: { ...readReport(), found: true, path: "report.json", truncated: true } },
  }, { root: RUNS, path });
  assert.equal(card.reportTruncated, true);
  assert.match(card.lines.join("\n"), /report\.json was larger/);
});

// ── 8. Open folder: real paths, real containment ────────────────────────────

function realRuns(t) {
  const base = tempDir(t, "awdesk-runs-");
  const runs = path.join(base, "runs");
  fs.mkdirSync(runs);
  return { base, runs };
}

test("open folder refuses a path outside the runs root and never calls openPath", async (t) => {
  const { base, runs } = realRuns(t);
  const outer = path.join(base, "outside");
  fs.mkdirSync(outer);
  const opened = [];
  const opener = async (p) => { opened.push(p); return ""; };

  const outside = await sandbox.openRunFolder(outer, { root: runs, path, openPath: opener });
  assert.equal(outside.ok, false);
  assert.equal(outside.reason, "outside_runs_root");
  assert.deepEqual(opened, [], "shell.openPath was never reached");

  const traversal = await sandbox.openRunFolder(path.join(runs, "..", "outside"), { root: runs, path, openPath: opener });
  assert.equal(traversal.ok, false, "'..' is resolved before the containment check");
  assert.deepEqual(opened, []);
});

test("open folder opens a real run folder under the runs root", async (t) => {
  const { runs } = realRuns(t);
  const inside = path.join(runs, "2026-11-10T10-00-00");
  fs.mkdirSync(inside);
  const opened = [];
  const out = await sandbox.openRunFolder({ runDir: inside }, { root: runs, path, openPath: async (p) => { opened.push(p); return ""; } });

  assert.equal(out.ok, true);
  assert.deepEqual(opened, [fs.realpathSync(inside)]);
});

test("open folder refuses when the runs root or the target does not exist", async (t) => {
  const { base, runs } = realRuns(t);
  const opened = [];
  const opener = async (p) => { opened.push(p); return ""; };

  const noRoot = await sandbox.openRunFolder(path.join(base, "gone"), { root: path.join(base, "missing-root"), path, openPath: opener });
  assert.equal(noRoot.ok, false);
  assert.equal(noRoot.reason, "runs_root_missing");

  const noTarget = await sandbox.openRunFolder(path.join(runs, "gone"), { root: runs, path, openPath: opener });
  assert.equal(noTarget.ok, false);
  assert.equal(noTarget.reason, "no_such_folder");
  assert.deepEqual(opened, []);
});

test("open folder refuses a junction below the runs root, even one pointing back inside", {
  skip: process.platform !== "win32" ? "fs.symlinkSync(type 'junction') needs Windows" : false,
}, async (t) => {
  const { base, runs } = realRuns(t);
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  const inside = path.join(runs, "run-8");
  fs.mkdirSync(inside);
  const escape = path.join(runs, "run-7");
  const back = path.join(runs, "run-6");
  fs.symlinkSync(outside, escape, "junction");
  fs.symlinkSync(inside, back, "junction");
  t.after(() => {
    for (const link of [escape, back]) {
      try { fs.unlinkSync(link); } catch { /* already gone */ }
    }
  });
  const opened = [];
  const opener = async (p) => { opened.push(p); return ""; };

  const out = await sandbox.openRunFolder(escape, { root: runs, path, openPath: opener });
  assert.equal(out.ok, false, "a junction out of the root is never opened");
  assert.deepEqual(opened, []);

  const inward = await sandbox.openRunFolder(back, { root: runs, path, openPath: opener });
  assert.equal(inward.ok, false, "a junction is refused even when its target is inside");
  assert.equal(inward.reason, "reparse_point");
  assert.deepEqual(opened, []);
});

// ── 9. refusals happen BEFORE any copy or hash ──────────────────────────────

test("inspectTarget refuses a folder, a missing file, a relative path and an unsupported type", async (t) => {
  const { dir, file } = tempFile(t);
  assert.equal((await sandbox.inspectTarget(dir)).reason, "not_a_file");
  assert.equal((await sandbox.inspectTarget(path.join(dir, "nope.exe"))).reason, "path_missing");
  assert.equal((await sandbox.inspectTarget("sample.exe")).reason, "bad_path");
  assert.equal((await sandbox.inspectTarget("\\\\server\\share\\a.exe")).reason, "bad_path");
  assert.equal((await sandbox.inspectTarget(file)).ok, true);

  const zip = path.join(dir, "notes.zip");
  fs.writeFileSync(zip, Buffer.from("PK"));
  const refused = await sandbox.inspectTarget(zip);
  assert.equal(refused.reason, "unsupported_type", "sandbox-mcp cannot run a .zip");
  assert.match(refused.error, /\.exe/);
});

test("an unsupported extension is refused before anything is staged", async (t) => {
  const { dir } = tempFile(t);
  const zip = path.join(dir, "notes.zip");
  fs.writeFileSync(zip, Buffer.from("PK"));
  const { det, daemon, staging } = makeDetonator(t);

  const out = await det.request(zip);

  assert.equal(out.accepted, false);
  assert.equal(out.card.kind, "problem");
  assert.equal(out.card.reason, "unsupported_type");
  assert.deepEqual(daemon.calls, [], "the daemon never hears about a file it cannot run");
  assert.deepEqual(fs.readdirSync(staging), [], "no copy was made");
});

test("a file past the size cap is refused before it is read", async (t) => {
  const { file } = tempFile(t);
  const fakeFs = { statSync: () => ({ isFile: () => true, size: sandbox.MAX_STAGED_BYTES + 1 }) };
  const out = await sandbox.inspectTarget(file, { fs: fakeFs, path });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "too_large");
  assert.match(out.error, /2,147,483,648 bytes/);
});

test("the streamed copy aborts past its cap, and stageTarget leaves nothing behind", async (t) => {
  const { file } = tempFile(t, "big.exe", Buffer.alloc(4096, 1));
  const staging = tempDir(t, "awdesk-stage-");

  const out = await sandbox.stageTarget({ path: file, name: "big.exe" }, { token: "cap", root: staging, path, maxBytes: 1024 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "too_large");
  assert.deepEqual(fs.readdirSync(staging), [], "no partial copy and no request folder is left");
});

test("stageTarget writes a new file in its own per-request folder and hashes it", async (t) => {
  const { file, sha256 } = tempFile(t, "thing.exe", Buffer.from("staged bytes"));
  const staging = tempDir(t, "awdesk-stage-");

  const one = await sandbox.stageTarget({ path: file, name: "thing.exe" }, { token: "sbx-1", root: staging, path });
  const two = await sandbox.stageTarget({ path: file, name: "thing.exe" }, { token: "sbx-1", root: staging, path });

  assert.equal(one.ok, true);
  assert.equal(one.sha256, sha256);
  assert.equal(one.size, 12);
  assert.notEqual(one.dir, two.dir, "one subfolder per request, never a shared one");
  assert.equal(path.dirname(one.path), one.dir);
  sandbox.removeStaged({ staged: one.path, stagingDir: one.dir }, { fs });
  sandbox.removeStaged({ staged: two.path, stagingDir: two.dir }, { fs });
  assert.deepEqual(fs.readdirSync(staging), []);
});

test("stagedName keeps a plain name and the extension, and scrubs every character awdk refuses", () => {
  assert.equal(sandbox.stagedName("setup.exe"), "setup.exe", "a plain name is not renamed");
  assert.equal(sandbox.stagedName("Q&A Tools!.exe"), "Q_A Tools_.exe");
  assert.equal(sandbox.stagedName('a|b<c>d^e"f%g!.hta'), "a_b_c_d_e_f_g_.hta", "keeps the dispatch extension");
  assert.equal(sandbox.stagedName("run.cmd"), "run.cmd");
  for (const refused of ["&", "|", "<", ">", "^", '"', "%", "!"]) {
    assert.doesNotMatch(sandbox.stagedName(`x${refused}y.exe`), new RegExp(`\\${refused}`));
  }
});

test("a filename the sandbox refuses is staged under a safe name, with the ORIGINAL name on the card", async (t) => {
  const { dir } = tempFile(t);
  const original = path.join(dir, "Q&A Tools!.exe");
  fs.writeFileSync(original, Buffer.from("installer bytes"));
  const { det, daemon } = makeDetonator(t);

  const { card, accepted } = await det.request(original);

  assert.equal(accepted, true);
  assert.equal(card.name, "Q&A Tools!.exe", "the card still shows the file the owner picked, as text");
  assert.equal(card.stagedName, "Q_A Tools_.exe");
  assert.equal(path.basename(card.stagingPath), "Q_A Tools_.exe", "the copy awdk is handed carries no metacharacter");
  assert.match(path.basename(card.stagingPath), /^[A-Za-z0-9._ -]+$/, "nothing outside the safe charset");
  assert.equal(path.extname(card.stagingPath), ".exe", "the extension the sandbox dispatches on survives");
  assert.deepEqual(fs.readFileSync(card.stagingPath), fs.readFileSync(original), "the bytes are untouched");
  assert.match(card.lines.join("\n"), /Q&A Tools!\.exe/, "the original name is on the card");
  assert.deepEqual(daemon.calls, []);

  const out = await det.confirm(card.token);
  assert.equal(out.ran, true, "the click reaches a run instead of awdk's bad_args refusal");
  assert.equal(path.basename(daemon.detonate().args.target), "Q_A Tools_.exe");
});

// ── 10. one at a time ───────────────────────────────────────────────────────

test("a second request while one holds the slot gets a busy card, not a second call", async (t) => {
  const { file } = tempFile(t);
  const { det, daemon } = makeDetonator(t);

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
  const { det, daemon } = makeDetonator(t);

  const { token } = await det.request(file);
  await det.confirm(token);
  await det.confirm(token);

  assert.equal(daemon.calls.filter((c) => c.name === sandbox.TOOL_DETONATE).length, 1);
});

test("cancel frees the slot, removes the staged copy, and calls nothing", async (t) => {
  const { file } = tempFile(t);
  const { det, daemon } = makeDetonator(t);

  const { token, card } = await det.request(file);
  det.cancel(token);

  assert.equal(det.isBusy(), false);
  assert.deepEqual(daemon.calls, []);
  assert.equal(fs.existsSync(card.stagingPath), false, "the copy is removed on cancel");
});

// ── 11. a run that never happened is never a report ────────────────────────

/** A detonator whose doctor is ready and whose detonate call answers `detonateResult`. */
function failureDetonator(t, detonateResult) {
  const staging = tempDir(t, "awdesk-stage-");
  const runs = tempDir(t, "awdesk-runs-");
  const calls = [];
  const callTool = async (name) => {
    calls.push(name);
    if (name === sandbox.TOOL_DOCTOR) {
      return { ok: true, result: { ok: true, command: "doctor", exit_code: 0, timed_out: false, data: {}, report: readReport() } };
    }
    return detonateResult;
  };
  const det = sandbox.createSandboxDetonator({ callTool, staging, root: runs, path });
  return { det, calls };
}

test("daemon failures are problem cards titled 'The sandbox did not run', never a report with 'Exit ?'", async (t) => {
  const cases = [
    { name: "unreachable", result: { ok: false, reason: "unreachable", error: "daemon unreachable -- start it: adk harness serve" } },
    { name: "timeout", result: { ok: false, reason: "timeout", error: "desktop_sandbox_detonate did not answer in time" } },
    { name: "http 502", result: { ok: false, status: 502, reason: "http_502", error: "the daemon answered 502" } },
    { name: "bad_args", result: { ok: false, result: { ok: false, reason: "bad_args", error: "target must be a plain file path" } } },
    { name: "not_installed", result: { ok: false, reason: "not_installed", error: "desktop_sandbox_detonate is not installed" } },
  ];
  for (const one of cases) {
    const { file } = tempFile(t);
    const { det } = failureDetonator(t, one.result);
    const { token } = await det.request(file);
    const out = await det.confirm(token);
    const text = `${out.card.text || ""}\n${(out.card.lines || []).join("\n")}`;

    assert.equal(out.ran, false, one.name);
    assert.equal(out.card.kind, "problem", one.name);
    assert.equal(out.card.title, "The sandbox did not run", one.name);
    assert.doesNotMatch(text, /Exit \?/, `${one.name} must not look like a run with an unknown exit`);
    assert.doesNotMatch(text, /Sandbox report/, one.name);
    assert.match(text, /nothing ran/, `${one.name} says nothing ran`);
    assert.equal(out.card.action, null, one.name);
  }
});

test("a daemon that is down at the doctor step is a failure card, not a Windows Sandbox fix card", async (t) => {
  const { file } = tempFile(t);
  const staging = tempDir(t, "awdesk-stage-");
  const runs = tempDir(t, "awdesk-runs-");
  const det = sandbox.createSandboxDetonator({
    callTool: async () => ({ ok: false, reason: "unreachable", error: "daemon unreachable -- start it: adk harness serve" }),
    staging, root: runs, path,
  });

  const { token } = await det.request(file);
  const out = await det.confirm(token);

  assert.equal(out.ran, false);
  assert.equal(out.card.kind, "problem");
  assert.equal(out.card.title, "The sandbox did not run", "a dead daemon is not a disabled Windows feature");
});

test("a real run that exited non-zero is still a report, not a daemon failure", async (t) => {
  const { file } = tempFile(t);
  const receipt = {
    ok: false,
    command: "detonate",
    exit_code: 3,
    timed_out: false,
    data: { file: "thing.exe", tree: [], lookups: [], connections: [] },
    run_dir: path.join(RUNS, "run-4"),
    report: readReport(),
    findings_are: "heuristics, not a verdict",
    error: "the payload exited 3",
  };
  const { det } = failureDetonator(t, { ok: false, status: 200, result: receipt });

  const { token } = await det.request(file);
  const out = await det.confirm(token);

  assert.equal(out.ran, true, "ok:false with an exit code is a run, not a transport failure");
  assert.equal(out.card.kind, "report");
  assert.match(out.card.lines.join("\n"), /Exit 3/);
});

// ── path / size helpers ─────────────────────────────────────────────────────

test("sizeLabel is exact bytes first and a human scale second", () => {
  assert.match(sandbox.sizeLabel(0), /^0 bytes \(0\)$/);
  assert.match(sandbox.sizeLabel(1024), /1,024 bytes \(1\.0 KiB\)/);
});
