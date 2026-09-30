"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { ACTIONS, FleetControl, buildCommand, classify, parseVerdict, summarize, toDistroPath, ARC_ACTIONS,
  SERVICE_ACTIONS, DESTRUCTIVE, MODEL_ACTIONS, HOST_ACTIONS, distroName,
  ALIASES, VERB_ACTIONS, VERB_ACTION_NAMES, canonicalAction,
  TIMEOUT_MS, HOST_STEPS, hostStepCommand, mergeHostStep, holdIsStale } = require("./fleet-control.cjs");

test("toDistroPath maps a Windows path to the distro's /mnt view", () => {
  assert.equal(toDistroPath("C:\\AitherOS-Fresh\\.DEPLOYMENT\\scripts\\x.py"),
    "/mnt/c/AitherOS-Fresh/.DEPLOYMENT/scripts/x.py");
  assert.equal(toDistroPath("D:/desk/a.py"), "/mnt/d/desk/a.py");
  assert.equal(toDistroPath("/already/posix"), "/already/posix");
});

test("buildCommand crosses the WSL hop as ONE sh -c string and knows every action", () => {
  for (const action of Object.keys(ACTIONS)) {
    if (MODEL_ACTIONS.has(action) || HOST_ACTIONS.has(action) || VERB_ACTION_NAMES.has(action)) continue; // host-side by design; asserted in their own tests
    const cmd = buildCommand(action, { script: "C:\\x\\q.py", arcScript: "C:\\x\\arc.py", servicesScript: "C:\\x\\svc.py", distro: "awnix" });
    assert.equal(cmd.file, "wsl.exe");
    assert.deepEqual(cmd.args.slice(0, 6), ["-d", "awnix", "-u", "root", "sh", "-c"]);
    assert.equal(cmd.args.length, 7, "the whole invocation is the single sh -c argument");
    // ARC verbs run the ARC script; everything else the fleet script. One verb,
    // one script -- a desk button and an awsh command execute the same file.
    const expectScript = ARC_ACTIONS.has(action) ? /^python3 '\/mnt\/c\/x\/arc\.py' /
      : SERVICE_ACTIONS.has(action) ? /^python3 '\/mnt\/c\/x\/svc\.py' /
      : /^python3 '\/mnt\/c\/x\/q\.py' /;
    assert.match(cmd.args[6], expectScript);
    assert.match(cmd.args[6], / --json$/);
  }
  assert.match(buildCommand("arc-now", { arcScript: "C:\\x\\arc.py" }).args[6], / start --now 4 --json$/);
  assert.match(buildCommand("arc-stop", { arcScript: "C:\\x\\arc.py" }).args[6], / stop --json$/);
  assert.ok(DESTRUCTIVE.has("arc-stop"), "stopping the solver is a confirm-first verb");
  assert.ok(!DESTRUCTIVE.has("arc-now"), "running ARC is not destructive");
  assert.match(buildCommand("quiesce", { script: "C:\\x\\q.py" }).args[6], / quiesce --json$/);
  assert.throws(() => buildCommand("nuke"), /unknown fleet action/);
});

test("parseVerdict keeps the ROWS of a list verb, and rc 1 there is an answer", () => {
  // A list verb answers with a top-level ARRAY. Seeking "{" found the first row's brace
  // inside it and threw on the trailing "]", so the rc fallback returned
  // {ok:false,error:"exit 1"} and every row was lost in silence. rc 1 from
  // `list --unhealthy` means "found some", which is the answer, not a failure.
  const rows = '[\n  {"name": "aitheros-room", "status": "running", "health": "unhealthy"},\n'
    + '  {"name": "aither-llamacpp-bonsai", "status": "stopped", "health": "-"}\n]';
  const verdict = parseVerdict(rows, 1, "");
  assert.equal(verdict.ok, true, "rc 1 on a list is 'found some', not a failure");
  assert.equal(verdict.count, 2);
  assert.equal(verdict.rc, 1);
  assert.equal(verdict.rows[0].name, "aitheros-room");
  assert.equal(verdict.rows[1].status, "stopped");
  // An empty list is still a valid answer, not a cannot-judge.
  const none = parseVerdict("[]", 0, "");
  assert.equal(none.ok, true);
  assert.equal(none.count, 0);
});

