"use strict";

/**
 * secrets-window.cjs — the Secrets page's standalone twin, and the owner of its IPC.
 *
 * Same shape as ops-window.cjs. ONE verb, a list: names and masked hints per
 * scope (secrets-client.cjs). There is no reveal, copy, set or delete verb on
 * this bridge, on purpose -- a value never crosses into a renderer, and the
 * page is a directory, not a vault client.
 *
 * Belt and braces: secrets-client already rebuilds every entry from an
 * allowlist; the handler then projects the answer onto ENTRY_FIELDS again, so a
 * future edit to the client that copies one field too many still cannot carry
 * it over the bridge. secrets-client.test.cjs asserts a planted value never
 * appears anywhere in what the handler returns.
 *
 * Error text is the one free-form field that crosses: a failed scope can carry
 * a slice of a Genesis response body (workspace_secrets_list quotes up to 500
 * chars). safeError() caps it at ERROR_MAX and masks anything token-shaped.
 */

const path = require("node:path");

function electron() {
  return require("electron");
}

const ENTRY_FIELDS = Object.freeze(["name", "hint", "description", "tags", "created", "updated", "accessed"]);
const SOURCE_FIELDS = Object.freeze(["id", "label", "tool", "ok", "error", "count"]);
const ERROR_MAX = 200;
// Token shapes (secret-safety.md) plus any long unbroken key-like run and
// `"value": "..."` pairs -- an error string is never trusted to be value-free.
const TOKEN_RE = new RegExp([
  "(sk-ant-|sk-|ghp_|ghs_|gho_|github_pat_|AKIA|pk_live_|sk_live_|xox[bp]-|aither_sk_)[A-Za-z0-9_\\-]{4,}",
  "[A-Za-z0-9+/_\\-]{32,}={0,2}",
].join("|"), "g");
const VALUE_RE = /("?(?:value|secret|password|token)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi;

/** A failed scope's error, safe to show: capped, token-shaped runs masked. */
function safeError(text) {
  const raw = String(text == null ? "" : text);
  const masked = raw.replace(VALUE_RE, "$1[redacted]").replace(TOKEN_RE, "[redacted]");
  return masked.length > ERROR_MAX ? `${masked.slice(0, ERROR_MAX - 1)}…` : masked;
}

let secretsWindow = null;
let wired = false;
let clientImpl = null;

function client() {
  if (!clientImpl) clientImpl = require("./secrets-client.cjs").createSecretsClient();
  return clientImpl;
}

async function answer(fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return { ok: false, error: safeError((error && error.message) || error) };
  }
}

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj && obj[f] !== undefined) out[f] = obj[f];
  return out;
}

/** The only shape that may leave main: allowlisted fields, scalars and string tags. */
function project(listing) {
  const sources = Array.isArray(listing && listing.sources) ? listing.sources : [];
  return {
    at: String((listing && listing.at) || ""),
    failed: Number(listing && listing.failed) || 0,
    sources: sources.map((s) => {
      const out = pick(s, SOURCE_FIELDS);
      if (out.error !== undefined && out.error !== null) out.error = safeError(out.error);
      if (Array.isArray(s.entries)) {
        out.entries = s.entries.map((e) => {
          const row = pick(e, ENTRY_FIELDS);
          for (const f of ENTRY_FIELDS) {
            if (f === "tags") row.tags = Array.isArray(row.tags) ? row.tags.filter((t) => typeof t === "string") : [];
            else if (row[f] !== null && row[f] !== undefined && typeof row[f] !== "string") row[f] = null;
          }
          return row;
        });
      }
      return out;
    }),
  };
}

/** The handler table, pure over an injected client so it is testable without Electron. */
function secretsHandlers(secrets = client()) {
  return {
    "desk:secrets-list": () => answer(async () => project(await secrets.list())),
  };
}

function ensureSecretsIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  for (const [channel, handler] of Object.entries(secretsHandlers())) ipcMain.handle(channel, handler);
}

function createSecretsWindow() {
  ensureSecretsIpc();
  const { BrowserWindow } = electron();
  if (secretsWindow && !secretsWindow.isDestroyed()) {
    secretsWindow.show();
    secretsWindow.focus();
    return secretsWindow;
  }
  secretsWindow = new BrowserWindow({
    width: 860,
    height: 680,
    minWidth: 520,
    minHeight: 420,
    show: false,
    title: "Aither Secrets",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "secrets-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  secretsWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  secretsWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  secretsWindow.once("ready-to-show", () => {
    secretsWindow.show();
    secretsWindow.focus();
  });
  secretsWindow.on("closed", () => {
    secretsWindow = null;
  });
  void secretsWindow.loadFile(path.join(__dirname, "secrets.html"));
  return secretsWindow;
}

function closeSecretsWindow() {
  if (secretsWindow && !secretsWindow.isDestroyed()) secretsWindow.close();
}

function isSecretsWindowOpen() {
  return Boolean(secretsWindow && !secretsWindow.isDestroyed());
}

module.exports = {
  safeError, ERROR_MAX,
  ensureSecretsIpc, createSecretsWindow, closeSecretsWindow, isSecretsWindowOpen, secretsHandlers,
  project, ENTRY_FIELDS,
};
