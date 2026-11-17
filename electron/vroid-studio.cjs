"use strict";

/**
 * vroid-studio.cjs -- "or create a new one using the VRoid Studio creator thing!" (owner,
 * 2026-11-17). VRoid Studio is a desktop app with no API, so the gallery's "Create new":
 *
 *   1. finds it (the official installer's %LOCALAPPDATA%\Programs\VRoidStudio\<version>\,
 *      Program Files, or any Steam library's steamapps\common\VRoid Studio) and launches it, or
 *      hands back the official download page when it is not installed;
 *   2. watches where an export lands (Downloads, Documents, Desktop, and VRoid's own folder in
 *      Documents) for a NEW .vrm, and imports each one into the roster UNASSIGNED and UNRATED
 *      (unrated counts as mature until he rates it -- the vision rater is not run: he is asked).
 *
 * Only files that appear AFTER the watch starts are imported (no backfill of an old Downloads
 * folder), each once, after its size has held still (an export is written in pieces).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DOWNLOAD_URL = "https://vroid.com/en/studio";
const STEAM_APP_URL = "steam://rungameid/1486350";
const EXE = "VRoidStudio.exe";

/** Steam library roots from libraryfolders.vdf text ("path" "D:\\SteamLibrary"). */
function steamLibraries(vdfText) {
  const out = [];
  const re = /"path"\s+"([^"]+)"/g;
  let m;
  while ((m = re.exec(String(vdfText || "")))) out.push(m[1].replace(/\\\\/g, "\\"));
  return out;
}

/** Newest version directory first: "2.14.0" > "2.9.1". */
function compareVersionsDesc(a, b) {
  const pa = String(a).split(".").map((n) => Number(n) || 0);
  const pb = String(b).split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Every place VRoidStudio.exe may live, most likely first. Pure given env + fs. */
function candidatePaths({ env = process.env, exists = fs.existsSync, readdir = fs.readdirSync, readFile = fs.readFileSync } = {}) {
  const out = [];
  const local = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const programs = path.join(local, "Programs", "VRoidStudio");
  try {
    for (const v of readdir(programs).sort(compareVersionsDesc)) out.push(path.join(programs, v, EXE));
  } catch { /* not installed this way */ }
  out.push(path.join(programs, EXE));
  for (const pf of [env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean)) {
    out.push(path.join(pf, "VRoid Studio", EXE));
  }
  const steamRoots = [path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Steam")];
  try {
    const vdf = readFile(path.join(steamRoots[0], "steamapps", "libraryfolders.vdf"), "utf8");
    for (const lib of steamLibraries(vdf)) if (!steamRoots.includes(lib)) steamRoots.push(lib);
  } catch { /* no Steam */ }
  for (const root of steamRoots) out.push(path.join(root, "steamapps", "common", "VRoid Studio", EXE));
  return out.filter((p, i) => out.indexOf(p) === i).map((p) => ({ path: p, steam: /steamapps/i.test(p) }))
    .filter((c) => {
      try { return exists(c.path); } catch { return false; }
    });
}

/** {installed, exe, steam} or {installed:false, downloadUrl}. */
function detect(deps = {}) {
  const found = candidatePaths(deps)[0];
  return found
    ? { installed: true, exe: found.path, steam: found.steam, downloadUrl: DOWNLOAD_URL }
    : { installed: false, exe: null, steam: false, downloadUrl: DOWNLOAD_URL };
}

/** Launch it (detached, no console). `project` is a .vroid file to open, when known. */
function launch({ spawn = require("node:child_process").spawn, project = "", ...deps } = {}) {
  const found = detect(deps);
  if (!found.installed) return { ok: false, ...found, reason: "VRoid Studio is not installed" };
  const args = project && /\.vroid$/i.test(project) && fs.existsSync(project) ? [project] : [];
  try {
    const child = spawn(found.exe, args, { detached: true, stdio: "ignore", windowsHide: false });
    if (child && typeof child.unref === "function") child.unref();
    return { ok: true, ...found };
  } catch (error) {
    return { ok: false, ...found, reason: `could not start VRoid Studio: ${error && error.message}` };
  }
}

/** Where an export is likely to land. */
function exportFolders({ home = os.homedir() } = {}) {
  return [
    path.join(home, "Downloads"),
    path.join(home, "Desktop"),
    path.join(home, "Documents"),
    path.join(home, "Documents", "VRoid"),
    path.join(home, "Documents", "VRoid Studio"),
  ];
}

/** A roster folder name for a file: lowercase slug, never empty. */
function slugFor(file) {
  const base = path.basename(String(file || ""), path.extname(String(file || "")))
    .normalize("NFKD").replace(/[^\w-]+/g, "-").replace(/_/g, "-").replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "").toLowerCase();
  return (base || "vroid-avatar").slice(0, 60);
}

/**
 * Watch the export folders. `onFile(fullPath)` fires once per NEW .vrm whose size held still
 * for `settleMs`. Returns {stop, seen}.
 */
function watchExports({ onFile, folders = exportFolders(), settleMs = 2500, watch = fs.watch, stat = fs.statSync, now = Date.now } = {}) {
  const startedAt = now();
  const seen = new Set();
  const pending = new Map();
  const watchers = [];
  const consider = (full) => {
    if (!/\.vrm$/i.test(full) || seen.has(full)) return;
    clearTimeout(pending.get(full));
    let size = -1;
    const check = () => {
      let st;
      try { st = stat(full); } catch { pending.delete(full); return; }
      if (st.mtimeMs < startedAt - 1000) { pending.delete(full); return; } // an old file: never backfill
      if (st.size > 0 && st.size === size) {
        pending.delete(full);
        seen.add(full);
        if (typeof onFile === "function") onFile(full);
        return;
      }
      size = st.size;
      pending.set(full, setTimeout(check, settleMs));
    };
    pending.set(full, setTimeout(check, settleMs));
  };
  for (const dir of folders) {
    try {
      const w = watch(dir, { persistent: false }, (_event, name) => {
        if (name) consider(path.join(dir, String(name)));
      });
      watchers.push(w);
    } catch { /* a folder that does not exist is simply not watched */ }
  }
  return {
    seen,
    consider,
    stop() {
      for (const w of watchers) try { w.close(); } catch { /* closed */ }
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
  };
}

/**
 * Import one exported .vrm into the roster: characters/<slug>/model.vrm + a character.json with
 * NO rating (unrated = mature until he rates it) and source "vroid-studio". A name already
 * taken gets a numeric suffix -- an import never overwrites a body he has.
 */
function importVrm(file, { rosterDir, now = () => new Date() } = {}) {
  if (!rosterDir || !fs.existsSync(file)) return { ok: false, reason: "no such file" };
  const base = slugFor(file);
  let name = base;
  for (let i = 2; fs.existsSync(path.join(rosterDir, name)); i += 1) name = `${base}-${i}`;
  const dir = path.join(rosterDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, path.join(dir, "model.vrm"));
  const display = path.basename(file, path.extname(file)).slice(0, 80);
  fs.writeFileSync(path.join(dir, "character.json"), JSON.stringify({
    display_name: display,
    source: "vroid-studio",
    imported_from: file,
    imported_at: now().toISOString(),
  }, null, 2));
  return { ok: true, name, display };
}

module.exports = {
  DOWNLOAD_URL,
  STEAM_APP_URL,
  steamLibraries,
  compareVersionsDesc,
  candidatePaths,
  detect,
  launch,
  exportFolders,
  slugFor,
  watchExports,
  importVrm,
};
