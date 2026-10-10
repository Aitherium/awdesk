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
5. **awconnect: SHIPPED.** Shipped: one page protocol over two hosts (#11102). The
   desk answers the same `os→page` / `os-page-context` protocol (Veil
   `overlay-host.ts`) that awconnect answers over your Chrome tab. awconnect also has
   an "Open in Aither Browser" menu item (#11113, desk `POST /browser/open`) that
   opens the page in a new tab of yours. Agents can drive your own Chrome, one
   approved tab at a time (owner, 2026-10-03: "Yes, but ask each time"). Desk
   `chrome_*` MCP tools queue requests (`chrome-bridge.cjs`). awconnect long-polls
   them over `/chrome/next` (pinned extension origin only) and answers from
   `shared/chrome-agent.js`. A tab works only after you press "Allow on this tab" on
   a notification. The approval covers that tab on that site, and ends when the tab
   changes site or closes. An approved tab shows an "AI" badge. The Connect panel
   (`connect-panel.html`, now in `ASSISTANT_PANEL`) is awconnect's side panel inside
   the browser: chat about the page with history and quick actions (Summarize, Key
   facts, Explain selection, Is this safe?), Do it (an agent does a task in its own
   tab, handing you the Your-turn steps), Open in Chrome, and downloads.
6. **Living desktop overlay: SHIPPED (#11102).** The desk hosts AitherOS Online's page plane
   (`overlay-browser-host.cjs`). Every request goes through the browser's agent gate
   and tab-ownership rule. Page context gives text only for an agent's tab. The
   desk-state push now carries the browser's status, and a card in AitherOS Online
   (`desk-browser-card.tsx`) shows who is driving or "Your turn", with Open, Take
   over and Let the agent continue, from a fixed command allowlist.
7. **A browser people can live in.** Tabs: SHIPPED (#11092). Each tab belongs to whoever
   opened it (`browser-tabs.cjs`). An agent drives only its own tabs (marked with a
   purple dot) and can never read, switch to or close the owner's. `browser_tabs`,
   `browser_switch_tab`, `browser_close_tab`, and `browser_open` with `new_tab`. Popups
   open as tabs beside their opener. History, bookmarks and downloads: SHIPPED (#11106).
   History and bookmarks (`browser-library.cjs`, one JSON file in userData) feed
   address-bar suggestions: your bookmarks first, then your history, then pages an
   agent visited. No agent tool reads them. Downloads (`browser-downloads.cjs`)
   appear in the side panel, including a download an agent started, which is
   blocked and shown rather than silently dropped.

Iframes (captchas, embedded sign-in, card fields) stay out of the agent's reach on
purpose: slice 3 hands those to the owner.

## Part two: the browser IS the console (owner, 2026-10-04)

Owner, verbatim intent: "collapse the awdesk Aither Console into awdesk + AitherBrowser —
make the browser the console", "make AitherBrowser also a local file explorer + integrate
secrets/lockbox/strata/pulse/watch/flux/nexus", built around awconnect, awnode, awsh/awdk,
the local orchestrator/Bonsai, the AitherOS Online living desktop and aitherium.com/workspaces,
with "decision cards that aren't a piece of shit" and agent comms that "flow naturally through
terminals / Claude Code / Discord / email / AitherRelay / the desktop".

Shipped first (#11687, #11690):
- per-agent voice mute and unmute from a body's menu, plus all voices from the tray;
- cards no longer open windows on their own, and an answer reaches the session once;
- the Ops pane's `[object Object]` 404;
- the relay refusing the signed-in owner's own nick;
- Relay as its own window again.

Each slice below ships alone and is verifiable alone. In order:

8. **`aither://` pages: SHIPPED.** A privileged scheme served by `browser-internal.cjs`. Each page
   gets a preload that exposes only that page's IPC (the console panes already have these channels).
   - Every entry of `PANES` (console-window.cjs) is a page, derived at call time, so a pane added
     there needs no edit here: `file` -> its HTML, `view` -> the renderer bundle with its query
     flag, `hosted` -> AitherOS Online in its own signed-in partition.
   - The handler lives on ONE session (`persist:aither-internal`); web tabs have no handler, and
     `navigationVerdict` refuses aither:// from a web tab (navigate, redirect, frame). An internal
     tab sends a web link to a new web tab. Responses carry `frame-ancestors 'none'`.
   - `browser-internal-preload.cjs` requires exactly one pane preload, only on an aither: origin.
     The table matches `console-preload.cjs`, including its `plane-*.html` arm
     (`plane-preload.cjs`), and a test runs console-preload against every PANES entry.
   - A file pane's origin serves a `.js` file only when that pane's own HTML names it in
     `<script src>`, as with `plane-page.js`. A `.cjs` file is never served.
   - Permissions: an aither: page gets the microphone and nothing else. That is the grant the
     console's default session gave its panes, and it covers Inbox dictation and the Settings
     "Grant mic" button. Camera requests are refused. Web tabs still have every permission
     denied.
   - Character thumbnails: an aither: page cannot load `file://` models. Its deck state
     therefore names `/_models/<name>.vrm`, which main resolves from the roster.
   - Storage reset: each view pane now has its own `aither://<pane>` origin in a new partition.
     Any `localStorage` the console wrote under `file://`, such as Chat view state, starts
     empty once, and these panes no longer share it with each other.
   - Verified: `node --test electron/browser-internal.test.cjs` and
     `npm run test:browser-internal` (real Electron, hidden windows).
   - First pages: `aither://inbox`, `command`, `chat`, `sessions`, `stage`, `fleet`, `ops` and
     `settings`, the same HTML the console loads today.
   - Verify: `test:browser` opens each page, and a web tab cannot reach the scheme's IPC.
9. **The console becomes a shim: SHIPPED.** `openConsole(pane)` focuses the browser at
   `aither://<pane>`. `DESK_LEGACY_CONSOLE=1` brings the old console window back (rollback).
   - Pinned tabs: Inbox, AitherOS Online (`app.aitherium.com`; `DESK_ONLINE_URL` overrides it,
     but only with an aitherium.com URL) and Workspace.
   - Menus: "Aither Console…" becomes "Open Aither".
   - Not yet: the console's Ctrl+K palette has no browser twin (the tray, beads and avatar menu
     still list every command).
   - Verify: every console launcher lands on a tab, and no second window exists.
10. **Planes as pages.** These are thin pages over gateway MCP tools (`gateway-mcp.cjs`):
    - `aither://files`: a local file explorer over `cast.json` roots. It can open, reveal and
      "hand to agent". Agents get read-only access per root, and only when the owner grants it.
    - `aither://secrets`: names and masks only, via MCP `list_secrets` and `lockbox_user_*`.
      A value never enters the renderer.
    - `strata`, `pulse`, `watch`, `flux` and `nexus`: one page each over the existing status tools.
11. **One side panel, two hosts.** `connect-panel.html` gains an Agents tab: live sessions, open
    cards (answer in place) and the room. awconnect-next ships the same bundle, so Edge/Chrome
    and the Aither Browser look identical.
12. **Cards are relay messages.** A card is posted to `#decisions/<session>` with its options as
    buttons, and an answer is a reply. The desk, browser, phone, Discord and terminal all render
    that one message, so there is no separate popup plane left to storm.
13. **Relay, redesigned.** Shaped like Slack/Notion, on the existing channel model (`scope`
    global/platform/workspace, `is_private`, threads):
    - the rail: Workspaces, then channels, DMs and Boards;
    - agent presence in the right rail;
    - IRC kept (`AitherRelayIRCD.py`);
    - the community forum host routed to `/forum`.
14. **Workspace sync.** `adk sync packs` reads `/api/me/workspaces` and `/v1/link/bundle`, then
    activates agent, skill and tool packs and apps through `pack_registry` and
    `agent_binding_client`. The browser's Workspace tab shows the diff; the desk, awsh and
    awconnect run it.
15. **Presence.** The agent roster gains `voice:` and `character:`, which awavatar/persona
    honour. Aeon, Room and the company room become an `aither://room` tab with bodies speaking in
    turn. Hearth, Learn, Sprite and Spaces open as OS apps in the pinned Online tab, never as new
    installables (one app per platform).

## Part three: layers, one menu (owner, 2026-10-04)

Owner, verbatim intent: "it doesn't have all the proper ways to navigate to the various pages
that we collapsed from the Aither Console", "the 3 different menu surfaces are still
confusing", "the avatar should be attached to the Aither Browser and the browser just forms
around it like a shell, and then AitherDesktop forms around that dynamically ... multiple
layers: awsh -> awdesk/avatar -> browser -> AitherOS Online overlay".

The model, innermost first. Each layer wraps the one inside it and can be brought up or put
away without the others moving:

| Layer | What it is | Where it lives |
|---|---|---|
| awsh | the shell: say it in a sentence, sessions, agents | `aither://command`, the side panel's Chat / Do it / Agents |
| Avatar | the body of that shell | docked in the browser rail, or floating on the desktop |
| Browser | pages, tabs, every Aither page in a rail | the Aither Browser window |
| Online | AitherOS Online around everything | the overlay (Ctrl+Shift+D) |

16. **The rail: SHIPPED.** `browser-rail.cjs` + `browser-chrome.html`: a left rail with the
    Aither button, the avatar's slot, every `aither://` page grouped by section (generic over
    `console-window.cjs` PANES, so a new pane appears with no edit), the OS apps, and a layer
    strip (awsh, Avatar, Browser, Online). It collapses to icons. The rail may run only
    `RAIL_COMMANDS`.
17. **The avatar docks: SHIPPED.** `avatar-dock.cjs`: docked, the one avatar window becomes an
    owned window of the browser on the rail slot, not always-on-top, following every move and
    resize; floating restores the bounds it had. Closing the browser floats it and keeps the
    wish (`avatar-dock.json` in userData, default docked). `avatar.dock` is on the tray, a
    body's menu and the palette.
18. **One menu: SHIPPED.** The browser's Aither button pops the tray's menu itself
    (`trayTemplateNow`). A body's right-click is that menu with the body's rows on top, then
    the tray's order. Three surfaces, one menu.
19. **Resizable, foldable: SHIPPED.** Drag the gutters to resize the rail and the assistant
    panel; fold rail sections; hide the panel; all kept in `browser-layout.json`.
20. **The taskbar along the bottom: desk side SHIPPED.** `browser-taskbar.cjs` shows Veil's real
    `<Taskbar/>` from `app.aitherium.com/embed/taskbar` in Online's signed-in partition. A click
    opens the app in the Online tab, and the page's title grows the view while Start is open.
    Until that route is live, the strip stays hidden.
21. **awsh = terminal tabs: SHIPPED.** `aither://terminal` runs shells and coding agents (Shell,
    Claude Code, Aither, Codex, Gemini, OpenCode, Aider) as tabs over the awsh harness daemon's
    pty sessions (`terminal-client.cjs`, xterm.js vendored). The rail's awsh layer opens it.
    `npm run test:terminal` proves it against the real daemon.
22. **awconnect built in: SHIPPED.** `browser-extensions.cjs` loads adk's staged awconnect build
    into the browser's web partition. `awconnect-compat-preload.cjs` fills the chrome.* APIs
    Electron lacks, so its background worker and UI start here. `npm run test:awconnect-builtin`.
    Sign in works too: `awconnect-webauth.cjs` gives the shim a real
    `chrome.identity.launchWebAuthFlow` -- an auth window on the extension's own session,
    resolving on the first navigation to `https://<id>.chromiumapp.org/`, in the extension's
    page AND its MV3 worker. `npm run test:awconnect-webauth`.
23. **The browser sits inside Online: first slice SHIPPED.** While the overlay is up with the
    browser open, the overlay's desk-state says `browser.frame` and the OS opens an `Aither
    Browser` window (Veil `desk-browser-window.tsx`): in the taskbar and stage strip, focused,
    minimized and closed by the window manager. Its body's rect goes to the desk as
    aither-host/1 `desk-window` (overlay window only), and `browser-in-online.cjs` makes the
    browser an owned window of the overlay laid over that body; minimize or a stage sweep hides
    it, closing the OS window or hiding the overlay puts it back where it was. Known edge: an
    owned window sits above every OS window, so another OS window cannot overlap it yet.
    Still next: hide the avatar's own bead rail and speech bubble while it is docked.