test("parseVerdict: a wsl.exe failure is CANNOT JUDGE in plain words, never a bare exit code", () => {
  // wsl.exe exits -1 (4294967295 unsigned) when the distro cannot be started.
  const v = parseVerdict("", 4294967295, "");
  assert.equal(v.ok, false);
  assert.equal(v.cannotJudge, true);
  assert.equal(v.wslDown, true);
  assert.match(v.error, new RegExp(`${distroName()} WSL distro did not answer`));
  assert.doesNotMatch(v.error, /4294967295/);
  const named = parseVerdict("", 1, "Error code: Wsl/Service/CreateInstance/0x800705b4");
  assert.equal(named.cannotJudge, true);
  assert.match(named.error, /CreateInstance\/0x800705b4/);
  // An ordinary script failure is still an ordinary failure.
  const plain = parseVerdict("", 1, "podman: no such container");
  assert.equal(plain.cannotJudge, undefined);
  assert.equal(plain.error, "podman: no such container");
});

test("parseVerdict: JSON wins, rc 2 is CANNOT_JUDGE never ok, garbage is a refusal", () => {
  const ok = parseVerdict('progress noise\n{"ok": true, "fleet": {"running": 0}}', 0);
  assert.equal(ok.ok, true);
  assert.equal(ok.fleet.running, 0);
  const refused = parseVerdict('{"ok": false, "failed": [{"name": "x"}]}', 1);
  assert.equal(refused.ok, false);
  const cj = parseVerdict('{"error": "podman ps failed", "verdict": "CANNOT_JUDGE"}', 2);
  assert.equal(cj.ok, false);
  assert.equal(cj.cannotJudge, true);
  const dead = parseVerdict("", 2, "wsl: distro not found");
  assert.equal(dead.ok, false);
  assert.equal(dead.cannotJudge, true);
  assert.match(dead.error, /distro not found/);
  const garbage = parseVerdict("not json", 1, "boom");
  assert.equal(garbage.ok, false);
  assert.equal(garbage.cannotJudge, undefined);
  // a JSON doc with no ok field takes the exit code's word
  assert.equal(parseVerdict('{"vram": null}', 0).ok, true);
  assert.equal(parseVerdict('{"vram": null}', 1).ok, false);
});

test("classify derives the pill from reality, not the last button", () => {
  assert.equal(classify(null), "UNKNOWN");
  assert.equal(classify({ cannotJudge: true }), "UNKNOWN");
  assert.equal(classify({ fleet: { running: 0, masked: 207 }, held: true }), "DOWN");
  assert.equal(classify({ fleet: { running: 100, masked: 7 }, held: true }), "GPU QUIET");
  assert.equal(classify({ fleet: { running: 100, masked: 3 }, held: false }), "MIXED");
  assert.equal(classify({ fleet: { running: 112, masked: 0 }, held: false }), "UP");
  assert.equal(classify({ fleet: { running: 0, masked: 0 }, held: false }), "UNKNOWN",
    "0 running with nothing masked is not a fleet we understand");
});

test("a HOLD a reboot left behind is not GPU QUIET (awnix restart, 2026-09-28)", () => {
  // Live brain verdict after the maintenance restart: scope=all record, 141 running, 3/216 masked.
  const stale = { fleet: { running: 141, units: 216, masked: 3, scope: "all" }, held: true };
  assert.equal(holdIsStale(stale), true);
  assert.equal(classify(stale), "MIXED");
  assert.match(summarize(stale), /HOLD stale/);
  // a real fleet sleep: everything masked -> still DOWN; a gpu sleep (scope=game) -> GPU QUIET
  assert.equal(holdIsStale({ fleet: { running: 2, units: 216, masked: 208, scope: "all" }, held: true }), false);
  assert.equal(classify({ fleet: { running: 130, units: 216, masked: 11, scope: "game" }, held: true }), "GPU QUIET");
});

