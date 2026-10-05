"use strict";

/**
 * browser-tabs.cjs -- the Aither Browser's tab model, electron-free.
 *
 * Every tab belongs to whoever opened it: "you" (the owner: the + button, a link
 * they followed into a new tab) or "agent" (browser_open). The rule that matters:
 *
 *   An agent drives ONLY agent tabs. The owner's tabs -- their mail, their bank,
 *   whatever they were reading -- are never read, clicked or typed into by an agent
 *   tool, and an agent cannot switch to or close one.
 *
 * The agent works in its TARGET tab: the agent tab it last opened or switched to.
 * The owner can click any tab to watch it; that changes what is SHOWN (active),
 * never what the agent drives (target). A popup inherits its opener's owner, so a
 * link an agent page spawns is still the agent's.
 *
 * Since the browser became the console (plan slice 9) a tab also has a KIND --
 * "web", "internal" (an aither:// page) or "hosted" (AitherOS Online, signed in) --
 * and may be PINNED. Pinned tabs (Inbox, AitherOS Online, Workspace) sit at the
 * front of the strip and cannot be closed from it; only an owner tab may be pinned
 * or non-web, so an agent can never hold a console page.
 */

const OWNERS = Object.freeze(["you", "agent"]);
const KINDS = Object.freeze(["web", "internal", "hosted", "extension"]);
const MAX_TABS = 30;

class TabSet {
  constructor() {
    this.tabs = []; // [{id, by}], in strip order
    this.active = null; // the tab on screen
    this.agentTarget = null; // the agent tab the agent drives
    this.nextId = 1;
  }

  /** @returns {{ok: true, id: number} | {ok: false, error: string}} */
  add(by, { activate = true, after = null, kind = "web", pinned = false, key = null } = {}) {
    if (!OWNERS.includes(by)) return { ok: false, error: `unknown tab owner ${by}` };
    if (!KINDS.includes(kind)) return { ok: false, error: `unknown tab kind ${kind}` };
    if (by === "agent" && (kind !== "web" || pinned)) {
      return { ok: false, error: "an agent may only open web tabs; Aither pages belong to the owner" };
    }
    if (this.tabs.length >= MAX_TABS) return { ok: false, error: `the Aither Browser is at its ${MAX_TABS}-tab limit; close one first` };
    const tab = { id: this.nextId++, by, kind, pinned: Boolean(pinned), key: key == null ? null : String(key) };
    const lastPinned = this.tabs.reduce((last, t, i) => (t.pinned ? i : last), -1);
    let at = after == null ? -1 : this.tabs.findIndex((t) => t.id === after);
    // Pinned tabs stay at the front, in the order they were pinned; nothing lands among them.
    if (tab.pinned) at = lastPinned;
    else if (at >= 0 && at < lastPinned) at = lastPinned;
    if (at >= 0 || tab.pinned) this.tabs.splice(at + 1, 0, tab);
    else this.tabs.push(tab);
    if (activate || this.active == null) this.active = tab.id;
    if (by === "agent") this.agentTarget = tab.id;
    return { ok: true, id: tab.id };
  }

  get(id) {
    return this.tabs.find((t) => t.id === id) || null;
  }

  /** The pinned tab with this key ("inbox", "online", "workspace"), or null. */
  byKey(key) {
    return this.tabs.find((t) => t.key != null && t.key === String(key)) || null;
  }

  /** The owner shows a tab (any tab). */
  activate(id) {
    if (!this.get(id)) return { ok: false, error: `no tab ${id}` };
    this.active = id;
    return { ok: true, id };
  }

  /** The AGENT moves to one of its own tabs (and shows it, so the owner sees where it went). */
  agentSwitch(id) {
    const tab = this.get(id);
    if (!tab) return { ok: false, error: `no tab ${id}` };
    if (tab.by !== "agent") return { ok: false, error: `tab ${id} is the owner's; an agent may only use tabs it opened` };
    this.agentTarget = id;
    this.active = id;
    return { ok: true, id };
  }

  /**
   * Close a tab. `by` is who is closing: the owner may close any tab, the agent
   * only its own. Returns the tab that is now active (or null if none are left).
   */
  close(id, by = "you") {
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index < 0) return { ok: false, error: `no tab ${id}` };
    if (by === "agent" && this.tabs[index].by !== "agent") {
      return { ok: false, error: `tab ${id} is the owner's; an agent may only close tabs it opened` };
    }
    if (this.tabs[index].pinned) return { ok: false, error: `tab ${id} is pinned` };
    this.tabs.splice(index, 1);
    if (this.agentTarget === id) {
      const agentTabs = this.tabs.filter((t) => t.by === "agent");
      this.agentTarget = agentTabs.length ? agentTabs[agentTabs.length - 1].id : null;
    }
    if (this.active === id) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)];
      this.active = next ? next.id : null;
    }
    return { ok: true, closed: id, active: this.active };
  }

  /** The tab an agent tool acts on, or a refusal that says what to do. */
  target() {
    const tab = this.agentTarget == null ? null : this.get(this.agentTarget);
    if (!tab) return { ok: false, error: "the agent has no tab open; call browser_open first" };
    return { ok: true, id: tab.id };
  }

  snapshot() {
    return {
      active: this.active,
      agentTarget: this.agentTarget,
      tabs: this.tabs.map((t) => ({ id: t.id, by: t.by, kind: t.kind, pinned: t.pinned })),
    };
  }
}

module.exports = { KINDS, MAX_TABS, OWNERS, TabSet };
