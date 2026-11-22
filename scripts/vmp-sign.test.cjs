"use strict";

/**
 * The VMP signing hook: off without AITHER_VMP_SIGN=1, the right hook per platform, the
 * exact EVS command, and a loud failure. The EVS service itself is never called here.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const v = require("./vmp-sign.cjs");

const ON = { AITHER_VMP_SIGN: "1" };

test("off unless AITHER_VMP_SIGN is exactly 1 (an empty CI secret stays off)", () => {
  for (const env of [{}, { AITHER_VMP_SIGN: "" }, { AITHER_VMP_SIGN: "0" }, { AITHER_VMP_SIGN: "true" }]) {
    assert.equal(v.vmpEnabled(env), false);
    const plan = v.vmpPlan({ hook: "afterSign", platform: "win32", appOutDir: "x", name: "Aither", env });
    assert.equal(plan.run, false);
    assert.match(plan.reason, /AITHER_VMP_SIGN/);
  }
  assert.equal(v.vmpEnabled(ON), true);
});

test("Windows signs in afterSign, macOS in afterPack (fuses first), Linux never", () => {
  const win = v.vmpPlan({ hook: "afterSign", platform: "win32", appOutDir: "out/win-unpacked", name: "Aither", env: ON });
  assert.equal(win.run, true);
  assert.equal(win.flipFuses, false);
  assert.equal(win.command, "python");
  assert.deepEqual(win.args, ["-m", "castlabs_evs.vmp", "--no-ask", "sign-pkg", "--name-hint", "Aither", "out/win-unpacked"]);
  assert.equal(v.vmpPlan({ hook: "afterPack", platform: "win32", appOutDir: "x", name: "Aither", env: ON }).run, false);

  const mac = v.vmpPlan({ hook: "afterPack", platform: "darwin", appOutDir: "out/mac-arm64", name: "Aither", env: ON });
  assert.equal(mac.run, true);
  assert.equal(mac.flipFuses, true, "the fuses live in the signed binary: flip before signing");
  assert.equal(mac.command, "python3");
  assert.equal(v.vmpPlan({ hook: "afterSign", platform: "darwin", appOutDir: "x", name: "Aither", env: ON }).run, false);

  for (const hook of ["afterPack", "afterSign"]) {
    const linux = v.vmpPlan({ hook, platform: "linux", appOutDir: "x", name: "desk", env: ON });
    assert.equal(linux.run, false);
    assert.match(linux.reason, /no VMP on linux/);
  }
});

test("credentials never reach the command line", () => {
  const env = { ...ON, EVS_ACCOUNT_NAME: "someone", EVS_PASSWD: "hunter2" };
  const plan = v.vmpPlan({ hook: "afterSign", platform: "win32", appOutDir: "x", name: "Aither", env });
  assert.equal(plan.args.join(" ").includes("hunter2"), false);
  assert.equal(plan.args.join(" ").includes("someone"), false);
});

test("the packaged app is found by name; asked to sign with none found is an error", () => {
  const exists = (p) => p === path.join("out", "Desk.exe") || p === path.join("mac", "Aither.app");
  assert.equal(v.packageName({ platform: "win32", appOutDir: "out", names: ["Aither", undefined, "Desk"], exists }), "Desk");
  assert.equal(v.packageName({ platform: "darwin", appOutDir: "mac", names: ["Aither"], exists }), "Aither");
  assert.equal(v.packageName({ platform: "win32", appOutDir: "out", names: ["Nope"], exists }), null);
  assert.throws(() => v.vmpPlan({ hook: "afterSign", platform: "win32", appOutDir: "out", name: null, env: ON }), /no packaged app/);
});

test("the Python can be overridden", () => {
  assert.equal(v.pythonCommand({ env: { AITHER_VMP_PYTHON: "/venv/bin/python" }, platform: "linux" }), "/venv/bin/python");
});

function fakeContext(platform, dir, flips) {
  return {
    electronPlatformName: platform,
    appOutDir: dir,
    packager: {
      appInfo: { productFilename: "Aither", productName: "Aither" },
      platformSpecificBuildOptions: { executableName: "Desk" },
      config: { electronFuses: { runAsNode: false } },
      generateFuseConfig: async (f) => ({ generated: f }),
      addElectronFuses: async (_ctx, f) => { flips.push(f); },
    },
  };
}

test("the hook: a no-op without the env var, and it never spawns", async () => {
  const spawned = [];
  const lines = [];
  const plan = await v.runHook("afterSign", fakeContext("win32", "nowhere", []), {
    env: {}, spawn: (...a) => { spawned.push(a); return { status: 0 }; }, log: (l) => lines.push(l),
  });
  assert.equal(plan.run, false);
  assert.equal(spawned.length, 0);
  assert.match(lines[0], /VMP signing skipped/);
});

test("the hook: signs, flips fuses first on macOS, and fails the build when EVS fails", async () => {
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vmp-sign-test-"));
  try {
    fs.writeFileSync(path.join(dir, "Aither.exe"), "x");
    fs.mkdirSync(path.join(dir, "Aither.app"));
    const spawned = [];
    const ok = (command, args) => { spawned.push([command, ...args]); return { status: 0 }; };
    const flips = [];
    await v.runHook("afterSign", fakeContext("win32", dir, flips), { env: ON, spawn: ok, log: () => {} });
    assert.deepEqual(spawned[0].slice(0, 7), ["python", "-m", "castlabs_evs.vmp", "--no-ask", "sign-pkg", "--name-hint", "Aither"]);
    assert.equal(flips.length, 0, "Windows: electron-builder already flipped the fuses");

    await v.runHook("afterPack", fakeContext("darwin", dir, flips), { env: ON, spawn: ok, log: () => {} });
    assert.deepEqual(flips, [{ generated: { runAsNode: false } }]);
    assert.equal(spawned.length, 2);

    await assert.rejects(
      v.runHook("afterSign", fakeContext("win32", dir, []), { env: ON, spawn: () => ({ status: 1 }), log: () => {} }),
      /EVS refused or failed/,
    );
    await assert.rejects(
      v.runHook("afterSign", fakeContext("win32", dir, []), { env: ON, spawn: () => ({ error: new Error("ENOENT") }), log: () => {} }),
      /pip install --upgrade castlabs-evs/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("package.json: the castLabs build, its download mirror, and both hooks are configured", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.match(pkg.devDependencies.electron, /castlabs\/electron-releases.*#v\d+\.\d+\.\d+\+wvcus$/);
  assert.equal(pkg.build.electronDownload.mirror, "https://github.com/castlabs/electron-releases/releases/download/");
  assert.equal(pkg.build.afterPack, "scripts/vmp-sign.cjs");
  assert.equal(pkg.build.afterSign, "scripts/vmp-sign.cjs");
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package-lock.json"), "utf8"));
  assert.match(lock.packages["node_modules/electron"].version, /\+wvcus$/, "the lockfile must pin the castLabs build too");
  const plist = fs.readFileSync(path.join(__dirname, "..", "build", "entitlements.mac.plist"), "utf8");
  assert.match(plist, /com\.apple\.security\.cs\.disable-library-validation/, "macOS cannot load the Widevine CDM without it");
});