test("summarize is one readable line and names CANNOT JUDGE loudly", () => {
  const line = summarize({
    fleet: { running: 0, masked: 207, units: 207, scope: "all" },
    vram: { used_mib: 1850, total_mib: 32607 },
    held: true,
  });
  assert.match(line, /0 container\(s\) running/);
  assert.match(line, /207\/207 units masked/);
  assert.match(line, /GPU 1\.8\/32 GiB/);
  assert.match(line, /HOLD yes/);
  assert.match(line, /scope=all/);
  assert.match(summarize({ cannotJudge: true, error: "no distro" }), /CANNOT JUDGE — no distro/);
});

function fakeChild({ stdout = "", stderrLines = [], code = 0, delay = 5 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setTimeout(() => {
    for (const line of stderrLines) child.stderr.emit("data", Buffer.from(line + "\n"));
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", code);
  }, delay);
  return child;
}

test("FleetControl serialises actions: a second click while one runs is refused as busy", async () => {
  const spawned = [];
  const fc = new FleetControl({
    script: "C:\\x\\q.py",
    spawnImpl: (file, args) => {
      spawned.push(args[6]);
      return fakeChild({ stdout: '{"ok": true, "fleet_running_after": 0}', stderrLines: ["stopping ..."], delay: 30 });
    },
  });
  const progress = [];
  fc.on("progress", (p) => progress.push(p));
  const first = fc.run("down");
  assert.equal(fc.busy, "down");
  const second = await fc.run("up");
  assert.equal(second.ok, false);
  assert.equal(second.busy, "down");
  assert.match(second.error, /^busy: "down"/);
  const verdict = await first;
  assert.equal(verdict.ok, true);
  assert.equal(fc.busy, null);
  assert.equal(spawned.length, 1, "the refused click never spawned a process");
  assert.ok(progress.some((p) => p.phase === "run" && p.line === "stopping ..."), "stderr streams as progress");
  assert.equal(progress.at(-1).phase, "end");
});

test("FleetControl.status caches a fresh verdict and marks it busy during a long action", async () => {
  let calls = 0;
  const fc = new FleetControl({
    script: "C:\\x\\q.py",
    spawnImpl: (file, args) => {
      calls += 1;
      if ((args[6] || "").includes(" status ")) {
        return fakeChild({ stdout: '{"fleet": {"running": 5, "masked": 0}, "held": false}' });
      }
      return fakeChild({ stdout: '{"ok": true}', delay: 40 });
    },
  });
  const s1 = await fc.status();
  assert.equal(s1.fleet.running, 5);
  assert.equal(s1.ok, true);
  const s2 = await fc.status();
  assert.equal(calls, 1, "second status within maxAge is served from cache");
  assert.equal(s2, s1);
  const up = fc.run("up");
  const s3 = await fc.status({ maxAgeMs: 0 });
  assert.equal(s3.busy, "up", "status during an action reports the action, does not spawn a second probe");
  await up;
});

test("FleetControl: two concurrent status probes share one child and both get the verdict", async () => {
  let calls = 0;
  const fc = new FleetControl({
    script: "C:\\x\\q.py",
    spawnImpl: () => { calls += 1; return fakeChild({ stdout: '{"fleet": {"running": 0, "masked": 171}, "held": true}', delay: 30 }); },
  });
  const [a, b] = await Promise.all([fc.status({ maxAgeMs: 0 }), fc.status({ maxAgeMs: 0 })]);
  assert.equal(calls, 1, "the second probe joined the first instead of spawning or refusing");
  assert.equal(a.fleet.masked, 171);
  assert.equal(b, a);
  assert.equal(b.busy, undefined, "a joined status is never reported as busy");
  const c = await fc.run("status");
  assert.equal(calls, 2, "after it finished, a new run really probes again");
  assert.equal(c.ok, true);
});

test("FleetControl: an unknown action and a spawn failure are verdicts, never throws", async () => {
  const fc = new FleetControl({
    script: "C:\\x\\q.py",
    spawnImpl: () => { throw new Error("wsl.exe not found"); },
  });
  const bad = await fc.run("nuke");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown action/);
  const dead = await fc.run("status");
  assert.equal(dead.ok, false);
  assert.equal(dead.cannotJudge, true);
  assert.match(dead.error, /wsl\.exe not found/);
});

