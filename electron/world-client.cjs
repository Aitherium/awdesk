"use strict";

/**
 * world-client.cjs -- read ShadowBroker's public map data for the one app's World rail.
 *
 * Owner, 2026-11-24: "integrate cleanly with shadowbroker". ShadowBroker is a
 * HOSTED app of another project (fork: Aitherium/Shadowbroker, AGPL-3.0): this
 * desk links and reads it, it never vendors its code. The site itself is the
 * World tab (browser-window.cjs); this module is only what the desk needs to
 * show a number and let a pin be saved to a page or sent to a room.
 *
 * It reads ONLY the routes the fork's operator turns anonymous reads on for
 * (`SHADOWBROKER_PUBLIC_READ_ROUTES`, backend/auth.py): layers, ai/layers, pins,
 * pins/geojson, timemachine snapshots. No key, no write, no agent shell.
 *
 * Measured 2026-11-24: the public host served `/` while its `/api/*` answered
 * nothing and `aitheros-shadowbroker-backend` sat "unhealthy" -- every verb reports
 * the host as UNREACHABLE rather than an empty world, because an empty map and a
 * dead one must not look the same. Both were then fixed at the source: the
 * container's healthcheck ran a `curl` the image does not have (438 straight exit
 * 125s), and after a restart through the deploy door the public routes answer 200.
 * The live data is genuinely EMPTY (`{ok, count: 0, layers: []}`) until an operator
 * defines AI layers or pins, and this client reports that as zero, not as an error.
 *
 * Pure except the injected fetch, so every verb is asserted under node --test.
 */

const DEFAULT_BASE = "https://shadowbroker.aitherium.com";
const TIMEOUT_MS = 20_000;
const MAX_PINS = 5_000;

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : "");

function createClient({ base = DEFAULT_BASE, fetchImpl, timeoutMs = TIMEOUT_MS } = {}) {
  const root = str(base).replace(/\/+$/, "") || DEFAULT_BASE;

  async function get(path) {
    if (typeof fetchImpl !== "function") return { ok: false, error: "no fetch for ShadowBroker" };
    let res;
    const timer = typeof AbortController === "function" ? new AbortController() : null;
    const timed = timer ? setTimeout(() => timer.abort(), timeoutMs) : null;
    try {
      res = await fetchImpl(`${root}${path}`, {
        headers: { Accept: "application/json" },
        ...(timer ? { signal: timer.signal } : {}),
      });
    } catch (error) {
      const why = (error && error.name === "AbortError") ? `no answer in ${timeoutMs} ms` : ((error && error.message) || String(error));
      return { ok: false, unreachable: true, error: `ShadowBroker did not answer (${why})` };
    } finally {
      if (timed) clearTimeout(timed);
    }
    if (res.status === 404) return { ok: false, error: "ShadowBroker has no such route" };
    if (!res.ok) return { ok: false, status: res.status, error: `ShadowBroker answered ${res.status}` };
    let json;
    try {
      json = await res.json();
    } catch {
      return { ok: false, error: "ShadowBroker answered with something that is not JSON" };
    }
    return { ok: true, data: json };
  }

  /** The layer catalogue, as a stable {id: label} list the World pane can render. */
  async function layers() {
    const r = await get("/api/ai/layers");
    if (!r.ok) return r;
    const raw = r.data;
    const list = Array.isArray(raw) ? raw : (isObj(raw) && Array.isArray(raw.layers) ? raw.layers : null);
    if (!list) return { ok: false, error: "ShadowBroker's layer route has an unfamiliar shape" };
    const out = list.map((item) => (isObj(item)
      ? { id: str(item.id || item.key || item.name), label: str(item.label || item.name || item.id), on: item.enabled !== false }
      : { id: String(item), label: String(item), on: true })).filter((l) => l.id);
    return { ok: true, layers: out };
  }

  /** Every pin on the map, normalised: {id, lat, lng, label, kind, at}. */
  async function pins() {
    const r = await get("/api/ai/pins");
    if (!r.ok) return r;
    const raw = r.data;
    const list = Array.isArray(raw) ? raw : (isObj(raw) && Array.isArray(raw.pins) ? raw.pins : null);
    if (!list) return { ok: false, error: "ShadowBroker's pin route has an unfamiliar shape" };
    const capped = list.slice(0, MAX_PINS);
    const out = capped.map((p, i) => {
      const pin = isObj(p) ? p : {};
      return {
        id: str(pin.id || pin.pin_id) || `pin-${i}`,
        lat: Number(pin.lat ?? pin.latitude),
        lng: Number(pin.lng ?? pin.lon ?? pin.longitude),
        label: str(pin.label || pin.title || pin.name),
        kind: str(pin.kind || pin.type),
        at: str(pin.created_at || pin.timestamp || pin.time),
      };
    }).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    // `truncated` is the CAP, not the count of pins without coordinates: a pin
    // the map cannot place was never on it, so counting it would read as "some
    // of the world is hidden" when the world is fully shown.
    return { ok: true, pins: out, dropped: capped.length - out.length, truncated: list.length > MAX_PINS };
  }

  /**
   * Search the map the way the World pane needs it: a term against pin labels and
   * kinds. ShadowBroker has no search route for its public read set, so this is a
   * local filter over one pins() read -- named as such, never presented as a
   * server-side search.
   */
  async function search(term, { limit = 50 } = {}) {
    const q = str(term).trim().toLowerCase();
    if (!q) return { ok: false, error: "nothing to search for" };
    const r = await pins();
    if (!r.ok) return r;
    const hits = r.pins.filter((p) => `${p.label} ${p.kind}`.toLowerCase().includes(q)).slice(0, limit);
    return { ok: true, query: str(term).trim(), results: hits, local: true };
  }

  return { base: root, layers, pins, search };
}

/** A pin -> a markdown line for "Send to room" / "Save to page". */
function pinLine(pin) {
  const p = isObj(pin) ? pin : {};
  const label = str(p.label).trim() || "(untitled pin)";
  const at = Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))
    ? ` (${Number(p.lat).toFixed(4)}, ${Number(p.lng).toFixed(4)})` : "";
  const kind = str(p.kind).trim();
  return `- ${label}${kind ? ` [${kind}]` : ""}${at}`;
}

/** The World tab's url for a pin or for the map itself. */
function mapUrl(pin, base = DEFAULT_BASE) {
  const root = str(base).replace(/\/+$/, "") || DEFAULT_BASE;
  const p = isObj(pin) ? pin : {};
  if (!Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lng))) return root;
  return `${root}/?lat=${Number(p.lat)}&lng=${Number(p.lng)}`;
}

module.exports = { createClient, pinLine, mapUrl, DEFAULT_BASE };
