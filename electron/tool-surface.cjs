"use strict";

/**
 * tool-surface.cjs -- which place on the desk an agent's tool call belongs to.
 *
 * Owner, 2026-11-18: "fairies visibly GO DO WORK. When an agent uses a tool, its
 * fairy flies to the matching surface and back: file/library tools -> the File
 * Explorer window (or the Library app window), web research tools -> the desk
 * browser window / AitherBrowser, terminal/session-reading tools -> the terminal
 * window; parallel work SPLITS the fairy into small sub-fairies."
 *
 * The desk already learns what a session is running: the harness daemon's
 * /sessions/unified row carries `last_activity_summary = "running <tool>"`
 * (awdk/adk/harnesses/session_directory.py `_classify_pending`). This module turns
 * that tool name into ONE surface, so the renderer never guesses.
 *
 * PURE: no electron, no fs, no clock. node --test electron/tool-surface.test.cjs.
 */

const SURFACES = Object.freeze({
  FILES: "files",
  LIBRARY: "library",
  BROWSER: "browser",
  TERMINAL: "terminal",
  UNKNOWN: "unknown",
});

/** The window a surface lives in, in the owner's words (tooltips and tests). */
const SURFACE_LABELS = Object.freeze({
  files: "File Explorer",
  library: "Library",
  browser: "Browser",
  terminal: "Terminal",
  unknown: "",
});

/** Tool names that mean exactly one thing. Lower-case. */
const EXACT = Object.freeze({
  // terminal / session reading
  bash: "terminal",
  bashoutput: "terminal",
  killshell: "terminal",
  shell: "terminal",
  exec: "terminal",
  pwsh: "terminal",
  powershell: "terminal",
  terminal: "terminal",
  command: "terminal",
  ps: "terminal",
  top: "terminal",
  htop: "terminal",
  "system_processes": "terminal",
  "system_ports": "terminal",
  "system_connections": "terminal",
  "list_sessions": "terminal",
  "session_list": "terminal",
  "swarm_roster": "terminal",
  "swarm_status": "terminal",
  "run_command": "terminal",
  "execute_command": "terminal",
  // files
  read: "files",
  write: "files",
  edit: "files",
  multiedit: "files",
  notebookedit: "files",
  notebookread: "files",
  glob: "files",
  grep: "files",
  ls: "files",
  "desk_search": "files",
  "code_search": "files",
  "code_index": "files",
  "code_file": "files",
  "vcs_diff": "files",
  "vcs_blame": "files",
  "vcs_file_at": "files",
  // library / knowledge
  rag: "library",
  "search_knowledge": "library",
  "query_memory": "library",
  "recall": "library",
  "remember": "library",
  "forget_memory": "library",
  "agent_recall": "library",
  "agent_remember": "library",
  "unified_search": "library",
  // web research
  webfetch: "browser",
  websearch: "browser",
  "fetch_webpage": "browser",
  "web_extract": "browser",
  "web_peek": "browser",
  "search_web": "browser",
  "search": "browser",
  "research": "browser",
  "deep_research": "browser",
  "awbrowse": "browser",
  "dr_web_search": "browser",
  "dr_fetch_url": "browser",
  "dr_deep_research": "browser",
});

/**
 * Prefix rules, FIRST match wins. A whole family keeps its surface without listing
 * every member the way EXACT does, and the order settles the two real conflicts
 * (`graph_code_*` reads files, every other `graph_*` is the knowledge graph;
 * `storage_files_*` touches the disk, other `storage_*` is the Library).
 */
const PREFIX_RULES = Object.freeze([
  [/^codegraph_/, "files"],
  [/^graph_code_/, "files"],
  [/^storage_files_/, "files"],
  [/^file_/, "files"],
  [/^files_/, "files"],
  [/^fs_/, "files"],
  [/^awrtifact_/, "files"],
  [/^rag_/, "library"],
  [/^knowledge_/, "library"],
  [/^graph_kb_/, "library"],
  [/^graph_/, "library"],
  [/^memory_/, "library"],
  [/^awm_/, "library"],
  [/^workspace_memory_/, "library"],
  [/^notebooks_/, "library"],
  [/^library_/, "library"],
  [/^storage_/, "library"],
  [/^browser_/, "browser"],
  [/^chrome_/, "browser"],
  [/^pilot_/, "browser"],
  [/^web_/, "browser"],
  [/^http_/, "browser"],
  [/^har_/, "browser"],
  [/^terminal_/, "terminal"],
  [/^session_/, "terminal"],
  [/^sessions_/, "terminal"],
  [/^awsh_/, "terminal"],
  [/^command_/, "terminal"],
  [/^process_/, "terminal"],
]);

/** `mcp__<server>__<tool>` -> `<tool>` (the gateway's naming, not a new tool). */
function bareToolName(raw) {
  const text = String(raw == null ? "" : raw).trim();
  const mcp = /^mcp__[a-z0-9_.-]+?__(.+)$/i.exec(text);
  return (mcp ? mcp[1] : text).toLowerCase();
}

/**
 * The surface for a tool name: {surface, label, tool, family}.
 * `surface` is "unknown" for a name no rule knows (Task, TodoWrite, "tests"), and
 * its `label` is empty: callers say nothing rather than invent a destination.
 */
function classify(raw) {
  const name = bareToolName(raw);
  if (!name) return { surface: SURFACES.UNKNOWN, label: "", tool: "", family: "" };
  if (EXACT[name]) {
    const surface = EXACT[name];
    return { surface, label: SURFACE_LABELS[surface], tool: name, family: surface };
  }
  for (const [re, surface] of PREFIX_RULES) {
    if (re.test(name)) return { surface, label: SURFACE_LABELS[surface], tool: name, family: surface };
  }
  return { surface: SURFACES.UNKNOWN, label: "", tool: name, family: "" };
}

/** Convenience: just the surface string. */
function surfaceFor(raw) {
  return classify(raw).surface;
}

/**
 * A session row's `last_activity_summary` -> the running tool, or null.
 * The daemon writes exactly "running <tool>" (or "<tool> pending 2m -- may need
 * approval"), so only the `running` form is a live call. Ordinary prose such as
 * "running tests now" is NOT a tool call: its token classifies as unknown and is
 * dropped here, never flown to a made-up window.
 */
function parseRunning(text) {
  const line = String(text == null ? "" : text);
  const m = /^\s*running\s+([A-Za-z][\w:.$-]{0,80})(?:\s|$)/.exec(line);
  if (!m) return null;
  const raw = m[1];
  const hit = classify(raw);
  if (hit.surface === SURFACES.UNKNOWN) return null;
  return { tool: raw, name: hit.tool, surface: hit.surface, label: hit.label, text: line.trim().slice(0, 120) };
}

module.exports = { SURFACES, SURFACE_LABELS, classify, surfaceFor, parseRunning, bareToolName };