test("FleetControl: a status verdict is enriched from the HOST with who holds the VRAM and which doors answer", async () => {
  const fc = new FleetControl({
    script: "C:\\x\\q.py",
    spawnImpl: () => fakeChild({ stdout: '{"fleet": {"running": 0, "masked": 171, "units": 189}, "held": true, "vram": {"used_mib": 10413, "total_mib": 32607}}' }),
    gpuHolders: async () => ({ holders: [{ pid: 21084, name: "python", gib: 7.06, hint: "ComfyUI :8188 (Windows, not the fleet)", cmd: "" },
      { pid: 2876, name: "dwm", gib: 4.46, hint: "Windows desktop compositor", cmd: "" }], error: null }),
    surfaces: async () => [{ id: "pulse", label: "Pulse", up: true, detail: "HELD by owner" }, { id: "mcp", label: "MCP", up: false, detail: "ECONNREFUSED" }],
  });
  const st = await fc.run("status");
  assert.equal(st.gpu_holders.length, 2);
  assert.equal(st.surfaces.length, 2);
  assert.match(summarize(st), /GPU 10\.2\/32 GiB \(ComfyUI 7\.1, dwm 4\.5\)/);
  assert.match(summarize(st), /surfaces 1\/2 up \(down: mcp\)/);
  // A non-status action is never enriched, and a throwing probe never breaks the verdict.
  const fc2 = new FleetControl({
    script: "C:\\x\\q.py",
    spawnImpl: () => fakeChild({ stdout: '{"ok": true, "fleet": {"running": 0}}' }),
    gpuHolders: async () => { throw new Error("counters busy"); },
    surfaces: async () => { throw new Error("no network"); },
  });
  const adopt = await fc2.run("adopt");
  assert.equal("gpu_holders" in adopt, false);
  const st2 = await fc2.run("status");
  assert.deepEqual(st2.gpu_holders, []);
  assert.equal(st2.gpu_holders_error, "counters busy");
  assert.deepEqual(st2.surfaces, []);
  // A fake spawn with nothing injected gets NO host probes (tests never shell to powershell).
  const fc3 = new FleetControl({ script: "C:\\x\\q.py", spawnImpl: () => fakeChild({ stdout: '{"fleet": {"running": 1}}' }) });
  const st3 = await fc3.run("status");
  assert.equal("gpu_holders" in st3, false);
});

test("FleetControl: a CANNOT_JUDGE status retries once, and the retry's verdict wins", async () => {
  // Measured 2026-09-12: a load-54 window held the Fleet pane at "?" while the
  // fleet was UP (91 containers) -- podman ps has a 60 s timeout inside the
  // distro script and the spike passes in seconds, so one retry earns its keep.
  let calls = 0;
  const fc = new FleetControl({
    script: "C:/x/q.py",
    statusRetries: 1,
    retryDelayMs: 10,
    spawnImpl: () => {
      calls += 1;
      if (calls === 1) {
        return fakeChild({ stdout: '{"verdict": "CANNOT_JUDGE", "error": "podman ps timed out after 60 seconds"}', delay: 5 });
      }
      return fakeChild({ stdout: '{"fleet": {"running": 91, "masked": 0}, "held": false}', delay: 5 });
    },
  });
  const lines = [];
  fc.on("progress", (p) => lines.push(p.line));
  const st = await fc.run("status");
  assert.equal(calls, 2);
  assert.equal(st.cannotJudge, undefined, "the retry's good verdict replaced the failure");
  assert.equal(st.fleet.running, 91);
  assert.ok(lines.some((l) => /retrying in/.test(l)), "the retry is visible in the log");
});

