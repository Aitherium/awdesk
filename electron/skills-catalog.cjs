"use strict";

/**
 * skills-catalog.cjs -- every agent skill on this machine (owner, 2026-10-04: "definitely
 * integrating awskills + awknowledge / codex / man pages"), for aither://bricks.
 *
 * A skill is a SKILL.md with `name:` / `description:` frontmatter (the awskills format
 * Claude Code and awsh load). Three roots, the same ones the agents read:
 *   - yours        ~/.claude/skills/<name>/SKILL.md
 *   - plugins      each installed Claude Code plugin (installed_plugins.json installPath)
 *                  <installPath>/skills/<name>/SKILL.md
 *   - projects     <repo>/.claude/skills/<name>/SKILL.md for the repos on the Projects page
 * A skill's text is read only from a path this catalog listed: the page never names a file.
 *
 * fs is injected, so it is asserted under node --test.
 */

const fsReal = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_SKILLS = 800;
const MAX_TEXT = 120_000;

/** name / description from YAML-ish frontmatter (folded `>` / `|` descriptions included). */
function frontmatter(text) {
  const m = String(text || "").match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(name|description):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][-+]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(" ");
    }
    out[kv[1]] = value.replace(/^["']|["']$/g, "");
  }
  return out;
}

function createSkillsCatalog({ fs = fsReal, home = os.homedir(), projectDirs = async () => [] } = {}) {
  let listed = new Set();

  function skillsIn(root, source) {
    const out = [];
    let names;
    try { names = fs.readdirSync(root); } catch { return out; }
    for (const n of names) {
      const file = path.join(root, n, "SKILL.md");
      let text;
      try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
      const fm = frontmatter(text);
      out.push({ name: String(fm.name || n).slice(0, 80), description: String(fm.description || "").slice(0, 400),
        source, path: file });
    }
    return out;
  }

  function pluginRoots() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), "utf8"));
    } catch {
      return [];
    }
    const plugins = (data && data.plugins) || {};
    const roots = [];
    for (const [id, installs] of Object.entries(plugins)) {
      for (const inst of [].concat(installs || [])) {
        if (inst && typeof inst.installPath === "string") roots.push({ dir: path.join(inst.installPath, "skills"), id });
      }
    }
    return roots;
  }

  async function list() {
    const rows = [...skillsIn(path.join(home, ".claude", "skills"), "yours")];
    for (const p of pluginRoots()) rows.push(...skillsIn(p.dir, `plugin ${p.id.split("@")[0]}`));
    let repos;
    try { repos = await projectDirs(); } catch { repos = []; }
    for (const repo of repos) rows.push(...skillsIn(path.join(repo, ".claude", "skills"), `repo ${path.basename(repo)}`));
    const seen = new Set();
    const unique = rows.filter((r) => (seen.has(r.path) ? false : seen.add(r.path))).slice(0, MAX_SKILLS);
    listed = new Set(unique.map((r) => r.path));
    return { ok: true, skills: unique };
  }

  function read(file) {
    const p = String(file || "");
    if (!listed.has(p)) return { ok: false, error: "not a skill this page listed" };
    try {
      return { ok: true, path: p, text: fs.readFileSync(p, "utf8").slice(0, MAX_TEXT) };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  return { list, read };
}

module.exports = { createSkillsCatalog, frontmatter };
