"use strict";

/**
 * overlay-browser-host.cjs -- the desk as an overlay HOST for AitherOS Online.
 *
 * Veil's overlay-host.ts speaks a page protocol to whatever hosts the OS overlay:
 * `os→page` (click / type / read / scroll / info / key) answered by `page→os`, and
 * `os-page-context` for "what is the user looking at". awconnect has always hosted
 * it over the owner's Chrome tab. The desk's overlay window never did, so the
 * Living Desktop on the desk could neither see nor drive any page.
 *
 * Here the desk answers it with the AITHER BROWSER:
 *   - os→page goes through the browser's ONE agent dispatcher (browser-policy's
 *     gate and browser-tabs' ownership rule): the OS drives the agent's tab, is
 *     refused while the owner has taken over, and never touches an owner's tab.
 *   - os-page-context describes the tab ON SCREEN. Its text is included only when
 *     that tab is an agent's; an owner's tab gives title, address and headings.
 *   - desk commands from the overlay card run from a fixed allowlist.
 *
 * Electron-free and pure so it is asserted under node --test.
 */

/** What the overlay card may ask the desk to do. Nothing else crosses. */
const DESK_COMMANDS = Object.freeze(["browser.open", "browser.takeover", "browser.handback"]);
const PAGE_ACTIONS = Object.freeze(["click", "type", "read", "scroll", "info", "key"]);
const CONTEXT_TEXT_CHARS = 12_000;

/** Veil's key names -> browser_press keys. */
const KEY_ALIASES = Object.freeze({ Enter: "Enter", Return: "Enter", Tab: "Tab", Escape: "Escape", Esc: "Escape",
  " ": "Space", Space: "Space", Backspace: "Backspace", Delete: "Delete", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", PageUp: "PageUp", PageDown: "PageDown", Home: "Home", End: "End" });

/**
 * Answer one `os→page` request with the browser's agent dispatcher.
 * @param {(action: string, args?: object) => Promise<object>} agent  browserAgent()
 * @param {{action?: string, selector?: string, text?: string, key?: string}} msg
 * @returns {Promise<{ok: boolean, error?: string, text?: string, url?: string, title?: string}>} never rejects
 */
async function hostPageAction(agent, msg = {}) {
  const action = String(msg.action || "");
  if (!PAGE_ACTIONS.includes(action)) return { ok: false, error: `unknown page action ${action}` };
  try {
    if (action === "read") {
      const r = await agent("read", {});
      return r.ok === false ? { ok: false, error: r.error } : { ok: true, text: r.text, url: r.url, title: r.title };
    }
    if (action === "info") {
      const r = await agent("tabs", {});
      if (r.ok === false) return { ok: false, error: r.error };
      const target = (r.tabs || []).find((t) => t.agentTarget);
      return target ? { ok: true, url: target.url, title: target.title }
        : { ok: false, error: "the agent has no tab open in the Aither Browser" };
    }
    if (action === "click") {
      const r = await agent("click", { selector: msg.selector });
      return r.ok === false ? { ok: false, error: r.error } : { ok: true, text: r.label || r.text || "" };
    }
    if (action === "type") {
      const r = await agent("type", { selector: msg.selector, text: typeof msg.text === "string" ? msg.text : "" });
      return r.ok === false ? { ok: false, error: r.error } : { ok: true, text: r.label || "" };
    }
    if (action === "key") {
      const key = KEY_ALIASES[String(msg.key || "")];
      if (!key) return { ok: false, error: `key ${String(msg.key || "").slice(0, 20)} is not one the browser presses` };
      const r = await agent("press", { key });
      return r.ok === false ? { ok: false, error: r.error } : { ok: true };
    }
    // scroll: PageDown is what a page scroll IS to a keyboard user.
    const r = await agent("press", { key: "PageDown" });
    return r.ok === false ? { ok: false, error: r.error } : { ok: true };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).slice(0, 300) };
  }
}

/**
 * The `os-page-context` payload (Veil HostPageContext) for the tab on screen.
 * @param {{ok?: boolean, url?: string, title?: string, text?: string, headings?: string[], description?: string}} page
 * @param {"you"|"agent"} by  who owns that tab
 */
function hostContext(page, by, now = () => Date.now()) {
  if (!page || page.ok === false || !page.url) return null;
  let host = "";
  try {
    host = new URL(page.url).host;
  } catch {
    /* a page with no parsable address still has a title */
  }
  const share = by === "agent";
  const text = share ? String(page.text || "") : "";
  return {
    url: String(page.url),
    host,
    title: String(page.title || ""),
    description: String(page.description || ""),
    selection: "",
    headings: Array.isArray(page.headings) ? page.headings.slice(0, 20).map(String) : [],
    text: text.slice(0, CONTEXT_TEXT_CHARS),
    truncated: text.length > CONTEXT_TEXT_CHARS,
    at: now(),
    // Not in Veil's type, harmless to it: says WHY an owner tab has no text.
    owner: by,
  };
}

/** What the overlay card shows about the browser: who is driving, and where. */
function browserSummary(state) {
  if (!state || !state.open) return { open: false };
  const agent = state.agent || {};
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  const target = tabs.find((t) => t.agentTarget) || null;
  return {
    open: true,
    driving: Boolean(agent.driving),
    paused: Boolean(agent.paused),
    handoff: agent.handoff ? { reason: String(agent.handoff.reason || "") } : null,
    lastTool: agent.lastAction ? String(agent.lastAction.tool || "") : "",
    agentTab: target ? { title: target.title || "", url: target.url || "" } : null,
    tabCount: tabs.length,
  };
}

/** True when the overlay may run this command id. */
function allowedCommand(id) {
  return DESK_COMMANDS.includes(id);
}

module.exports = { DESK_COMMANDS, KEY_ALIASES, PAGE_ACTIONS, allowedCommand, browserSummary, hostContext, hostPageAction };