test("FleetControl: an exhausted retry carries the last GOOD numbers as stale, cannotJudge stays loud", async () => {
  let calls = 0;
  const fc = new FleetControl({
    script: "C:/x/q.py",
    statusRetries: 1,
    retryDelayMs: 10,
    spawnImpl: () => {
      calls += 1;
      if (calls === 1) {
        return fakeChild({ stdout: '{"fleet": {"running": 91, "masked": 0}, "held": false, "vram": {"used_mib": 1000, "total_mib": 32607}}', delay: 5 });
      }
      return fakeChild({ stdout: '{"verdict": "CANNOT_JUDGE", "error": "podman ps timed out"}', delay: 5 });
    },
  });
  const good = await fc.run("status");
  assert.equal(good.fleet.running, 91);
  const st = await fc.run("status");
  assert.equal(st.cannotJudge, true, "could not look must stay LOUD -- never a healthy-looking verdict");
  assert.equal(st.stale.verdict.fleet.running, 91, "the last good numbers ride along, labeled");
  assert.ok(st.stale.age_ms >= 0);
  assert.match(st.stale.reason, /timed out/);
  assert.equal(calls, 3, "one retry was spent before the stale fallback");
});

test("FleetControl: no retry and no stale without a prior good status", async () => {
  let calls = 0;
  const fc = new FleetControl({
    script: "C:/x/q.py",
    statusRetries: 1,
    retryDelayMs: 10,
    spawnImpl: () => { calls += 1; return fakeChild({ stdout: '{"verdict": "CANNOT_JUDGE", "error": "no distro"}', delay: 5 }); },
  });
  const st = await fc.run("status");
  assert.equal(st.cannotJudge, true);
  assert.equal(st.stale, undefined, "nothing to be stale FROM");
  assert.equal(calls, 2, "the one retry still ran");
  // statusRetries=0 disables the patience entirely.
  let calls0 = 0;
  const fc0 = new FleetControl({
    script: "C:/x/q.py",
    statusRetries: 0,
    spawnImpl: () => { calls0 += 1; return fakeChild({ stdout: '{"verdict": "CANNOT_JUDGE"}', delay: 5 }); },
  });
  const s0 = await fc0.run("status");
  assert.equal(s0.cannotJudge, true);
  assert.equal(calls0, 1, "no patience configured, no retry spent");
});

test("model posture verbs run awmodels on the HOST and switches are confirm-first", () => {
  for (const action of MODEL_ACTIONS) {
    const cmd = buildCommand(action);
    assert.notEqual(cmd.file, "wsl.exe", `${action} must not cross the WSL hop`);
    assert.match(cmd.args[0], /awmodels\.py$/);
  }
  assert.deepEqual(buildCommand("models-status").args.slice(1), ["status", "--json"]);
  assert.deepEqual(buildCommand("models-full-mesh").args.slice(1), ["use", "full-mesh", "--yes", "--no-wait"]);
  for (const a of ["models-full-mesh", "models-pool-fast", "models-pool-lean"]) {
    assert.ok(DESTRUCTIVE.has(a), `${a} relaunches the pool: confirm first`);
  }
  assert.ok(!DESTRUCTIVE.has("models-status"), "reading status is not destructive");
});

