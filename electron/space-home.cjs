"use strict";

/**
 * space-home.cjs -- where the Inbox and Fleet doors lead when BeadSpace is home.
 *
 * Owner, 2026-10-15: the Inbox is a long list and the rail is "too menu-menu"; the
 * platform should be ONE explorable space (aither://space/). This is the reversible
 * half of that move: `overlay.spaceHome` in cast.json (default false). Off, every door
 * goes exactly where it went before. On, the bell, the needs-you line and the rail's
 * Inbox row open the Space on the next ask, and the rail's Fleet row opens it on the
 * fleet galaxy. The list Inbox is NOT retired here -- the owner signs that off.
 *
 * Pure: no electron, no fs. Main and the browser ask it for a URL; a null means
 * "do what you did before" -- also the answer when this desk build has no Space pane,
 * so turning the setting on can never strand a door on a 404.
 */

const SCHEME = "aither";
const SPACE_PANE = "space";

/** Contract U1 id grammar: what `at=` and `card=` may carry. */
const OBJECT_ID = /^(platform|[a-z]+:[A-Za-z0-9._/@:-]{1,160})$/;
/** A decision card id: the SAME grammar the Space pane accepts (space-model.ts CARD_RE);
 *  awask ids are d-xxxx. Anything else gets no card link (the door falls back to next). */
const CARD_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** The doors this module re-routes, by console pane id. */
const INBOX_PANES = Object.freeze(["cards", "inbox"]);
const FLEET_PANE = "fleet";
const FLEET_GALAXY = "galaxy:fleet";

function paneQuery(pane) {
  return pane && typeof pane.query === "string" && pane.query ? [pane.query] : [];
}

/** aither://space/?<pane flag>&<params> -- the pane's own view flag first, if it has one. */
function spaceUrl(params, pane = null) {
  const parts = [...paneQuery(pane), ...params];
  return `${SCHEME}://${SPACE_PANE}/${parts.length ? `?${parts.join("&")}` : ""}`;
}

/** The Space on the next thing that needs the owner. */
function nextLink(pane = null) {
  return spaceUrl(["focus=next"], pane);
}

/** The Space centred on one universe object (contract U1 id), or null for a bad id. */
function atLink(objectId, pane = null) {
  const id = String(objectId || "");
  if (!OBJECT_ID.test(id)) return null;
  return spaceUrl([`at=${id}`], pane); // the grammar admits only query-safe characters
}

/** The Space on one decision card, or null for a bad id. */
function cardLink(cardId, pane = null) {
  const id = String(cardId || "");
  if (!CARD_ID.test(id)) return null;
  return spaceUrl([`card=${id}`], pane); // ditto: CARD_ID is query-safe
}

function fleetLink(pane = null) {
  return atLink(FLEET_GALAXY, pane);
}

/**
 * Where a door should go instead of its old pane, or null for "exactly as today".
 *
 * @param {string} paneId          the console pane the door used to open ("cards", "fleet")
 * @param {object} opts
 * @param {boolean} opts.spaceHome  cast.json overlay.spaceHome
 * @param {object|null} opts.spacePane  the Space pane record, or null when this build has none
 * @param {string|null} [opts.cardId]   a specific card the door was opened for
 */
function spaceTarget(paneId, { spaceHome = false, spacePane = null, cardId = null } = {}) {
  if (spaceHome !== true || !spacePane) return null;
  const id = String(paneId || "");
  if (INBOX_PANES.includes(id)) {
    // A row that named its card lands on that card; the bell and the rail land on "next".
    return (cardId && cardLink(cardId, spacePane)) || nextLink(spacePane);
  }
  if (id === FLEET_PANE) return fleetLink(spacePane);
  return null;
}

/**
 * A Space deep link a PAGE asked to open (the Inbox's "See in Space", the Fleet
 * page's "Open in Space"), re-built from its parts so a page can never smuggle
 * anything else through: focus=next, at=<U1 id> or card=<card id>, one of them.
 * @returns {string|null} the canonical URL for `spacePane`, or null when refused
 */
function canonicalSpaceLink(url, spacePane = null) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== `${SCHEME}:` || parsed.hostname.toLowerCase() !== SPACE_PANE) return null;
  if (parsed.pathname && parsed.pathname !== "/") return null;
  const flag = paneQuery(spacePane)[0] || "";
  const flagKey = flag ? flag.split("=")[0] : "";
  let target = null;
  for (const [key, value] of parsed.searchParams) {
    if (flagKey && key === flagKey) continue;
    if (target) return null; // one destination per link
    if (key === "focus" && value === "next") target = nextLink(spacePane);
    else if (key === "at") target = atLink(value, spacePane);
    else if (key === "card") target = cardLink(value, spacePane);
    else return null;
    if (!target) return null;
  }
  return target || spaceUrl([], spacePane);
}

/** The setting, read defensively: only a real `true` turns it on. */
function spaceHomeOn(overlaySettings) {
  return Boolean(overlaySettings && overlaySettings.spaceHome === true);
}

module.exports = {
  SPACE_PANE,
  FLEET_GALAXY,
  nextLink,
  atLink,
  cardLink,
  fleetLink,
  spaceTarget,
  canonicalSpaceLink,
  spaceHomeOn,
};
