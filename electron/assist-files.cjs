"use strict";

/**
 * assist-files.cjs -- the Explorer verbs behind the "Aither" right-click entry on a file or
 * folder: summarize, ask, rename smartly, convert, send to the knowledge (Documents / Data)
 * pipeline, run a tool pack.
 *
 * The shell entry (shell-menu.cjs, HKCU, no admin) launches the desk with
 * `--run=assist.file.<verb> --arg=<path>`; this module is what the pop-up's file mode calls.
 *
 * Safety, in the order a reviewer should check it:
 *  - PATHS. One absolute drive path, no `..`, no wildcard, no `\\?\` prefix, must exist,
 *    and never inside the Windows / Program Files / ProgramData trees. Everything else the
 *    shell sends is refused before a byte is read.
 *  - NOTHING DESTRUCTIVE. Rename never overwrites (a taken name is refused), keeps the
 *    extension, stays in the same folder, and is undoable (the previous name is kept in
 *    memory for Undo). Convert writes a NEW file beside the original and never replaces one.
 *    There is no delete, no move-out, no overwrite verb. A bulk action (a whole folder into
 *    the knowledge pipeline) goes through a DECISION CARD: the owner answers on screen; no
 *    answer is not a yes, and a card that cannot be raised refuses the action.
 *  - UNTRUSTED CONTENT. File text goes to the model only as fenced screen data through the
 *    engine (assist-core), exactly like a selection. A model's suggested name is
 *    sanitized to a plain file name; it is never a path and never run.
 *  - LOGGED. Summarize / ask / name go through the engine (logged before they run); rename,
 *    convert, ingest and pack runs write their own started/outcome lines here.
 *  - BYOK / MicroScheduler. Model calls are the engine's (MicroScheduler, owner's model).
 *    Images are answered by the desk's vision ladder (orb-vision), which also tries
 *    MicroScheduler first.
 *
 * Electron-free; fs, exec, gateway and the card are injected.
 */

const fs = require("node:fs");
const path = require("node:path");
const core = require("./assist-core.cjs");

const READ_BYTES = 100000;
const TEXT_CHARS = core.MAX_SELECTION;
const FOLDER_LIST_MAX = 200;
const INGEST_MAX_FILES = 25;
const CONVERT_TIMEOUT_MS = 10 * 60 * 1000;