test("fleet HOST verbs run fleet_host.py on the HOST; mutating ones are confirm-first", () => {
  for (const action of HOST_ACTIONS) {
    const cmd = buildCommand(action);
    assert.notEqual(cmd.file, "wsl.exe", `${action} must not cross the WSL hop`);
    assert.match(cmd.args[0], /fleet_host\.py$/);
    assert.equal(cmd.args[cmd.args.length - 1], "--json", "the window parses one JSON verdict");
  }
  assert.deepEqual(buildCommand("host-status").args.slice(1), ["status", "--json"]);
  assert.deepEqual(buildCommand("host-restart").args.slice(1), ["restart", "--execute", "--json"]);
  assert.ok(!buildCommand("host-migrate-dryrun").args.includes("--execute"), "the migrate verb is a dry run");
  for (const a of ["host-start", "host-stop", "host-restart", "host-reattach"]) {
    assert.ok(DESTRUCTIVE.has(a), `${a} changes the fleet host: confirm first`);
  }
  assert.ok(!DESTRUCTIVE.has("host-status"), "reading the host is not destructive");
});

test("critical (game on) is an alias of fleet critical: fleet_verbs runs `profile critical`", () => {
  const cmd = buildCommand("critical", { local: false });
  assert.notEqual(cmd.file, "wsl.exe", "host-side: fleet_verbs.py takes the lock and sequences the engine");
  assert.deepEqual(cmd.args.slice(1), ["fleet", "critical", "--execute", "--json"]);
  assert.deepEqual(buildCommand("critical").args, buildCommand("fleet-critical").args);
  assert.ok(DESTRUCTIVE.has("critical") && DESTRUCTIVE.has("fleet-critical"), "confirm first");
  assert.ok(TIMEOUT_MS["fleet-critical"] >= 1_200_000, "~30 units start one at a time to health");
  assert.ok(TIMEOUT_MS.critical >= 1_200_000);
});

