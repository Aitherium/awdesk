"use strict";

/**
 * secrets-client — the Secrets page's door: secret NAMES and masked hints from
 * the three scopes (platform vault, workspace, personal lockbox), through the
 * gateway MCP tools that already exist for them (mcp_secrets.py list_secrets,
 * mcp_workspace_secrets.py workspace_secrets_list, mcp_lockbox.py
 * lockbox_user_list). Transport: gateway-mcp.cjs only.
 *
 * 🚩 A VALUE MUST NEVER REACH THE RENDERER. The list tools say they return no
 * values, and that promise is theirs, not ours: list_secrets folds whatever the
 * vault answers ("secrets" OR "keys" OR the dict's own keys), and a vault that
 * one day answers [{name, value}] would hand a value straight to a page. So
 * every entry is REBUILT from an allowlist (sanitiseEntry): name, description,
 * tags, timestamps, and a hint that is masked HERE -- at most the last four
 * characters of a field that was already called a hint/mask, never anything
 * derived from a value-shaped field. There is no get_secret, no reveal and no
 * write on this page: reading a value is the MCP get_secret tool or Veil's
 * vault page, both of which carry their own audit.
 */

const { callTool } = require("./gateway-mcp.cjs");
const { parseToolJson } = require("./plane-client.cjs");

const SOURCES = Object.freeze([
  Object.freeze({ id: "platform", label: "Platform vault", tool: "list_secrets", args: Object.freeze({}) }),
  Object.freeze({ id: "workspace", label: "Workspace", tool: "workspace_secrets_list", args: Object.freeze({}) }),
  Object.freeze({ id: "personal", label: "Personal lockbox", tool: "lockbox_user_list", args: Object.freeze({}) }),
]);

const NAME_KEYS = Object.freeze(["name", "key", "secret_name", "secretName", "id"]);
const HINT_KEYS = Object.freeze(["hint", "masked", "masked_hint", "maskedHint", "mask", "last4"]);
const TIME_KEYS = Object.freeze({
  created: ["created_at", "createdAt", "created"],
  updated: ["updated_at", "updatedAt", "updated", "rotated_at"],
  accessed: ["last_accessed", "last_accessed_at", "lastAccessed", "accessed_at"],
});
const LIST_KEYS = Object.freeze(["secrets", "keys", "names", "items", "results", "data"]);
const MAX_ENTRIES = 2000;
const MASK = "••••";

function str(value, max = 200) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

/** A hint as the owner may see it: the mask plus at most the last 4 characters. */
function maskHint(raw) {
  const s = str(raw, 400);
  if (!s) return null;
  const tail = s.replace(/[•*·.…\s-]/g, "").slice(-4);
  return tail.length >= 2 && s.length > 4 ? MASK + tail : MASK;
}

function firstOf(obj, keys) {
  for (const k of keys) {
    const v = str(obj[k]);
    if (v) return v;
  }
  return null;
}

/**
 * Rebuild one listed secret from the allowlist. Anything not named here --
 * value, secret, plaintext, data, token, whatever a future server invents --
 * cannot come out, because nothing copies it.
 */
function sanitiseEntry(raw, fallbackName = null) {
  if (typeof raw === "string" || typeof raw === "number") {
    const name = str(raw);
    return name ? { name, hint: null, description: null, tags: [], created: null, updated: null,
      accessed: null } : null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const name = str(fallbackName);
    return name ? { name, hint: null, description: null, tags: [], created: null, updated: null,
      accessed: null } : null;
  }
  const name = firstOf(raw, NAME_KEYS) || str(fallbackName);
  if (!name) return null;
  const hintRaw = HINT_KEYS.map((k) => raw[k]).find((v) => str(v));
  const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => str(t, 40)).filter(Boolean).slice(0, 12) : [];
  return {
    name,
    hint: hintRaw === undefined ? null : maskHint(hintRaw),
    description: str(raw.description, 300),
    tags,
    created: firstOf(raw, TIME_KEYS.created),
    updated: firstOf(raw, TIME_KEYS.updated),
    accessed: firstOf(raw, TIME_KEYS.accessed),
  };
}

/** Every listed entry of one tool answer, whatever shape the list arrived in. */
function sanitiseList(answer) {
  let list = answer;
  if (answer && typeof answer === "object" && !Array.isArray(answer)) {
    const key = LIST_KEYS.find((k) => answer[k] !== undefined && answer[k] !== null
      && typeof answer[k] === "object");
    list = key ? answer[key] : [];
  }
  const out = [];
  if (Array.isArray(list)) {
    for (const item of list.slice(0, MAX_ENTRIES)) {
      const entry = sanitiseEntry(item);
      if (entry) out.push(entry);
    }
  } else if (list && typeof list === "object") {
    // {NAME: {...}} or {NAME: "<value>"}: the KEY is the name, the value is
    // looked at only for allowlisted metadata -- a bare string is dropped.
    for (const [name, meta] of Object.entries(list).slice(0, MAX_ENTRIES)) {
      const entry = sanitiseEntry(meta && typeof meta === "object" ? meta : null, name);
      if (entry) out.push(entry);
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function createSecretsClient({ call = callTool } = {}) {
  async function source(spec) {
    try {
      const answer = parseToolJson(spec.tool, await call(spec.tool, { ...spec.args }));
      const entries = sanitiseList(answer);
      return { id: spec.id, label: spec.label, tool: spec.tool, ok: true, entries, count: entries.length };
    } catch (error) {
      return { id: spec.id, label: spec.label, tool: spec.tool, ok: false,
        error: String((error && error.message) || error) };
    }
  }
  return {
    /** Every scope, in parallel; a failed scope is its own {ok:false, error}. */
    list: async () => {
      const sources = await Promise.all(SOURCES.map(source));
      return { at: new Date().toISOString(), sources, failed: sources.filter((s) => !s.ok).length };
    },
  };
}

module.exports = { createSecretsClient, sanitiseEntry, sanitiseList, maskHint, SOURCES, MASK };
