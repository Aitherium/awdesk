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
 *  (awstorage manage.card_facts -> `proposal_id: <n>`; relocate -> `plan_id: <id>`;
 *  claude_permission_grant.py -> `permission_rule: <rule>`, applied only on a verified
 *  receipt). Without it a Grant went out unsigned and silently granted nothing
 *  (owner, 2026-11-10: "ok i did it" -- the card was still open). */
const SIGNED_FACT_KEYS = Object.freeze(["proposal_id", "plan_id", "permission_rule"]);

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

/* ---------------------------------------------------------------- local pages --
 * The approve window is NEVER left blank. 2026-11-18 the Aitherium API answered
 * 502/503 during a fleet restart and the owner got a white window with no word
 * of what failed, what he was approving, or what would happen. The window now
 * opens on a LOCAL summary page (the card's own title, the actions it runs, and
 * what approve vs reject does); the portal (and its Windows Hello prompt) loads
 * only from that page's Continue. A failed/5xx/timed-out portal load is replaced
 * by a local page saying so, with Retry, and the window retries with backoff.
 *
 * The local pages are data: URLs with no script and no bridge; their buttons are
 * links to DESK_ACTION_ORIGIN, which `will-navigate` intercepts and cancels. */

const DESK_ACTION_ORIGIN = "https://approve-desk.invalid";
const LOAD_TIMEOUT_MS = 10_000;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;
/** ERR_ABORTED: a load superseded by another loadURL (ours), not a failure. */
const ERR_ABORTED = -3;

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function htmlDataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** Backoff for the n-th automatic retry (0-based): 2 s, 4 s, 8 s, 16 s, then 30 s. */
function retryDelayMs(attempt) {
  const n = Math.max(0, Math.min(20, Number(attempt) || 0));
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** n);
}

function cleanText(v, max = 600) {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function findOption(raw, key) {
  const k = String(key || "").trim().toLowerCase();
  const options = Array.isArray(raw && raw.options) ? raw.options : [];
  return options.find((o) => o && typeof o.key === "string" && o.key.trim().toLowerCase() === k) || null;
}

/**
 * What the owner is approving, from the card the desk already holds (the store
 * file or the gateway's raw card -- the SAME object that routed the answer here).
 * `available: false` when there is no card: the window then says so and offers
 * no way on to the passkey prompt, rather than approving blind.
 */
function approvalSummary(raw, choice) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) {
    return { available: false, id: "", choice: String(choice || "") };
  }
  const chosen = findOption(raw, choice);
  const options = Array.isArray(raw.options) ? raw.options : [];
  const decline = options.find((o) => o && isDeclineChoice(o.key)) || null;
  // Each "key: value" fact is something the approval binds or runs (the rule it
  // grants, the proposal/plan it applies, the file it writes); free-text facts
  // ("Approve on app.aitherium.com ...") are instructions, not actions.
  const actions = (Array.isArray(raw.facts) ? raw.facts : [])
    .filter((f) => typeof f === "string" && /^[A-Za-z0-9_. -]{1,40}:\s*\S/.test(f.trim()))
    .map((f) => cleanText(f, 400))
    .slice(0, 12);
  return {
    available: true,
    id: raw.id,
    choice: String(choice || ""),
    title: cleanText(raw.title, 300) || raw.id,
    summary: cleanText(raw.summary, 900),
    actions,
    approveLabel: cleanText(chosen && chosen.label, 120) || String(choice || "Approve"),
    onApprove: cleanText(chosen && chosen.consequence, 400),
    rejectLabel: cleanText(decline && decline.label, 120) || "Reject",
    onReject: cleanText(decline && decline.consequence, 400) || "nothing changes",
  };
}

const PAGE_STYLE = `:root{color-scheme:dark}*{box-sizing:border-box}
html,body{margin:0;background:#050507;color:#EDEFF5;font:14px/1.5 "Inter","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
main{padding:20px 22px;display:flex;flex-direction:column;gap:12px}
h1{font-size:18px;margin:0}h2{font-size:12px;margin:0;text-transform:uppercase;letter-spacing:.06em;color:#9aa3b2}
p{margin:0;color:#c3c9d4}ul{margin:0;padding-left:18px}li{margin:2px 0;word-break:break-word}
.card{background:#111215;border:1px solid #23252b;border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:6px}
.warn{border-color:#c98a3a}.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}
a.btn{display:inline-block;padding:9px 16px;border-radius:10px;text-decoration:none;font-weight:600;background:#1b1d22;color:#EDEFF5;border:1px solid #23252b}
a.btn.primary{background:#5EC9CC;color:#050507;border-color:#5EC9CC}code{background:#151b26;padding:1px 5px;border-radius:5px;word-break:break-all}`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body><main>${body}</main></body></html>`;
}

/** The local page shown BEFORE the portal and its Windows Hello prompt. */
function summaryPageHtml(summary) {
  const s = summary || { available: false };
  if (!s.available) {
    return page("Approve with Windows Hello", `<h1>The desk cannot show what this approves</h1>