test("the Fleet window has a Fleet critical button wired to the owner's verb", () => {
  const html = require("node:fs").readFileSync(require("node:path").join(__dirname, "fleet-control.html"), "utf8");
  assert.match(html, /data-action="fleet-critical"/);
  assert.match(html, /Fleet critical/);
  assert.match(html, /DESTRUCTIVE = new Set\(\[[^\]]*"fleet-critical"/);
});

test("the distro is resolved, never the retired literal", () => {
  const prev = process.env.AITHER_FLEET_DISTRO;
  process.env.AITHER_FLEET_DISTRO = "unit-fleet";
  try {
    assert.equal(distroName(), "unit-fleet");
    assert.deepEqual(buildCommand("status", { local: false }).args.slice(0, 2), ["-d", "unit-fleet"]);
  } finally {
    if (prev === undefined) delete process.env.AITHER_FLEET_DISTRO; else process.env.AITHER_FLEET_DISTRO = prev;
  }
});

test("model/host script defaults are real Windows paths (no JS escape ate a backslash)", () => {
  delete process.env.AWDESK_MODELS_SCRIPT;
  delete process.env.AWDESK_FLEET_HOST_SCRIPT;
  assert.match(buildCommand("models-status", { local: false }).args[0], /\\dev\\tools\\awmodels\.py$/);
  assert.match(buildCommand("host-status").args[0], /\\dev\\tools\\fleet_host\.py$/);
});

test("the owner's verbs run fleet_verbs.py on the HOST, and the old names are aliases of them", () => {
  const prev = process.env.AWDESK_FLEET_VERBS_SCRIPT;
  process.env.AWDESK_FLEET_VERBS_SCRIPT = "C:\\x\\fleet_verbs.py";
  try {
    const expect = {
      "gpu-sleep": ["gpu", "sleep", "--execute", "--json"],
      "gpu-wake": ["gpu", "wake", "--execute", "--json"],
      "fleet-sleep": ["fleet", "sleep", "--execute", "--json"],
      "fleet-wake": ["fleet", "wake", "--execute", "--json"],
      "fleet-critical": ["fleet", "critical", "--execute", "--json"],
      "verbs-status": ["status", "--json"],
    };
    for (const [action, argv] of Object.entries(expect)) {
      const cmd = buildCommand(action);
      assert.notEqual(cmd.file, "wsl.exe", `${action} is host-side: fleet_verbs picks the transport`);
      assert.deepEqual(cmd.args, ["C:\\x\\fleet_verbs.py", ...argv], action);
    }
    // old names: same argv as the verb they now mean (NOT the old quiesce --deep)
    for (const [old, verb] of Object.entries({ gaming: "gpu-sleep", resume: "gpu-wake", down: "fleet-sleep", up: "fleet-wake", critical: "fleet-critical" })) {
      assert.equal(ALIASES[old], verb);
      assert.equal(canonicalAction(old), verb);
      assert.deepEqual(buildCommand(old).args, buildCommand(verb).args, `${old} is an alias of ${verb}`);
    }
    assert.equal(canonicalAction("arc-stop"), "arc-stop");
  } finally {
    if (prev === undefined) delete process.env.AWDESK_FLEET_VERBS_SCRIPT;
    else process.env.AWDESK_FLEET_VERBS_SCRIPT = prev;
  }
  for (const a of ["gpu-sleep", "fleet-sleep", "fleet-critical", "gaming", "down"]) {
    assert.ok(DESTRUCTIVE.has(a), `${a} takes models or the fleet down: confirm first`);
  }
  for (const a of ["gpu-wake", "fleet-wake", "verbs-status"]) assert.ok(!DESTRUCTIVE.has(a), a);
  assert.ok(Object.keys(VERB_ACTIONS).every((a) => ACTIONS[a]), "every verb is a known action");
});

test("a fleet_verbs refusal (GPU access blocked, maintenance lock) reaches every renderer as the error", () => {
  const doc = { verb: "gpu-wake", ok: false, rc: 1, refused: "awnix reports \"GPU access blocked by the operating system\" -- ... maintenance restart" };
  const v = parseVerdict(JSON.stringify(doc), 1, "");
  assert.equal(v.ok, false);
  assert.match(v.error, /GPU access blocked/);
  assert.match(v.error, /maintenance restart/);
});

test("FleetControl.run(gaming) spawns fleet_verbs gpu sleep", async () => {
  const seen = [];
  const fc = new FleetControl({
    spawnImpl: (file, args) => { seen.push([file, args]); return fakeChild({ stdout: '{"verb":"gpu-sleep","ok":true,"rc":0}' }); },
  });
  const v = await fc.run("gaming");
  assert.equal(v.ok, true);
  assert.deepEqual(seen[0][1].slice(1), ["gpu", "sleep", "--execute", "--json"]);
});

// ── ComfyUI runs Windows-native (2026-09-27, #9828). The CORE (fleet_verbs.py) now runs its
// stop/start for the owner's verbs AND their old names, so every surface gets it and the
// desk must NOT run it a second time. ──

test("the old HOST_STEPS names are fleet_verbs aliases: the desk runs no ComfyUI step for them", () => {
  assert.deepEqual({ ...HOST_STEPS }, { gaming: "stop", down: "stop", resume: "start", up: "start" });
  for (const a of VERB_ACTION_NAMES) assert.equal(hostStepCommand(a), null, `${a}: the core does it`);
  assert.equal(hostStepCommand("status"), null);
  assert.equal(hostStepCommand("quiesce"), null, "a plain quiesce leaves ComfyUI alone");
});

test("mergeHostStep: a ComfyUI still holding the GPU fails GPU quiet; a slow start only warns", () => {
  const v1 = mergeHostStep({ ok: true }, { unit: "comfyui", verb: "stop", ok: false, state: "active", error: "still holds :8188" });
  assert.equal(v1.ok, false);
  assert.match(v1.error, /ComfyUI \(Windows\) not stopped: still holds :8188/);
  const v2 = mergeHostStep({ ok: true }, { unit: "comfyui", verb: "start", ok: false, state: "unknown", error: "x" });
  assert.equal(v2.ok, true);
  assert.match(v2.warnings[0], /ComfyUI \(Windows\): x/);
  assert.equal(mergeHostStep({ ok: true }, null).host_steps, undefined);
});

test("FleetControl gaming with host steps on: ONE spawn, fleet_verbs.py (ComfyUI rides inside it)", async () => {
  const seen = [];
  const fc = new FleetControl({
    hostSteps: true,
    spawnImpl: (file, args) => {
      seen.push(args[0]);
      return fakeChild({ stdout: '{"verb":"gpu-sleep","ok":true,"rc":0,"comfyui":{"state":"inactive","ok":true}}' });
    },
  });
  const v = await fc.run("gaming");
  assert.equal(v.ok, true);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /fleet_verbs\.py$/);
  assert.equal(v.host_steps, undefined, "no desk-side ComfyUI step");
});

