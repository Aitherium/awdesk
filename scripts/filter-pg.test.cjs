"use strict";

// The PG gate must FAIL a build it cannot judge, refuse a packaged tree that
// carries an adult-rated character, and never delete anything from the source
// tree it is pointed at.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "filter-pg.mjs");

function tree(context, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desk-pg-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = {
    name: "fixture",
    build: { files: ["dist/**/*", "electron/**/*.cjs", "package.json"] },
  };
  const all = { "package.json": JSON.stringify(pkg), ...files };
  for (const [rel, body] of Object.entries(all)) {
    if (body === null) continue;
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], {
    encoding: "utf8",
  });
}

test("a tree with no .pgship cannot be judged and fails the build", (context) => {
  const root = tree(context, { "public/assets/avatar.png": "png" });
  const result = run(root);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /\.pgship/);
});

test("an empty .pgship fails the build", (context) => {
  const root = tree(context, { ".pgship": "# only comments\n\n" });
  assert.notEqual(run(root).status, 0);
});

test("a clean tree passes", (context) => {
  const root = tree(context, {
    ".pgship": "src/**\npublic/**\n",
    "public/assets/avatar.png": "png",
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const rating of ["r15", "r18", "R18"]) {
  test(`a ${rating} character under public/ fails the build`, (context) => {
    const root = tree(context, {
      ".pgship": "public/**\n",
      "public/characters/mika/character.json": JSON.stringify({ rating }),
    });
    const result = run(root);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /mika/);
  });
}

test("an adult character in dist/ fails the post-build pass", (context) => {
  const root = tree(context, {
    ".pgship": "public/**\n",
    "dist/characters/mika/character.json": JSON.stringify({ rating: "r18" }),
  });
  assert.notEqual(run(root, "--dist").status, 0);
});

test("a packaged character directory with no rating is unjudged and fails", (context) => {
  const root = tree(context, {
    ".pgship": "public/**\n",
    "public/characters/mika/model.vrm": "vrm",
  });
  assert.notEqual(run(root).status, 0);
});

test("a builder files glob that packs characters/ fails the build", (context) => {
  const root = tree(context, {
    ".pgship": "public/**\n",
    "package.json": JSON.stringify({
      build: { files: ["dist/**/*", "characters/**/*"] },
    }),
  });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /characters/);
});

test("the unpackaged per-user characters/ roster is not judged", (context) => {
  // characters/ at the root is runtime state electron-builder never packs.
  const root = tree(context, {
    ".pgship": "public/**\n",
    "characters/mika/character.json": JSON.stringify({ rating: "r18" }),
  });
  assert.equal(run(root).status, 0);
});

test("the gate deletes nothing from the tree it judges", (context) => {
  // Install the script INSIDE the fixture (scripts/filter-pg.mjs) so a gate
  // that acts relative to its own directory -- as the old .pgignore/rmSync
  // version did -- would hit this tree, and this test would catch it.
  const root = tree(context, {
    ".pgship": "public/**\n",
    ".pgignore": "src\n",
    "src/keep.ts": "export {}",
    "public/characters/mika/character.json": JSON.stringify({ rating: "r18" }),
  });
  const local = path.join(root, "scripts", "filter-pg.mjs");
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.copyFileSync(SCRIPT, local);
  spawnSync(process.execPath, [local], { cwd: root, encoding: "utf8" });
  spawnSync(process.execPath, [local, "--root", root], { encoding: "utf8" });
  assert.ok(fs.existsSync(path.join(root, "src/keep.ts")));
  assert.ok(
    fs.existsSync(path.join(root, "public/characters/mika/character.json")),
  );
});

test("an animation clip (.vrma) is not an unrated character", (context) => {
  const root = tree(context, {
    ".pgship": "public/**\n",
    "public/assets/animations/wave.vrma": "vrma",
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("run through a symlink/junction the gate still judges (never 0 on silence)", (context) => {
  // import.meta.url is the realpath; argv[1] is the path as typed. An
  // entry-point guard comparing the two skipped main() and exited 0 silently.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "desk-pg-link-"));
  const real = path.join(base, "real");
  const link = path.join(base, "linked");
  const empty = path.join(base, "empty");
  fs.mkdirSync(path.join(real, "scripts"), { recursive: true });
  fs.mkdirSync(empty);
  fs.copyFileSync(SCRIPT, path.join(real, "scripts", "filter-pg.mjs"));
  fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
  context.after(() => {
    // Remove the link itself first so nothing recurses through it.
    try {
      fs.unlinkSync(link);
    } catch {
      fs.rmdirSync(link);
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  const result = spawnSync(
    process.execPath,
    [path.join(link, "scripts", "filter-pg.mjs"), "--root", empty],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /\.pgship/);
  assert.match(result.stderr, /package\.json/);
});

for (const [label, entry] of [
  ["a FileSet from characters/", { from: "characters", to: "characters" }],
  ["a root FileSet filtered to characters/", { from: ".", filter: ["characters/**/*"] }],
  ["a root FileSet with no filter", { from: "./" }],
]) {
  test(`${label} in build.files fails the build`, (context) => {
    const root = tree(context, {
      ".pgship": "public/**\n",
      "package.json": JSON.stringify({ build: { files: ["dist/**/*", entry] } }),
    });
    const result = run(root);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /characters/);
  });
}

test("a FileSet that packs something else is not refused", (context) => {
  const root = tree(context, {
    ".pgship": "public/**\n",
    "package.json": JSON.stringify({
      build: {
        files: ["dist/**/*"],
        win: { extraResources: [{ from: "native/bin/win32/x.exe", to: "x.exe" }] },
      },
    }),
  });
  assert.equal(run(root).status, 0);
});