const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".log",
  ".xml", ".html", ".htm", ".css", ".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx", ".py", ".ps1", ".sh", ".bat",
  ".c", ".h", ".cpp", ".cs", ".java", ".go", ".rs", ".sql", ".rtf", ".srt", ".vtt", ".tex",
]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff"]);
/** Formats with no text extractor in the desk: refused BY NAME, never read as mojibake. */
const NO_EXTRACTOR = new Set([".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".odt", ".ods", ".epub", ".zip", ".7z", ".rar", ".gz", ".tar", ".mp3", ".wav", ".flac", ".ogg", ".mp4", ".mov", ".mkv", ".webm", ".exe", ".dll", ".iso"]);
/** Files a folder send must never carry to the platform, by name. */
const SECRET_NAME = /^(\.env.*|.*\.(pem|key|pfx|p12|kdbx|ppk|asc|gpg)|id_(rsa|dsa|ecdsa|ed25519).*|.*(secret|credential|password|token).*)$/i;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const BLOCKED_ROOTS = ["c:\\windows", "c:\\program files", "c:\\program files (x86)", "c:\\programdata"];

/** One absolute Windows path or null, with the reason it was refused. Pure given existsSync. */
function checkPath(raw, existsSync = fs.existsSync) {
  const first = String(Array.isArray(raw) ? raw[0] : raw || "").split(/\r?\n/)[0].trim().replace(/^"(.*)"$/, "$1");
  if (!first) return { ok: false, error: "No file or folder was given." };
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this strips
  if (!/^[A-Za-z]:\\[^<>"|?*\u0000-\u001f]*$/.test(first) || first.startsWith("\\\\?\\")) return { ok: false, error: "That is not a plain local path." };
  if (first.split("\\").some((p) => p === "..")) return { ok: false, error: "A path with .. is refused." };
  const norm = path.win32.normalize(first).replace(/[\\/]+$/, "");
  const lower = norm.toLowerCase();
  if (BLOCKED_ROOTS.some((b) => lower === b || lower.startsWith(`${b}\\`))) return { ok: false, error: "Aither does not touch Windows or Program Files." };
  let present;
  try { present = existsSync(norm.length === 2 ? `${norm}\\` : norm); } catch { present = false; }
  return present ? { ok: true, path: norm.length === 2 ? `${norm}\\` : norm } : { ok: false, error: "That file or folder is not there." };
}

/** A model-suggested name -> a plain file name stem, or "". Pure. */
function sanitizeName(suggestion, { maxLen = 100 } = {}) {
  let name = String(suggestion || "").split(/\r?\n/)[0] || "";
  name = name.replace(/^["'`\s]+|["'`\s]+$/g, "").replace(/\.[A-Za-z0-9]{1,5}$/, "");
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this strips
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/^[.\s]+|[.\s]+$/g, "").replace(/\s+/g, " ").trim();
  if (!name || RESERVED.test(name)) return "";
  return name.length > maxLen ? name.slice(0, maxLen).trim() : name;
}

/** The converters we can drive, by what the owner has installed. Pure data + argv builders. */
const CONVERSIONS = Object.freeze([
  { id: "png", label: "Image to PNG", from: [".jpg", ".jpeg", ".bmp", ".gif", ".webp", ".tif", ".tiff"], to: ".png", tools: ["magick", "ffmpeg"] },
  { id: "jpg", label: "Image to JPG", from: [".png", ".bmp", ".gif", ".webp", ".tif", ".tiff"], to: ".jpg", tools: ["magick", "ffmpeg"] },
  { id: "webp", label: "Image to WebP", from: [".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tif", ".tiff"], to: ".webp", tools: ["magick", "ffmpeg"] },
  { id: "mp3", label: "Audio / video to MP3", from: [".wav", ".flac", ".ogg", ".mp4", ".mov", ".mkv", ".webm", ".m4a"], to: ".mp3", tools: ["ffmpeg"] },
  { id: "mp4", label: "Video to MP4", from: [".mov", ".mkv", ".webm", ".avi"], to: ".mp4", tools: ["ffmpeg"] },
  { id: "md", label: "Document to Markdown", from: [".docx", ".html", ".htm", ".odt", ".epub", ".rtf"], to: ".md", tools: ["pandoc"] },
  { id: "html", label: "Markdown to HTML", from: [".md", ".markdown", ".docx", ".odt", ".txt"], to: ".html", tools: ["pandoc"] },
  { id: "txt", label: "Document to plain text", from: [".docx", ".html", ".htm", ".odt", ".epub", ".rtf"], to: ".txt", tools: ["pandoc"] },
]);

function conversionArgs(tool, input, output) {
  if (tool === "magick") return [input, output];
  // ffmpeg: only local files (a crafted playlist named .mp4 must not pull other files or URLs);
  // pandoc: --sandbox forbids it reading or writing anything beyond the two named files.
  if (tool === "ffmpeg") return ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-n", "-i", input, output];
  if (tool === "pandoc") return ["--sandbox", input, "-o", output];
  return null;
}

function uniqueOutput(input, ext, existsSync) {
  const dir = path.win32.dirname(input);
  const stem = path.win32.basename(input, path.win32.extname(input));
  let candidate = path.win32.join(dir, `${stem}${ext}`);
  for (let i = 1; i <= 50 && existsSync(candidate); i += 1) candidate = path.win32.join(dir, `${stem} (converted${i > 1 ? ` ${i}` : ""})${ext}`);
  return existsSync(candidate) ? null : candidate;
}

function createAssistFiles({
  fsImpl = fs, existsSync = (p) => fsImpl.existsSync(p), engine, gateway = null, vision = null, confirm = null, log = null,
  execFile = require("node:child_process").execFile, findExe = () => null, getSettings = () => ({}), now = Date.now, newId = null,
} = {}) {
  let counter = 0;
  const nextId = newId || (() => `f${now().toString(36)}${(counter += 1).toString(36)}`);
  const lastRename = { from: null, to: null };
  function linkNoClobber(from, to) {
    if (typeof fsImpl.linkSync === "function") { fsImpl.linkSync(from, to); fsImpl.unlinkSync(from); return; }
    if (existsSync(to)) { const e = new Error("exists"); e.code = "EEXIST"; throw e; }
    fsImpl.renameSync(from, to);
  }

  const note = (id, verb, outcome, ctx, extra, error) => {
    if (!log) return null;
    const r = log.append(core.logRecord({ id, surface: "explorer", verb, ctx: { app: "File Explorer", title: ctx && ctx.title }, settings: getSettings(), outcome, error, extra, now: now() }));
    return r && r.ok === false ? r.error : null;
  };

  /** What the pop-up shows for the shell's path, and the text the model may see. */
  function inspect(rawPath) {
    const v = checkPath(rawPath, existsSync);
    if (!v.ok) return v;
    let st;
    try { st = fsImpl.statSync(v.path); } catch { return { ok: false, error: "That file or folder is not readable." }; }
    const name = path.win32.basename(v.path) || v.path;
    if (st.isDirectory()) {
      let entries;
      try { entries = fsImpl.readdirSync(v.path, { withFileTypes: true }); } catch { return { ok: false, error: "That folder is not readable." }; }
      const lines = entries.slice(0, FOLDER_LIST_MAX).map((e) => `${e.isDirectory() ? "[dir] " : ""}${e.name}`);
      return { ok: true, kind: "dir", path: v.path, name, count: entries.length, text: lines.join("\n").slice(0, TEXT_CHARS), textable: true };
    }
    const ext = path.win32.extname(v.path).toLowerCase();
    const base = { ok: true, kind: "file", path: v.path, name, ext, size: st.size };
    if (IMAGE_EXT.has(ext)) return { ...base, image: true, textable: false };
    if (NO_EXTRACTOR.has(ext)) return { ...base, textable: false, why: `Aither has no text extractor for ${ext} files yet, so it will not guess at one.` };
    if (!TEXT_EXT.has(ext) && st.size > 0) {
      // Unknown extension: read a probe and accept only if it is clean UTF-8-looking text.
      try {
        const fd = fsImpl.openSync(v.path, "r");
        const buf = Buffer.alloc(Math.min(4096, st.size));
        fsImpl.readSync(fd, buf, 0, buf.length, 0);
        fsImpl.closeSync(fd);
        if (buf.includes(0)) return { ...base, textable: false, why: "That looks like a binary file." };
      } catch { return { ...base, textable: false, why: "That file is not readable." }; }
    }
    try {
      const fd = fsImpl.openSync(v.path, "r");
      const buf = Buffer.alloc(Math.min(READ_BYTES, st.size));
      fsImpl.readSync(fd, buf, 0, buf.length, 0);
      fsImpl.closeSync(fd);
      // eslint-disable-next-line no-control-regex -- control characters are exactly what this strips
      return { ...base, textable: true, text: buf.toString("utf8").replace(/\u0000/g, "").slice(0, TEXT_CHARS), truncated: st.size > READ_BYTES };
    } catch { return { ...base, textable: false, why: "That file is not readable." }; }
  }

  /** Model verbs on a file (summarize / ask / name) -> the engine, so they are logged and routed identically. */
  async function runVerb({ verb, info, prompt = "" }) {
    if (!info || !info.ok) return { ok: false, error: (info && info.error) || "No file." };
    if (info.image && vision && (verb === "summarize" || verb === "ask")) {
      const id = nextId();
      const failed = note(id, `file-${verb}`, "started", { title: info.name }, { kind: "image" });
      if (failed) return { ok: false, error: `Not run: the action log is not writable (${failed}).` };
      const q = verb === "ask" ? String(prompt).slice(0, 1000) : "Describe this image in a few plain sentences.";
      const res = await vision(info.path, q);
      note(id, `file-${verb}`, res.ok ? "ok" : "error", { title: info.name }, { kind: "image" }, res.ok ? undefined : res.error);
      return res.ok ? { ok: true, id, verb, kind: "answer", text: String(res.text || "").trim(), destination: `your vision model (${res.via || "scheduler"})` } : { ok: false, error: res.error || "Vision failed." };
    }
    if (!info.textable) return { ok: false, error: info.why || "Aither cannot read that kind of file." };
    return engine.run({ verb, ctx: { app: "File Explorer", title: info.name, selection: info.text }, prompt, surface: "explorer" });
  }

  /** "Rename smartly": ask the model for a name; return a PROPOSAL, apply nothing. */
  async function proposeRename(info) {
    if (!info || !info.ok || info.kind !== "file") return { ok: false, error: "Rename works on one file." };
    const res = await runVerb({ verb: "name", info });
    if (!res.ok) return res;
    const stem = sanitizeName(res.text);
    if (!stem) return { ok: false, error: "The model did not give a usable name. Try again." };
    const dir = path.win32.dirname(info.path);
    const to = path.win32.join(dir, `${stem}${info.ext || ""}`);
    return { ok: true, id: res.id, from: info.path, to, name: stem, extension: info.ext || "" };
  }

  /** Apply a proposal: same folder, same extension, never over an existing file. Undoable. */
  function applyRename({ from, name }) {
    const src = checkPath(from, existsSync);
    if (!src.ok || fsImpl.statSync(src.path).isDirectory()) return { ok: false, error: src.ok ? "Rename works on one file." : src.error };
    const stem = sanitizeName(name);
    if (!stem) return { ok: false, error: "That is not a usable file name." };
    const to = path.win32.join(path.win32.dirname(src.path), `${stem}${path.win32.extname(src.path)}`);
    if (to.toLowerCase() === src.path.toLowerCase()) return { ok: false, error: "That is already its name." };
    if (existsSync(to)) return { ok: false, error: `A file called ${path.win32.basename(to)} is already there. Nothing was changed.` };
    const id = nextId();
    const failed = note(id, "file-rename", "started", { title: path.win32.basename(src.path) }, { to: path.win32.basename(to) });
    if (failed) return { ok: false, error: `Not run: the action log is not writable (${failed}).` };
    // A hard link FAILS if the target exists (renameSync would silently replace it on Windows),
    // so the check-then-act race cannot clobber a file; then the old name is removed.
    try { linkNoClobber(src.path, to); } catch (error) {
      note(id, "file-rename", "error", { title: path.win32.basename(src.path) }, null, String(error.message || error));
      return { ok: false, error: `Windows refused the rename: ${error.code || error.message}` };
    }
    lastRename.from = src.path; lastRename.to = to;
    note(id, "file-rename", "ok", { title: path.win32.basename(src.path) }, { to: path.win32.basename(to) });
    return { ok: true, id, from: src.path, to };
  }

  function undoRename() {
    if (!lastRename.to) return { ok: false, error: "No rename to undo." };
    if (!existsSync(lastRename.to)) return { ok: false, error: "The renamed file is no longer there." };
    if (existsSync(lastRename.from)) return { ok: false, error: "The old name is taken now. Nothing was changed." };
    try { linkNoClobber(lastRename.to, lastRename.from); } catch (error) { return { ok: false, error: `Windows refused: ${error.code || error.message}` }; }
    note(nextId(), "file-rename", "undone", { title: path.win32.basename(lastRename.from) });
    const back = lastRename.from;
    lastRename.from = null; lastRename.to = null;
    return { ok: true, restored: back };
  }

  /** What this file can be converted to, with the tool that would do it (or why not). */
  function conversionsFor(info) {
    if (!info || !info.ok || info.kind !== "file") return [];
    return CONVERSIONS.filter((c) => c.from.includes(info.ext)).map((c) => {
      const tool = c.tools.find((t) => findExe(t));
      return { id: c.id, label: c.label, to: c.to, available: Boolean(tool), tool: tool || null, missing: tool ? "" : `Needs ${c.tools.join(" or ")} installed` };
    });
  }

  async function convert({ info, to }) {
    const options = conversionsFor(info);
    const choice = options.find((c) => c.id === String(to || ""));
    if (!choice) return { ok: false, error: "That conversion is not available for this file." };
    if (!choice.available) return { ok: false, error: `${choice.missing}. Aither runs the tool you install; it does not bundle one.` };
    const out = uniqueOutput(info.path, choice.to, existsSync);
    if (!out) return { ok: false, error: "Could not find a free file name for the result." };
    const exe = findExe(choice.tool);
    const args = conversionArgs(choice.tool, info.path, out);
    const id = nextId();
    const failed = note(id, "file-convert", "started", { title: info.name }, { to: path.win32.basename(out), tool: choice.tool });
    if (failed) return { ok: false, error: `Not run: the action log is not writable (${failed}).` };
    const res = await new Promise((resolve) => {
      try { execFile(exe, args, { timeout: CONVERT_TIMEOUT_MS, windowsHide: true, shell: false, maxBuffer: 1024 * 1024 }, (error, _o, stderr) => resolve({ error, stderr: String(stderr || "") })); } catch (error) { resolve({ error, stderr: "" }); }
    });
    if (res.error) {
      note(id, "file-convert", "error", { title: info.name }, null, res.stderr || String(res.error.message));
      return { ok: false, error: `${choice.tool} failed: ${(res.stderr || String(res.error.message || res.error)).slice(0, 300)}` };
    }
    note(id, "file-convert", "ok", { title: info.name }, { to: path.win32.basename(out), tool: choice.tool });
    return { ok: true, id, output: out, text: `Wrote ${path.win32.basename(out)} next to the original. The original is untouched.` };
  }

  /** Files of a folder that the knowledge pipeline may ingest (text-like, capped). */
  function ingestable(info) {
    if (info.kind === "file") return info.textable ? [{ path: info.path, name: info.name, text: info.text }] : [];
    const out = [];
    let entries;
    try { entries = fsImpl.readdirSync(info.path, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (out.length >= INGEST_MAX_FILES || e.isDirectory()) continue;
      const one = inspect(path.win32.join(info.path, e.name));
      if (SECRET_NAME.test(e.name)) continue;
      if (one.ok && one.kind === "file" && one.textable && one.size > 0) out.push({ path: one.path, name: one.name, text: one.text });
    }
    return out;
  }

  /** "Send to the Documents / Data pipeline": the knowledge ingest (rag_ingest) on the owner's platform. */
  async function sendToPipeline({ info }) {
    if (!gateway || typeof gateway.callTool !== "function") return { ok: false, error: "The AitherOS gateway is not connected on this PC." };
    const files = ingestable(info);
    if (!files.length) return { ok: false, error: info.why || "Nothing readable to send. PDFs and Office files need a text extractor first." };
    if (info.kind === "dir" || files.length > 1) {
      if (typeof confirm !== "function") return { ok: false, error: "A whole-folder send needs your approval card, and cards are not available." };
      const verdict = await confirm({
        title: `Send ${files.length} file${files.length === 1 ? "" : "s"} from ${info.name} to your knowledge base?`,
        summary: "Aither will read these files and add them to your own knowledge base (the Documents / Data pipeline). Nothing is deleted or changed on disk.",
        facts: [`${files.length} file${files.length === 1 ? "" : "s"}, ${files.reduce((n, f) => n + f.text.length, 0)} characters`, ...files.slice(0, 25).map((f) => f.name)],
        options: ["Send", "Do not send"],
      });
      if (verdict !== "Send") return { ok: false, error: "Not sent: no approval." };
    }
    const id = nextId();
    const failed = note(id, "file-pipeline", "started", { title: info.name }, { files: files.length });
    if (failed) return { ok: false, error: `Not run: the action log is not writable (${failed}).` };
    let sent = 0;
    let lastError = "";
    for (const f of files) {
      try {
        const r = await gateway.callTool("rag_ingest", { text: f.text, title: f.name });
        if (r && r.isError) lastError = (r.content && r.content[0] && r.content[0].text) || "rag_ingest failed";
        else sent += 1;
      } catch (error) { lastError = String((error && error.message) || error); }
    }
    note(id, "file-pipeline", sent ? "ok" : "error", { title: info.name }, { files: files.length, sent }, sent ? undefined : lastError);
    return sent ? { ok: true, id, text: `Sent ${sent} of ${files.length} file${files.length === 1 ? "" : "s"} to your knowledge base.${lastError ? ` Last error: ${lastError.slice(0, 120)}` : ""}` } : { ok: false, error: `Nothing was sent: ${lastError || "the pipeline refused"}` };
  }

  /** "Run a tool pack": hand the file to the owner's agent with the pack named. */
  async function runPack({ info, pack, agent }) {
    const name = String(pack || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(name)) return { ok: false, error: "Name the tool pack (letters, digits, dot, dash)." };
    if (!gateway || typeof gateway.callTool !== "function") return { ok: false, error: "The AitherOS gateway is not connected on this PC." };
    const id = nextId();
    const failed = note(id, "file-pack", "started", { title: info.name }, { pack: name });
    if (failed) return { ok: false, error: `Not run: the action log is not writable (${failed}).` };
    let res;
    try {
      res = await gateway.callTool("delegate_to_agent", { to_agent: String(agent || "aither"), task_type: "toolpack", description: `Run the tool pack "${name}" on this ${info.kind === "dir" ? "folder" : "file"}: ${info.path}. Read-only unless the pack says otherwise; ask the owner before changing or deleting anything.` });
    } catch (error) { res = { isError: true, content: [{ text: String((error && error.message) || error) }] }; }
    const text = res && res.content && res.content[0] && res.content[0].text ? String(res.content[0].text) : "";
    note(id, "file-pack", res && res.isError ? "error" : "ok", { title: info.name }, { pack: name }, res && res.isError ? text : undefined);
    return res && res.isError ? { ok: false, error: text || "The agent refused." } : { ok: true, id, text: text || `Sent to ${agent || "aither"} to run ${name}.` };
  }

  return { inspect, runVerb, proposeRename, applyRename, undoRename, conversionsFor, convert, sendToPipeline, runPack };
}

module.exports = {
  createAssistFiles, checkPath, sanitizeName, conversionArgs, uniqueOutput,
  CONVERSIONS, SECRET_NAME, TEXT_EXT, IMAGE_EXT, NO_EXTRACTOR, INGEST_MAX_FILES,
};
