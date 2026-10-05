"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSkillsCatalog, frontmatter } = require("./skills-catalog.cjs");

function skill(root, dir, body) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, "SKILL.md"), body);
}

test("frontmatter: plain and folded descriptions", () => {
  assert.deepEqual(frontmatter("---\nname: a\ndescription: one line\n---\nbody"), { name: "a", description: "one line" });
  assert.equal(frontmatter("---\nname: b\ndescription: >\n  folded\n  text\n---\n").description, "folded text");
  assert.deepEqual(frontmatter("no frontmatter"), {});
});

test("skills from your dir, installed plugins and repos; a page reads only listed paths", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sk-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sk-repo-"));
  const plug = fs.mkdtempSync(path.join(os.tmpdir(), "sk-plug-"));
  skill(path.join(home, ".claude", "skills"), "mine", "---\nname: mine\ndescription: d1\n---\n");
  skill(path.join(plug, "skills"), "fromplug", "---\nname: fromplug\ndescription: d2\n---\n");
  skill(path.join(repo, ".claude", "skills"), "deploy", "---\nname: deploy\ndescription: d3\n---\nsteps");
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({ plugins: { "awsh@mkt": [{ installPath: plug }] } }));
  const cat = createSkillsCatalog({ home, projectDirs: async () => [repo] });
  const r = await cat.list();
  assert.deepEqual(r.skills.map((s) => [s.name, s.source]),
    [["mine", "yours"], ["fromplug", "plugin awsh"], ["deploy", `repo ${path.basename(repo)}`]]);
  const deploy = r.skills.find((s) => s.name === "deploy");
  assert.match(cat.read(deploy.path).text, /steps/);
  assert.equal(cat.read(path.join(home, ".ssh", "id_rsa")).ok, false, "never a path it did not list");
});
