# Aither Browser: the overhaul plan

The Aither Browser (`electron/browser-window.cjs`) is the window inside awdesk where
an agent browses while the owner watches and can take over. On 2026-10-03 the owner
watched it fill a real form (pixiv's VRoid SDK inquiry) and asked for a serious
overhaul plus integration with awconnect, the AitherOS Online living desktop and
AitherDesktop. This file is the order of work. Each slice ships on its own.

## What the first real use showed

| Gap | What happened |
|---|---|
| No way to launch it | It was on the tray and the palette only, with no icon. |
| The agent was blind | `browser_read` returns text only. With no field names or labels, the agent typed into the wrong first `input` and had to open a second, headless browser just to find selectors. |
| No select or checkbox | The form's "Support topic" dropdown could not be set. |
| No way to hand a step over | A reCAPTCHA guarded Send. The agent had to explain in chat which three things the owner should do. |
| No screenshot | The agent could not see what the owner saw. |

## Slices

1. **Launch it from everywhere: SHIPPED (#11066).** Globe bead, body menu, jump list,
   and a Browser row in the Aither Console rail (`console-window.cjs` LAUNCHERS).
2. **Eyes and hands: SHIPPED (#11071).** `browser_snapshot` lists every visible field, button,
   link, select and checkbox with a ref (`e1`, `e2`, …), its label, value and options.
   `browser_click`, `browser_type`, `browser_select` and `browser_check` take that ref
   and return the field's label so the agent can confirm it hit the right one; `type`
   reads the value back. `browser_press` sends an allowlisted key. `browser_screenshot`
   returns a PNG. Refs live in the isolated world, so page script cannot read or forge them.
3. **Hand to the owner: SHIPPED (#11071).** `browser_hand_to_owner(reason, ref?)` raises and
   flashes the window, outlines the element, shows "Your turn: …" in the toolbar and
   pauses every agent call until the owner presses "Let the agent continue". It covers
   captchas, passwords, payments, accepting terms, and a final Send in the owner's name.
4. **AitherDesktop awareness: SHIPPED (#11086).** Each page that settles is pushed to Genesis
   `/browser/agent-context/push` (`browser-context-push.cjs`) through Veil's loopback
   bridge, the door awconnect uses. `browser_context`/`browser_context_history` and the
   desktop snapshot now cover this window too. It sends the machine layer only: title,
   OpenGraph, JSON-LD, feeds, and form field names and labels. It never sends page
   text or a field value. `DESK_BROWSER_CONTEXT_PUSH=0` turns it off.
5. **awconnect.** One browser tool contract over two backends: this window, and the
   owner's own Chrome through awconnect 4. The assistant panel becomes awconnect's
   Connect panel (swap `ASSISTANT_PANEL`, nothing else).
6. **Living desktop overlay.** The overlay shows an "agent is driving" card for this
   window with Take over and a link to raise it, and AitherOS Online can open it as a window.
7. **A browser people can live in.** Tabs: this PR. Each tab belongs to whoever
   opened it (`browser-tabs.cjs`). An agent drives only its own tabs (marked with a
   purple dot) and can never read, switch to or close the owner's. `browser_tabs`,
   `browser_switch_tab`, `browser_close_tab`, and `browser_open` with `new_tab`. Popups
   open as tabs beside their opener. Still to come: a downloads shelf, history and
   bookmarks.

Iframes (captchas, embedded sign-in, card fields) stay out of the agent's reach on
purpose: slice 3 hands those to the owner.
