"use strict";

/**
 * signed-approval -- approve a destructive decision card with a passkey
 * (Windows Hello on this box) instead of an unsigned `awask answer`.
 *
 * WHY. Genesis signs an owner receipt on POST /api/v1/decisions/{id}/answer only
 * for a fresh (<=15 min) webauthn/totp session (routers/decisions.py
 * `_signed_receipt`). awstorage refuses to apply a deletion/relocation approval
 * without that receipt. `awask answer` writes the card file directly and is
 * never signed, so the Deck's Approve on such a card recorded an answer that
 * approved NOTHING. For those cards the Approve opens Veil's /approve page in a
 * small window instead; Electron on Windows routes navigator.credentials.get()
 * to Windows Hello. Reject (and every ordinary card) still uses awask -- a
 * rejection needs no proof.
 *
 * AGENT APPROVALS. An agent-approval card (Genesis routers/agent_approvals.py raises it
 * as kind "info", dedupe key `agent-approval:<apr-id>`, no options) is decided on Veil's
 * /approvals?id=<apr-id> page. The desk offers ONE choice on it, "Review and confirm with
 * passkey", which opens that page in this same signed-in approve window: the approver
 * confirms with Windows Hello on the session the window already has (the passkey step-up,
 * lib/security/approval_stepup.py), never a second sign-in. The choice is never written
 * as a card answer; the card closes when the approval is decided.
 *
 * READ-ONLY on the card store: the card is read here only to decide the route;
 * the renderer's payload never decides whether a card is destructive.
 */

const fs = require("node:fs");
const path = require("node:path");

/** Card kinds whose approval a consumer verifies against a signed receipt. */
const SIGNED_ANSWER_KINDS = Object.freeze([
  "awstorage-manage",
  "awstorage-suggestion",
  "awstorage-relocate",
]);

/** Facts that bind a card to a proposal/plan a consumer will only apply when signed
 *  (awstorage manage.card_facts -> `proposal_id: <n>`; relocate -> `plan_id: <id>`). */
const SIGNED_FACT_KEYS = Object.freeze(["proposal_id", "plan_id"]);

/** Choice keys that decline: they need no proof and keep using awask. */
const DECLINE_KEYS = Object.freeze([
  "reject", "deny", "decline", "no", "cancel", "skip", "later", "dismiss",
  "ignore", "keep", "leave", "defer", "snooze",
]);

/** Session partition for the approve window: persistent, so the Veil login cookie
 *  (set by /api/me/webauthn/authenticate PUT) survives between approvals. */
const APPROVE_PARTITION = "persist:aither-approve";
// api.aitherium.com is the live Veil server; aitherium.com is the static export (no /api).
const DEFAULT_PORTAL_ORIGIN = "https://api.aitherium.com";

const CARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** The desk's one choice on an agent-approval card: open its page (never an answer). */
const AGENT_APPROVAL_CHOICE = "open-approval";
const AGENT_APPROVAL_OPTION = Object.freeze({
  key: AGENT_APPROVAL_CHOICE,
  label: "Review and confirm with passkey",
  consequence: "Opens the approval page; Windows Hello confirms it. Nothing is approved until you do.",
  recommended: true,
});
const APPROVAL_ID_RE = /^apr-[0-9a-f]{16}$/;

/** The approval id an agent-approval card is about, or "" for any other card. Read from
 *  the server-set dedupe key (`agent-approval:<id>`) of a card the agent-approvals router
 *  raised, never from its free text. */
function agentApprovalId(raw) {
  if (!raw || typeof raw !== "object") return "";
  const by = typeof raw.raised_by === "string" ? raw.raised_by : (typeof raw.via === "string" ? raw.via : "");
  if (by !== "agent-approvals") return "";
  const key = typeof raw.dedupe_key === "string" ? raw.dedupe_key : "";
  if (!key.startsWith("agent-approval:")) return "";
  const id = key.slice("agent-approval:".length);
  return APPROVAL_ID_RE.test(id) ? id : "";
}

/** /approvals?id=<apr-id> on the portal (Veil's agent-approval page). */
function agentApprovalUrl(approvalId, origin = portalOrigin()) {
  if (!APPROVAL_ID_RE.test(String(approvalId || ""))) throw new Error("not an approval id");
  const u = new URL("/approvals", origin);
  u.searchParams.set("id", String(approvalId));
  return u.toString();
}

/** true when `raw` (the card JSON) needs a SIGNED approval. */
function requiresSignedAnswer(raw) {
  if (!raw || typeof raw !== "object") return false;
  const kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
  if (SIGNED_ANSWER_KINDS.includes(kind)) return true;
  const facts = Array.isArray(raw.facts) ? raw.facts : [];
  return facts.some((f) => {
    if (typeof f !== "string") return false;
    const i = f.indexOf(":");
    if (i <= 0) return false;
    return SIGNED_FACT_KEYS.includes(f.slice(0, i).trim().toLowerCase());
  });
}

/** true when `choice` declines (reject/deny/...), case-insensitive. */
function isDeclineChoice(choice) {
  const c = String(choice || "").trim().toLowerCase();
  return DECLINE_KEYS.includes(c);
}

/**
 * Where an answer goes: "window" (signed, passkey page) or "awask" (unsigned).
 * Unknown/unreadable card -> "awask": the pre-existing behaviour, and the
 * consumer still refuses an unsigned approval, so failing open here cannot
 * approve anything by itself.
 */
