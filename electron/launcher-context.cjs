"use strict";

/**
 * launcher-context -- what Alt+Space shows BEFORE you type.
 *
 * Owner, 2026-11-06: "alt+space and bringing up that overlay needs better
 * integration". Measured: the empty launcher answered `groups: []` and drew
 * "Type to search" -- while the desk already knew which app the owner had in
 * front of them (host-context.cjs). The overlay was a blank text box sitting on
 * top of the exact thing the owner wanted help with.
 *
 * The empty state is now a "Right now" group built from the foreground window:
 * the first row asks Aither about THAT window, the rest are the desk's own
 * actions for it. Every row is a kind launchItem already runs ("agent" sends a
 * prompt to chat, "action" runs a desk command), so nothing new can execute.
 *
 * Two rules:
 *  - The overlay itself is never the subject. Alt+Space takes focus, so a naive
 *    sample can read the desk's own window; those are filtered out and the group
 *    is simply omitted rather than offering "ask about Aither launcher".
 *  - An unreadable host never becomes a row. {ok:false} -> no group, and the
 *    status line says why, instead of a row about nothing.
 */

const OWN_WINDOW = /^(electron|aither|awdesk|desk)$/i;
const OWN_TITLE = /aither (launcher|spirit|search)|^desk$/i;

/** Is this sample the desk itself (so not worth offering)? */
function isOwnWindow(context) {
  if (!context || !context.ok) return false;
  return OWN_WINDOW.test(String(context.app || "")) || OWN_TITLE.test(String(context.title || ""));
}

function clip(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Build the "Right now" group from a host-context sample and the action ids the
 * registry actually has. Pure: same input, same rows.
 *
 * @param {object} context  sampleHostContext() result
 * @param {(id: string) => boolean} hasAction  whether the registry has a command
 * @returns {{group: object|null, status: string, items: object[]}}
 */
function rightNowGroup(context, hasAction = () => false) {
  if (!context || !context.ok) {
    return {
      group: null,
      items: [],
      status: context && context.reason ? `Can't see the foreground window: ${clip(context.reason, 90)}` : "",
    };
  }
  if (isOwnWindow(context)) return { group: null, items: [], status: "" };

  const app = clip(context.app || "this window", 40);
  const title = clip(context.title, 70);
  const subject = title ? `${app} — ${title}` : app;

  const items = [
    {
      key: "ctx:ask",
      kind: "agent",
      title: `Ask Aither about ${app}`,
      subtitle: subject,
      // chatPrompt(query, item) appends 'Use the agent "aither"'. The launcher
      // passes `prompt` as the QUERY for a ctx: row (an empty box has no query of
      // its own), so the message names the window the owner is actually in.
      target: "agents:aither",
      prompt: `I'm looking at ${subject}. Help me with what's on screen.`,
      score: 1,
    },
  ];
  const offers = [
    ["snip.region", "Snip this window", "Capture it and ask about the picture"],
    ["snip.screen", "Capture the whole screen", "Aither reads the pixels, not just the title"],
    ["note.new", "Note about this", `A note pinned to ${app}`],
  ];
  for (const [id, label, sub] of offers) {
    if (!hasAction(id)) continue;
    items.push({ key: `ctx:${id}`, kind: "action", title: label, subtitle: sub, target: id, score: 0.9 });
  }

  return {
    group: { id: "now", label: "Right now", total: items.length, items },
    items,
    status: `Looking at ${subject}`,
  };
}

module.exports = { isOwnWindow, rightNowGroup };
