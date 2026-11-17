"use strict";

/**
 * desk-timers.cjs -- `timer 10m tea` from Alt+Space, the palette, an agent or the CLI
 * (the `timer.start` registry row). A timer lives in the desk's memory and ends in a
 * desktop notification; it does not survive a desk restart, and the row's answer
 * says so rather than promising an alarm that a restart would silently drop.
 *
 * parseTimer() is pure; createTimers() takes the clock and the notifier, so
 * desk-timers.test.cjs runs it under `node --test`.
 */

const MAX_MS = 24 * 60 * 60 * 1000;
const UNIT_MS = Object.freeze({ h: 3_600_000, m: 60_000, s: 1_000 });

/**
 * "10m tea" / "1h30m stretch" / "90s" / "25 min focus" / "tea 5m" -> {ok, ms, label}.
 * A bare number is minutes. Over 24 h or zero is refused with a reason.
 */
function parseTimer(text) {
  const raw = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (!raw) return { ok: false, error: "0 durations — type one, e.g. 10m tea" };
  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)?(?![a-z])/gi;
  let ms = 0;
  let matched = "";
  let m;
  while ((m = re.exec(raw))) {
    const unit = String(m[2] || "m").toLowerCase()[0];
    ms += Number(m[1]) * (UNIT_MS[unit] || UNIT_MS.m);
    matched += `${m[0]} `;
  }
  if (!ms) return { ok: false, error: `“${raw}” has no duration — e.g. 10m tea, 90s, 1h30m` };
  if (ms > MAX_MS) return { ok: false, error: "1 timer longer than 24 h — use the calendar for that" };
  let label = raw;
  for (const part of matched.trim().split(/\s+(?=\d)/)) label = label.replace(part.trim(), " ");
  label = label.replace(/\b(for|in|timer)\b/gi, " ").replace(/\s+/g, " ").trim() || "Timer";
  return { ok: true, ms: Math.round(ms), label: label.slice(0, 80) };
}

function spoken(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h && `${h} h`, min && `${min} min`, sec && `${sec} s`].filter(Boolean).join(" ") || "0 s";
}

function createTimers({ notify, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, now = () => Date.now() } = {}) {
  if (typeof notify !== "function") throw new Error("timers need a notifier");
  const live = new Map();
  let seq = 0;
  function start(text) {
    const parsed = parseTimer(text);
    if (!parsed.ok) return parsed;
    const id = `t${(seq += 1)}`;
    const handle = setTimeoutImpl(() => {
      live.delete(id);
      try { notify({ title: `⏰ ${parsed.label}`, body: `${spoken(parsed.ms)} timer is done` }); } catch { /* notifier gone */ }
    }, parsed.ms);
    live.set(id, { id, label: parsed.label, endsAt: now() + parsed.ms, handle });
    return { ok: true, id, did: `Timer “${parsed.label}” set for ${spoken(parsed.ms)} (until the desk restarts)` };
  }
  function list() {
    return [...live.values()].map((t) => ({ id: t.id, label: t.label, leftMs: Math.max(0, t.endsAt - now()) }));
  }
  function cancelAll() {
    for (const t of live.values()) clearTimeoutImpl(t.handle);
    const n = live.size;
    live.clear();
    return { ok: true, did: `${n} timer${n === 1 ? "" : "s"} cancelled` };
  }
  return { start, list, cancelAll };
}

module.exports = { MAX_MS, createTimers, parseTimer, spoken };
