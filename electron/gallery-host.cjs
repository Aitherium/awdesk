"use strict";

/**
 * gallery-host.cjs -- the rogues gallery's main-process half: the state the page renders and the
 * verbs it may send back (IPC `desk:gallery`, verb + arg). Every verb that changes a body is an
 * OWNER action -- this channel is reachable only from the gallery page in his console, never from
 * an agent tool (agents reach `propose`, via MCP, which only records a proposal).
 *
 * 🚩 A BODY THE AUDIENCE MAY NOT SEE IS NOT DESCRIBED. In Hearth or safe mode a mature model's
 * NAME can itself be the problem ("risque underwear" is a real folder name in this roster), so a
 * hidden avatar reaches the page as a counted, nameless locked tile -- no name, no thumbnail, no
 * model URL -- until the profile allows it.
 *
 * Pure: everything that touches the machine comes in through `deps` (main wires the real ones;
 * gallery-host.test.cjs wires fakes), so the whole contract runs under node --test.
 */

const fs = require("node:fs");
const path = require("node:path");
const gallery = require("./avatar-gallery.cjs");

const NAME_RE = /^[^\\/:*?"<>|]{1,120}$/;

function readRecord(rosterDir, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rosterDir, name, "character.json"), "utf8")) || {};
  } catch {
    return {};
  }
}

/** Where a body came from, in his words. */
function originOf(rec) {
  if (rec.vroid_hub_id) return "VRoid Hub";
  if (rec.source === "vroid-studio") return "VRoid Studio";
  if (rec.source === "avatar_factory" || rec.source === "forge" || rec.spec) return "Avatar factory";
  if (rec.pack) return "Pack";
  if (rec.library_id) return "Library";
  return "Imported";
}

function licenceOf(rec) {
  if (typeof rec.licence === "string") return rec.licence;
  if (rec.licence && typeof rec.licence === "object") return String(rec.licence.summary || rec.licence.name || "custom");
  const base = rec.base && typeof rec.base === "object" ? rec.base : null;
  if (base && typeof base.license === "string") return base.license;
  return "";
}

/**
 * The page's whole state. `deps`:
 *   rosterDir, allNames() (every installed body), isHidden(name), ratingOf(name),
 *   castRaw() (the raw cast.json), rosterAgents() (platform agents), proposalsDir,
 *   autoSafe(), sharing() (capture apps seen), studio() ({installed, downloadUrl}),
 *   hasThumb(name), fairyFor(persona) (optional: colour for the fairy placeholder)
 */
function buildState(deps) {
  const raw = deps.castRaw() || {};
  const g = gallery.readGallery(raw);
  const autoSafe = Boolean(deps.autoSafe && deps.autoSafe());
  const cap = gallery.audienceCap(g, { autoSafe });
  const authors = raw.authors && typeof raw.authors === "object" ? raw.authors : {};
  const wearers = {};
  for (const [persona, row] of Object.entries(authors)) {
    const c = row && typeof row.character === "string" ? row.character : "";
    if (c) (wearers[c] = wearers[c] || []).push(persona);
  }
  const avatars = [];
  const hidden = { teen: 0, mature: 0, unrated: 0 };
  for (const name of deps.allNames()) {
    const tier = gallery.tierOf(deps.ratingOf(name));
    if (deps.isHidden(name)) {
      hidden[tier] = (hidden[tier] || 0) + 1;
      continue;
    }
    const rec = readRecord(deps.rosterDir, name);
    const cfg = g.avatars[name] || null;
    avatars.push({
      name,
      display: (cfg && cfg.nickname) || String(rec.display_name || name).slice(0, 80),
      nickname: cfg ? cfg.nickname : "",
      tier,
      ratingSource: require("./rating-resolve.cjs").sourceLabel(rec),
      origin: originOf(rec),
      licence: licenceOf(rec),
      assignedTo: wearers[name] || [],
      thumb: Boolean(deps.hasThumb && deps.hasThumb(name)),
      config: cfg || { nickname: "", scale: 1, idle: "default", voice: "", physics: "default" },
    });
  }
  avatars.sort((a, b) => a.display.localeCompare(b.display));
  const visible = new Set(avatars.map((a) => a.name));
  const personas = gallery.personaIds({ authors, rosterAgents: deps.rosterAgents ? deps.rosterAgents() : [] }).map((id) => {
    const row = authors[id] && typeof authors[id] === "object" ? authors[id] : {};
    const character = typeof row.character === "string" ? row.character : "";
    const shown = character && visible.has(character);
    return {
      id,
      // A body the audience hides is reported as hidden, never named.
      character: shown ? character : "",
      hiddenBody: Boolean(character) && !shown,
      voice: typeof row.voice === "string" ? row.voice : "",
      tier: shown ? gallery.tierOf(deps.ratingOf(character)) : null,
      rotation: g.rotation[id] ? { every: g.rotation[id].every, set: g.rotation[id].set.filter((n) => visible.has(n)), hidden: g.rotation[id].set.filter((n) => !visible.has(n)).length } : null,
    };
  });
  // A proposal of a hidden body says only that one exists: no name, no agent's free text.
  const proposals = gallery.readProposals(deps.proposalsDir).map((p) => (visible.has(p.character)
    ? { id: p.id, persona: p.persona, character: p.character, by: p.by, why: p.why, at: p.at, hiddenBody: false }
    : { id: p.id, persona: p.persona, character: "", by: p.by, why: "", at: p.at, hiddenBody: true }));
  return {
    ok: true,
    profile: g.profile,
    profiles: g.profiles,
    profileLabels: gallery.PROFILE_LABELS,
    safeMode: g.safeMode,
    autoSafe,
    sharing: deps.sharing ? deps.sharing() : [],
    shareWatch: deps.shareStatus ? deps.shareStatus() : "off",
    notDetectable: require("./share-detect.cjs").NOT_DETECTABLE,
    cap,
    standIn: visible.has(g.standIn) ? g.standIn : "",
    avatars,
    hidden,
    personas,
    proposals,
    studio: deps.studio ? deps.studio() : { installed: false },
    choices: { idle: gallery.IDLE_CHOICES, physics: gallery.PHYSICS_PRESETS, every: gallery.ROTATION_EVERY, tiers: ["everyone", "teen", "mature"] },
  };
}