function answerRoute(raw, choice) {
  // An agent-approval card's one desk choice opens its page; any other "answer" to it is
  // a plain card answer (it approves nothing: Genesis decides on the page only).
  if (agentApprovalId(raw) && String(choice || "") === AGENT_APPROVAL_CHOICE) return "agent-approval";
  if (!requiresSignedAnswer(raw)) return "awask";
  return isDeclineChoice(choice) ? "awask" : "window";
}

/** The raw card JSON for `id` from the store, or null. The id is validated so a
 *  renderer-supplied value can never name a path outside the store. */
function readCardRaw(id, dir, fsImpl = fs) {
  if (typeof id !== "string" || !CARD_ID_RE.test(id) || id.includes("..")) return null;
  try {
    const raw = JSON.parse(fsImpl.readFileSync(path.join(dir, `${id}.json`), "utf8"));
    return raw && typeof raw === "object" && raw.id === id ? raw : null;
  } catch {
    return null;
  }
}

/** The portal origin: $AITHER_PORTAL_ORIGIN when it is https (or http on loopback
 *  for dev), else https://api.aitherium.com. Never a path, never a credential. */
function portalOrigin(env = process.env) {
  const rawValue = String((env && env.AITHER_PORTAL_ORIGIN) || "").trim();
  if (!rawValue) return DEFAULT_PORTAL_ORIGIN;
  try {
    const u = new URL(rawValue);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.username || u.password) return DEFAULT_PORTAL_ORIGIN;
    if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) return u.origin;
  } catch {
    /* fall through */
  }
  return DEFAULT_PORTAL_ORIGIN;
}

/** /approve?card=<id>&choice=<key> on the portal. */
function approveUrl(id, choice, origin = portalOrigin()) {
  const u = new URL("/approve", origin);
  u.searchParams.set("card", String(id));
  u.searchParams.set("choice", String(choice));
  return u.toString();
}

/** Navigation the approve window may follow: the portal origin itself, or any
 *  https *.aitherium.com (the IdP sign-in hop). Everything else is refused. */
function isAllowedApproveNavigation(target, origin = portalOrigin()) {
  try {
    const u = new URL(target);
    if (u.origin === new URL(origin).origin) return true;
    return u.protocol === "https:" &&
      (u.hostname === "aitherium.com" || u.hostname.endsWith(".aitherium.com"));
  } catch {
    return false;
  }
}

/**
 * Open (or re-focus) the approve window. `BrowserWindow` is injected so tests
 * run without Electron. Default webPreferences keep WebAuthn working (the
 * sandbox does not block navigator.credentials; Windows Hello is the platform
 * authenticator); nodeIntegration stays off and there is no preload -- the page
 * is remote content and gets no bridge.
 *
 * @returns the window
 */
let _approveWindow = null;

/**
 * Put the desk's own session into the approve partition before the page loads.
 *
 * Owner, 2026-11-15: "why does [approving] still need me to login from scratch?"
 * The approve window has its own partition (persist:aither-approve) and nothing ever
 * signed it in: the desk session (auth.json, the token desk-session.cjs hands the
 * living-desktop window) never reached it, so every approval opened the full
 * Identity sign-in page. The passkey signature is still what approves; this only
 * skips the sign-in in front of it. Best-effort: a missing or expired desk token
 * leaves the window exactly as before (the page asks to sign in).
 *
 * @returns {Promise<boolean>} true when a cookie was set
 */
async function seedApproveSession({ session, readToken, cookieDetails, log = () => {} } = {}) {
  try {
    const tok = readToken && readToken();
    const token = tok && (typeof tok === "string" ? tok : tok.token);
    if (!token || !session || !cookieDetails) return false;
    const expiresAt = tok && typeof tok === "object" ? tok.expiresAt : null;
    await session.fromPartition(APPROVE_PARTITION).cookies.set(cookieDetails(token, { expiresAt }));
    return true;
  } catch (err) {
    log(`[approve] could not seed the desk session: ${err && err.message}`);
    return false;
  }
}

function openApproveWindow({ BrowserWindow, parent = null, url, origin = portalOrigin(), log = () => {}, seed = null }) {
  const go = (win) => {
    const load = () => win.loadURL(url);
    if (typeof seed === "function") {
      Promise.resolve(seed()).catch(() => false).then(load);
    } else {
      load();
    }
  };
  if (_approveWindow && !_approveWindow.isDestroyed()) {
    go(_approveWindow);
    _approveWindow.show();
    _approveWindow.focus();
    return _approveWindow;
  }
  const win = new BrowserWindow({
    width: 520,
    height: 640,
    resizable: true,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    title: "Approve with Windows Hello",
    ...(parent && !parent.isDestroyed?.() ? { parent } : {}),
    webPreferences: {
      partition: APPROVE_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, target) => {
    if (!isAllowedApproveNavigation(target, origin)) {
      log(`[approve] blocked navigation to ${target}`);
      event.preventDefault();
    }
  });
  win.on("closed", () => {
    if (_approveWindow === win) _approveWindow = null;
  });
  _approveWindow = win;
  go(win);
  return win;
}

module.exports = {
  seedApproveSession,
  AGENT_APPROVAL_CHOICE,
  AGENT_APPROVAL_OPTION,
  agentApprovalId,
  agentApprovalUrl,
  SIGNED_ANSWER_KINDS,
  SIGNED_FACT_KEYS,
  DECLINE_KEYS,
  APPROVE_PARTITION,
  DEFAULT_PORTAL_ORIGIN,
  requiresSignedAnswer,
  isDeclineChoice,
  answerRoute,
  readCardRaw,
  portalOrigin,
  approveUrl,
  isAllowedApproveNavigation,
  openApproveWindow,
};