<div class="card warn"><p>The card${s.id ? ` <code>${escapeHtml(s.id)}</code>` : ""} could not be read, so there is no summary of what approving it would do. The desk will not send you to Windows Hello to approve something blind.</p>
<p>Nothing was approved. Open the card again once it shows on the desk.</p></div>
<div class="row"><a class="btn" href="${DESK_ACTION_ORIGIN}/close">Close</a></div>`);
  }
  const actions = s.actions.length
    ? `<ul>${s.actions.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`
    : "<p>The card lists no separate actions; approving answers it with your choice.</p>";
  return page("Approve with Windows Hello", `<h1>${escapeHtml(s.title)}</h1>
${s.summary ? `<p>${escapeHtml(s.summary).replace(/\n/g, "<br>")}</p>` : ""}
<div class="card"><h2>What it will run</h2>${actions}</div>
<div class="card"><h2>If you approve (${escapeHtml(s.approveLabel)})</h2>
<p>Windows Hello confirms it is you, Aitherium records a signed answer, and then: ${escapeHtml(s.onApprove || "the card's action runs")}. The card closes on the desk once the answer lands.</p></div>
<div class="card"><h2>If you reject (${escapeHtml(s.rejectLabel)})</h2>
<p>${escapeHtml(s.onReject)}. Rejecting needs no Windows Hello: close this window and choose ${escapeHtml(s.rejectLabel)} on the card.</p></div>
<div class="row"><a class="btn primary" href="${DESK_ACTION_ORIGIN}/continue">Continue to Windows Hello</a>
<a class="btn" href="${DESK_ACTION_ORIGIN}/close">Cancel</a></div>
<p>Nothing is approved until Windows Hello succeeds on the next page.</p>`);
}

/** The local page shown when the portal did not render. */
function fallbackPageHtml({ reason, retryInMs }) {
  const secs = Math.max(1, Math.round((Number(retryInMs) || 0) / 1000));
  return page("Approval page unreachable", `<h1>The approval page is unreachable</h1>
<div class="card warn"><p>The approval page is unreachable (${escapeHtml(reason)}). Nothing was approved.</p></div>
<p>The desk retries on its own while this window stays open (next try in about ${secs} s).</p>
<div class="row"><a class="btn primary" href="${DESK_ACTION_ORIGIN}/retry">Retry now</a>
<a class="btn" href="${DESK_ACTION_ORIGIN}/close">Close</a></div>`);
}

function deskAction(target) {
  try {
    const u = new URL(target);
    if (u.origin !== DESK_ACTION_ORIGIN) return null;
    const a = u.pathname.replace(/^\/+/, "");
    return ["continue", "retry", "close"].includes(a) ? a : null;
  } catch {
    return null;
  }
}

function cardFromUrl(url) {
  try {
    const u = new URL(url);
    return { id: u.searchParams.get("card") || "", choice: u.searchParams.get("choice") || "" };
  } catch {
    return { id: "", choice: "" };
  }
}

/**
 * Open (or re-focus) the approve window. `BrowserWindow` is injected so tests
 * run without Electron. Default webPreferences keep WebAuthn working (the
 * sandbox does not block navigator.credentials; Windows Hello is the platform
 * authenticator); nodeIntegration stays off and there is no preload -- the page
 * is remote content and gets no bridge.
 *
 * `card` is the raw card that routed the answer here; without it `readCard(id)`
 * is asked (the id comes from `url`). A card whose id is not the url's is not
 * summarised. `timers` is injectable for tests.
 *
 * @returns the window
 */
let _approveWindow = null;
function openApproveWindow({
  BrowserWindow, parent = null, url, origin = portalOrigin(), log = () => {},
  card = undefined, readCard = null, timers = { setTimeout, clearTimeout },
  loadTimeoutMs = LOAD_TIMEOUT_MS,
}) {
  const fromUrl = cardFromUrl(url);
  let raw = card;
  if (raw === undefined && typeof readCard === "function" && fromUrl.id) {
    try { raw = readCard(fromUrl.id); } catch { raw = null; }
  }
  const summary = approvalSummary(raw && raw.id === fromUrl.id ? raw : null, fromUrl.choice);
  if (!summary.available) summary.id = fromUrl.id;

  if (_approveWindow && !_approveWindow.isDestroyed() && _approveWindow.__approve) {
    _approveWindow.__approve.start(url, summary);
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
    backgroundColor: "#050507",
    title: "Approve with Windows Hello",
    ...(parent && !parent.isDestroyed?.() ? { parent } : {}),
    webPreferences: {
      partition: APPROVE_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const st = { url, summary, phase: "summary", attempt: 0, loadTimer: null, retryTimer: null, closed: false };
  const load = (target) => {
    try {
      const p = win.loadURL(target);
      if (p && typeof p.catch === "function") p.catch(() => {}); // failures arrive as did-fail-load
    } catch (err) {
      log(`[approve] loadURL threw: ${err && err.message}`);
    }
  };
  const clearTimers = () => {
    if (st.loadTimer) timers.clearTimeout(st.loadTimer);
    if (st.retryTimer) timers.clearTimeout(st.retryTimer);
    st.loadTimer = null;
    st.retryTimer = null;
  };
  // fail and loadPortal refer to each other, so fail is assigned below
  let fail;
  const loadPortal = () => {
    if (st.closed) return;
    clearTimers();
    st.phase = "portal";
    st.loadTimer = timers.setTimeout(() => {
      st.loadTimer = null;
      fail(`the Aitherium API did not answer within ${Math.round(loadTimeoutMs / 1000)} s`);
    }, loadTimeoutMs);
    load(st.url);
  };
  fail = (reason) => {
    if (st.closed || st.phase !== "portal") return;
    clearTimers();
    st.phase = "fallback";
    const delay = retryDelayMs(st.attempt);
    st.attempt += 1;
    log(`[approve] portal unreachable (${reason}); retry ${st.attempt} in ${delay} ms`);
    load(htmlDataUrl(fallbackPageHtml({ reason, retryInMs: delay })));
    st.retryTimer = timers.setTimeout(() => {
      st.retryTimer = null;
      loadPortal();
    }, delay);
  };
  const start = (nextUrl, nextSummary) => {
    clearTimers();
    st.url = nextUrl;
    st.summary = nextSummary;
    st.attempt = 0;
    st.phase = "summary";
    load(htmlDataUrl(summaryPageHtml(nextSummary)));
  };

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, target) => {
    const action = deskAction(target);
    if (action) {
      event.preventDefault();
      if (action === "close") win.close();
      else if (action === "continue" && st.phase === "summary" && st.summary.available) loadPortal();
      else if (action === "retry" && st.phase !== "summary") loadPortal();
      return;
    }
    if (!isAllowedApproveNavigation(target, origin)) {
      log(`[approve] blocked navigation to ${target}`);
      event.preventDefault();
    }
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    if (isMainFrame === false || errorCode === ERR_ABORTED) return;
    fail(`the Aitherium API did not answer: ${errorDescription || `error ${errorCode}`}`);
  });
  win.webContents.on("did-navigate", (_event, _navUrl, httpResponseCode) => {
    const code = Number(httpResponseCode) || 0;
    if (code >= 500) fail(`the Aitherium API answered ${code}`);
  });
  win.webContents.on("did-finish-load", () => {
    if (st.phase !== "portal") return;
    if (st.loadTimer) timers.clearTimeout(st.loadTimer);
    st.loadTimer = null;
    st.attempt = 0;
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    fail(`the approval page stopped (${(details && details.reason) || "renderer gone"})`);
  });
  win.on("closed", () => {
    st.closed = true;
    clearTimers();
    if (_approveWindow === win) _approveWindow = null;
  });
  win.__approve = { start, state: st };
  _approveWindow = win;
  start(url, summary);
  return win;
}

module.exports = {
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
  DESK_ACTION_ORIGIN,
  LOAD_TIMEOUT_MS,
  approvalSummary,
  summaryPageHtml,
  fallbackPageHtml,
  retryDelayMs,
};