test("in-host mode (desk running ON awnix under WSLg) runs the same string with no wsl.exe hop", () => {
  for (const action of Object.keys(ACTIONS)) {
    if (MODEL_ACTIONS.has(action) || VERB_ACTION_NAMES.has(action) || HOST_ACTIONS.has(action)) continue;
    const hop = buildCommand(action, { script: "C:\\x\\q.py", arcScript: "C:\\x\\arc.py", servicesScript: "C:\\x\\svc.py", local: false });
    const here = buildCommand(action, { script: "C:\\x\\q.py", arcScript: "C:\\x\\arc.py", servicesScript: "C:\\x\\svc.py", local: true });
    assert.equal(here.file, "sh");
    assert.deepEqual(here.args, ["-c", hop.args.at(-1)], `${action}: identical inner command, hop removed`);
  }
  const m = buildCommand("models-status", { local: true });
  assert.equal(m.file, process.env.AWDESK_PYTHON || "python3");
  assert.match(m.args[0], /^\/mnt\/c\/AitherOS-Fresh\/AitherOS\/dev\/tools\/awmodels\.py$/);
  if (!process.env.AWDESK_FLEET_VERBS_SCRIPT) {
    const g = buildCommand("gpu-sleep", { local: true });
    assert.equal(g.file, process.env.AWDESK_PYTHON || "python3");
    assert.deepEqual(g.args, ["/mnt/c/AitherOS-Fresh/AitherOS/dev/tools/fleet_verbs.py", "gpu", "sleep", "--execute", "--json"],
      "in-host: the same core at its /mnt path (it picks the local transport itself)");
  }
});

test("the default awmodels path is a real Windows path, not an escape-mangled one", () => {
  if (process.env.AWDESK_MODELS_SCRIPT) return;
  const m = buildCommand("models-status", { local: false });
  assert.equal(m.args[0], "C:\\AitherOS-Fresh\\AitherOS\\dev\\tools\\awmodels.py");
  assert.doesNotMatch(m.args[0], /\t/);
});

test("the hop targets the resolved fleet distro (fleet-distro.cjs owns the default)", () => {
  const { fleetDistro } = require("./fleet-distro.cjs");
  assert.deepEqual(buildCommand("status", { local: false }).args.slice(0, 2), ["-d", fleetDistro()]);
});

test("with the awnix brain configured, the owner's verbs still run host-side; status goes to the brain", async () => {
  const order = [];
  const mk = () => new FleetControl({
    hostSteps: true,
    brainUrl: "http://brain.test:1",
    brainToken: "t",
    fetchImpl: async () => { order.push("brain"); return { status: 200, json: async () => ({ ok: true }) }; },
    spawnImpl: (file, args) => {
      order.push(`host:${String(args[0]).split(/[\\/]/).pop()}`);
      return fakeChild({ stdout: '{"verb":"gpu-sleep","ok":true,"rc":0}' });
    },
  });
  const quiet = await mk().run("gaming");
  assert.deepEqual(order, ["host:fleet_verbs.py"], "the gaming lock, posture and ComfyUI live on Windows");
  assert.equal(quiet.ok, true);
  order.length = 0;
  await mk().run("gpu-wake");
  assert.deepEqual(order, ["host:fleet_verbs.py"]);
});