function okName(v) {
  // eslint-disable-next-line no-control-regex -- a control character is never part of a name
  return typeof v === "string" && NAME_RE.test(v) && !/[\u0000-\u001f]/.test(v) && v !== "." && v !== "..";
}
function okPersona(v) {
  return gallery.validPersona(v);
}

/**
 * The verb map. `deps` adds to buildState's: writeCast(mutation) -> {ok, error}, setRating(name,
 * rating) -> bool, onChanged() (re-enforce the audience on screen + tell the page), launchStudio(),
 * modelUrl(name), now().
 */
function galleryHandlers(getDeps) {
  const deps = () => getDeps();
  const allowed = (name) => okName(name) && deps().allNames().includes(name) && !deps().isHidden(name);
  const write = (mutation, reason = "edit") => {
    const r = deps().writeCast(mutation);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || "cast.json could not be written" };
    if (deps().onChanged) deps().onChanged(reason);
    return buildState(deps());
  };
  return {
    state: () => buildState(deps()),
    /** His click: this body on this persona. Only a body the audience may see. */
    assign: ({ persona, name, useAvatarVoice } = {}) => {
      if (!okPersona(persona)) return { ok: false, error: "assign: persona is required" };
      if (!allowed(name)) return { ok: false, error: "that body is not available on this profile" };
      return write(gallery.assignMutation(persona, name, { useAvatarVoice: useAvatarVoice === true }));
    },
    unassign: ({ persona } = {}) => (okPersona(persona) ? write(gallery.unassignMutation(persona)) : { ok: false, error: "unassign: persona is required" }),
    rate: ({ name, tier } = {}) => {
      // Only a body this profile shows: rating a hidden one would confirm its name exists.
      if (!allowed(name)) return { ok: false, error: "rate: no such body on this profile" };
      const r = gallery.RATING_OF[tier];
      if (!r) return { ok: false, error: "rate: everyone | teen | mature" };
      if (!deps().setRating(name, r)) return { ok: false, error: "the rating could not be saved" };
      if (deps().onChanged) deps().onChanged("audience");
      return buildState(deps());
    },
    config: ({ name, patch } = {}) => (allowed(name) ? write(gallery.avatarConfigMutation(name, patch || {})) : { ok: false, error: "config: no such body on this profile" }),
    rotation: ({ persona, set, every } = {}) => {
      if (!okPersona(persona)) return { ok: false, error: "rotation: persona is required" };
      const list = (Array.isArray(set) ? set : []).filter(allowed);
      // Members this profile hides are KEPT (review of #122: a save on Hearth deleted them --
      // he could not even see them to choose). An empty set is his explicit "stop rotating".
      const before = (gallery.readGallery(deps().castRaw()).rotation[persona] || { set: [] }).set;
      const kept = list.length ? before.filter((n) => !allowed(n)) : [];
      return write(gallery.rotationMutation(persona, [...list, ...kept], every), "audience");
    },
    profile: ({ profile } = {}) => (gallery.PROFILE_IDS.includes(profile) ? write(gallery.profileMutation(profile), "audience") : { ok: false, error: "profile: hearth | work | personal" }),
    safeMode: ({ on } = {}) => write(gallery.safeModeMutation(on === true), "audience"),
    standIn: ({ name } = {}) => {
      if (name && (!allowed(name) || gallery.tierOf(deps().ratingOf(name)) !== "everyone")) {
        return { ok: false, error: "the stand-in must be an everyone-rated body" };
      }
      return write(gallery.standInMutation(name || ""));
    },
    applyProposal: ({ id } = {}) => {
      const list = gallery.readProposals(deps().proposalsDir);
      const p = list.find((x) => x.id === id);
      if (!p) return { ok: false, error: "that proposal is gone" };
      if (!okPersona(p.persona)) {
        gallery.takeProposal(deps().proposalsDir, id);
        return { ok: false, error: "that proposal names no persona" };
      }
      if (!allowed(p.character)) return { ok: false, error: "that body is not available on this profile" };
      gallery.takeProposal(deps().proposalsDir, id);
      return write(gallery.assignMutation(p.persona, p.character));
    },
    dismissProposal: ({ id } = {}) => {
      gallery.takeProposal(deps().proposalsDir, id);
      return buildState(deps());
    },
    /** The live 3D preview's model: only a body the audience may see. */
    modelUrl: ({ name } = {}) => (allowed(name) ? { ok: true, url: deps().modelUrl(name) } : { ok: false, error: "not available on this profile" }),
    studio: () => (deps().launchStudio ? deps().launchStudio() : { ok: false, error: "unavailable" }),

    // -- VRoid Hub (slice 2): his hearts / models / staff picks / search through the platform's
    // broker. A model above the audience is never listed; a download lands UNASSIGNED.
    vroidBrowse: async ({ source, keyword, cursor } = {}) => {
      if (!deps().vroidBrowse) return { ok: false, error: "VRoid Hub is not available on this desk" };
      const r = await deps().vroidBrowse(String(source || "hearts"), String(keyword || ""), String(cursor || ""));
      const cap = gallery.audienceCap(gallery.readGallery(deps().castRaw()), { autoSafe: Boolean(deps().autoSafe && deps().autoSafe()) });
      // The audience cap AND the rule every installed body answers to (mirror gate, AitherSafety,
      // ceiling): a model the safety plane would hide once installed is not even listed.
      const ratingHidden = deps().ratingHidden || ((rating) => require("./content-rating.cjs").ratingHiddenReason(rating));
      const { models, hidden } = require("./vroid-link.cjs").visibleModels(r.models, cap, gallery.tierAllowed, ratingHidden);
      // Only what the audience may see can be installed later (review of #123).
      const shown = new Set(models.map((m) => m.id));
      if (deps().rememberVroid) deps().rememberVroid((r.models || []).filter((m) => m && shown.has(m.id)));
      const installed = new Set(deps().allNames());
      const named = deps().vroidRosterName || (() => "");
      return {
        ok: Boolean(r.ok),
        linked: r.linked,
        reason: r.reason || null,
        next: r.next || "",
        hidden,
        models: models.map((m) => ({ ...m, installed: installed.has(named(m.id)) })),
      };
    },
    vroidImage: async ({ url } = {}) => {
      const data = await require("./vroid-link.cjs").imageData(url);
      return data ? { ok: true, data } : { ok: false, error: "no picture" };
    },
    vroidInstall: async ({ id } = {}) => (deps().vroidInstall ? deps().vroidInstall(String(id || "")) : { ok: false, error: "unavailable" }),
    vroidLink: async () => (deps().vroidLink ? deps().vroidLink() : { ok: false, error: "unavailable" }),
    vroidLinkPaste: async ({ url } = {}) => (deps().vroidLinkPaste ? deps().vroidLinkPaste(String(url || "")) : { ok: false, error: "unavailable" }),
  };
}

module.exports = { buildState, galleryHandlers, originOf, licenceOf };
