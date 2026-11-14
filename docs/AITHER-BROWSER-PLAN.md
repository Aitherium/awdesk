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
    it, closing the OS window or hiding the overlay puts it back where it was. Z-order follows the
    window manager: the OS sends the rects of its windows stacked above the frame
    (`occluders`), the desk clips the browser to the rest (`setShape`) or hides it when fully
    covered, and raising its window (taskbar, stage strip) makes it whole again.
    Still next: hide the avatar's own bead rail and speech bubble while it is docked.
24. **Protected video and music (Widevine): SHIPPED in dev, production signing pending.** The desk
    builds on castLabs' Electron for Content Security; `browser-widevine.cjs` installs the CDM at
    app ready and an encrypted stream decodes in a tab (`npm run test:browser-widevine`). The
    "Open in Edge" notice shows only when Widevine is missing or failed. Services that verify the
    platform (Netflix) need a VMP-signed build: `scripts/vmp-sign.cjs` signs behind
    `AITHER_VMP_SIGN=1` once the owner has a castLabs EVS account. `docs/WIDEVINE.md`.
25. **Content blocking depth and translate: SHIPPED** (2026-11-13, after the Edge parity
    slice). Four parts, each a pure module with tests; `browser-window.cjs` only wires them.
    - **Path and option rules** (`browser-adblock-rules.cjs`). `||host/path^`, `$third-party`,
      `$script`/`$image`/..., `$domain=`. An ad on the page's own host is now cancelled. No list
      rule becomes a regular expression: a pattern is literal pieces found with `indexOf`, and
      rules are indexed by hostname or by one word of the pattern. Measured with the real
      lists (167,552 hosts, 11,743 rules): about 4 microseconds a request; the test fails at 50.
      `@@` exceptions win over every block.
    - **Element hiding** (`browser-adblock-cosmetic.cjs`). `##sel`, `site##sel`, `#@#`, `~site`.
      One user style sheet per page (`insertCSS`, `cssOrigin: "user"`), about 24,000 selectors
      in groups of 20, so a selector Chromium rejects voids only its group. The lists'
      page-level exceptions are honoured: `$generichide` (YouTube), `$elemhide`, `@@...$document`.
      A list is someone else's text in every page, so a selector is refused when it holds a
      brace or `url(` anywhere (quoted and escaped too), or when its brackets cross. Review
      found two lines that got live CSS past the first check (`url(a"b)` ends at the `)` for
      Chromium and looked like an open string to the check; `[b(]c)` balanced by count); both
      are tests and a live smoke check now. Cost on the real lists: 1 rule of 24,119.
    - **The shield** in the toolbar: what was blocked on this page, pause on this site, pause
      everywhere. It is on every web page, because it is where a broken site gets fixed.
      From an InPrivate tab "pause on this site" (shield and more-menu) is held in memory,
      applies to InPrivate tabs only and is dropped with the last one: `adblock.json` never
      names a site that was only visited InPrivate.
    - **Tracking** (`browser-tracking.cjs`): `utm_*`, `fbclid`, `gclid`... leave a page's address
      before the request does; every request says `Sec-GPC: 1` and `DNT: 1`. Both are toggles
      in the more-menu, on by default.
    - **Translate** (`browser-translate.cjs`). A page in another language is offered
      ("This page is in German. Translate?"); the text decides the language, the `lang`
      attribute is only a fallback. Never offered InPrivate or on an agent's tab. The text
      goes to the first backend that answers, in this order: MicroScheduler (a local lane,
      never a hosted API lane), the local node, bonsai-local, the desk agent. The notice
      names the one that answered. `npm run test:browser-parity` proves all of it on real
      pages; `AWDESK_TRANSLATE_LIVE=1` adds a real model.
    Not done: procedural hiding (`#?#`, `:has-text`), scriptlets, `$redirect`/`$csp`/`$removeparam`,
    hiding inside sub-frames, `navigator.globalPrivacyControl`, and regular-expression rules.

## Part four: the everyday browser's own pages (owner, 2026-11-13, "close the gaps")

The browser kept history, bookmarks and downloads but had no page for any of them: Ctrl+H
opened nothing, Ctrl+J did nothing, a bookmark could be starred and never listed again.

26. **The library pages: SHIPPED.** Five panes, one page script (`library-page.js`), one
    bridge (`library-preload.cjs`), channels in `browser-library-pages.cjs`:

    | page | key | what it does |
    |---|---|---|
    | `aither://history` | Ctrl+H | search, grouped by day, who visited (you / agent), delete one, a day, a range, all |
    | `aither://bookmarks` | Ctrl+Shift+O | list, search, add, rename, move, delete, folders, import / export the Netscape bookmarks HTML |
    | `aither://downloads` | Ctrl+J | the shelf as a page: open, show in folder, try again, remove, clear finished |
    | `aither://permissions` | more-menu | every remembered Allow / Block, per site; remove one, a site, all |
    | `aither://clear-data` | Ctrl+Shift+Delete | history, cookies + site data, cache, saved passwords; a time range; a confirm |

    The fence: every channel answers ONE page (the sender must be showing that `aither://`
    pane; another Aither page is refused too). Anything that destroys more than a row asks
    in a dialog main draws, so page script cannot answer for the owner. A page never names
    a file: export, import and "open" go through main's dialogs and the shelf's own rows.
    No agent tool reads any of it: an agent's tab is a web tab with no preload and can
    never open an `aither://` address.
27. **Bookmark folders: SHIPPED.** A bookmark may carry `folder` (a path joined with "/").
    `browser-library.json` stays version 1 and a file written before folders reads
    unchanged. Import from Edge keeps each favorite's folder.
28. **The bookmarks bar: SHIPPED, off by default.** Ctrl+Shift+B or the more-menu. One 30px
    row under the toolbar (`BOOKMARKS_BAR_HEIGHT`); main sends the chrome height and every
    layout reads `chromeHeight()`, so `#top` and the page view move together.
29. **Site permissions: SHIPPED.** Camera, microphone, location, notifications and
    clipboard-read ASK the owner in the toolbar notice (Allow / Block / Not now), remembered
    per origin in `browser-permissions.json` (`browser-permissions.cjs`). Never for an agent
    tab, a tab an agent is driving, a console page, a subframe or an insecure page.
    InPrivate asks every time and writes nothing; a remembered Block still holds there.
    Everything else stays denied (`browser-policy.cjs` allowPermission), with one grant nobody
    is asked about: protected media (24) for the owner's own web tab on the owner's session.
    It is judged per tab in both handlers (`allowPermissionFor`): an agent's tab is refused
    also when it rides the owner's session.
30. **Clear browsing data: SHIPPED.** The owner's profile only (`persist:aither-browser`);
    the agent's session and the Online sign-in are kept. History and passwords honour the
    time range. Cookies, site data and the cache are cleared whole: Electron's
    `session.clearData` takes no time range, and the confirm says so.

    Still next: downloads persist across restarts (the shelf is in memory); drag to reorder
    bookmarks and the bar; a prompt that reaches a popped-out tab's own window; location
    needs a geolocation provider key before an allowed site gets coordinates.
    `npm run test:browser-parity` drives all of it in a real window.
31. **Sync: bookmarks, history and open tabs follow the account. Desk side SHIPPED, default OFF.**
    `browser-sync.cjs`. The store is the platform's existing per-user preferences object
    (`GET/PUT /api/settings/preferences` on the PLATFORM host `app.aitherium.com`, Veil in
    front of AitherDirectory `/directory/self/preferences`): the user comes from the verified
    bearer, a write is an RFC 7386 merge-patch, a stale `If-Match` is 409. awsettings already
    syncs through it; no new endpoint was built. The desk sends the Online session's bearer
    (`onlineToken()`) to `browser-internal platformOrigin()` and nowhere else: never to
    `onlineUrl()`, which in tenant mode is the tenant's site (no store there; GitHub Pages
    answered 404 on garg.aitherium.com).

    | rule (review of PR #72) | how |
    |---|---|
    | one account per state file | the bearer is opaque, so Identity `/auth/me` names it (once per bearer); `browser-sync.json` keeps a hash. Another account's bearer sends nothing, sync turns itself off and says so; ticking it again is the owner's yes to merging |
    | a reset library is not a delete | `browser-library.json` carries a generation id; a different id than the one recorded means a fresh device, so no tombstones are made and the store restores it |
    | a full shard keeps its deletes | over budget the oldest live bookmarks are dropped from the wire, tombstones stay |
    | a device namespace has a budget too | the last open tabs are dropped until it is under 15 KB, and counted as not synced |

    | namespace | holds | limit |
    |---|---|---|
    | `awbrowser_bm0..3` | bookmarks by id: `{u, t, m}`, or `{m, d:1}` for a delete | 15 KB each (store: 16 KiB) |
    | `awbrowser_hi0..1` | the newest 150 history entries `{u, t, m, c}` | 15 KB each |
    | `awbrowser_dev_<id>` | one device: `{n, m, tabs: [{u, t}]}`, at most 30 tabs | written only by that device |
    | `awbrowser_meta` | `{v, hc}`, hc = history cleared at | |

    Merge is per item, last writer wins by timestamp; a delete is a tombstone kept 180 days, so
    a deleted bookmark does not come back from another device. What does not fit the store stays
    on this computer and is counted in the status line. Never sent: InPrivate tabs, agent tabs
    and agent visits, internal pages, an address with credentials or a secret-looking query.
    The ⋯ menu has "Sync this browser" (status and last-sync time under it), "Sync now" and
    "Tabs from other devices". It syncs 15 s after a visit, a bookmark or a closed tab, and
    every 5 minutes, only while signed in.
    Proof: `node --test electron/browser-sync.test.cjs` (two devices, a local store),
    `npm run test:browser-parity` (the real window), and
    `AW_SYNC_TOKEN_FILE=<bearer file> node electron/browser-sync-live.cjs` (two temp profiles
    against the real store; it removes what it wrote).
    Still next: **passwords** stay in the local vault until the platform vault (AitherOS
    #16731) is merged and deployed, then they sync through it and nowhere else; the **Android
    app** does not read or write these namespaces yet, so today this is PC to PC; a sign-in does
    not trigger a sync by itself (the 5-minute timer picks it up).
    With the library pages (26): a bookmark changed on `aither://bookmarks` syncs like any
    other, and clearing ALL history (the history page, or clear browsing data with "all time")
    calls `noteHistoryCleared`, so the store does not hand it back. Not yet: ONE deleted visit,
    a deleted day or a time range is local only (history has no per-entry tombstone, so a
    synced copy can return from the store); a rename or a move to
    another folder stays on this computer (the store keeps a bookmark's first title and no folder).

## Part five: the browser from the desk's own command surfaces (owner, 2026-11-13)

"And integrate with the Alt+Space hot key and whatnot?" Everything in part four lived in the
browser's toolbar, its more-menu and its keys. It is now in the command registry too
(`electron/command-registry.cjs`, group `browser`, 24 rows whose `browser` field is the verb
`browser-window.browserCommand` runs), so it is on the palette, listed in Alt+Space, and the
tray has ONE `Browser` submenu for the rows that are not about the page on screen.

Typed in Alt+Space (`electron/browser-verbs.cjs`, wired in `launcher-window.cjs`):

| you type | what Enter does |
|---|---|
| `example.com`, `https://...`, `go <address>` | opens it in a new tab of yours |
| `search <words>` | a web search in the browser (`aither://search`) |
| `private <address>` | opens it InPrivate; bare `private` is a new InPrivate tab |
| `history <words>` | pages YOU visited that match (8 at most); Enter opens one |
| `bookmark <words>` / `bookmarks <words>` | your matching bookmarks; bare `bookmark` bookmarks this page |
| `tab <words>` | switches to your open tab that matches; bare `tabs` lists them |
| `find <words>` | find on the page in your active tab, with the find bar open on those words |
| `extension <store address>` | adds a Chrome Web Store / Edge Add-ons extension, after the confirm |

Rules every one of them keeps (`command-registry.test.cjs`, `browser-parity-smoke.cjs`):

- It opens the browser when it is closed and brings it forward when it is not.
- It acts for the owner. A page verb (find, print, translate, bookmark, open in Edge, pause
  ads here) is refused while an agent's tab is on screen; it never runs on the agent's page.
- The lists are the owner's: no visit an agent made, no agent tab, no InPrivate tab (InPrivate
  pages are never recorded in the first place).
- Over `POST /commands/run` (another program) the sync switch, the two ad-blocking switches
  and the Edge import are refused: they change what this browser keeps or sends.
- `?` is still Ask Aither and `!private` is still the hidden-results reveal.

## Part six: the managed browser (zero trust, 2026-11-13)

A workspace names its apps; the browser enforces a policy the workspace signed on those
origins and nowhere else. Design, schema and the list of what is not closed:
[WORKSPACE-POLICY.md](WORKSPACE-POLICY.md).

32. **Slice 1, desk side: BUILT, inert until a signing key is pinned.**
    - **Signed policy** (`browser-workspace-policy.cjs`): Ed25519 over a canonical form,
      pinned keys, a serial that only goes up, `not_after` checked on every decision, the
      tenant bound by the first good policy. Tampered, rolled back, expired or missing:
      the apps the last good policy named are refused with a page that says why.
    - **Enforcement** on governed origins: copy, paste, downloads, print, save / capture
      and developer tools, per app, each with a toolbar notice and one audit row.
    - **Work partition** `persist:aither-work-<tenant>` for governed apps; never shared
      with an agent, never popped out.
    - **Mesh door** (`browser-mesh-door.cjs`): a loopback proxy with a per-launch
      credential that reaches a private app's mesh address with no VPN. Only the work
      session has the proxy script and the credential; agent and InPrivate tabs are refused.
    - **Watermark** (a click-through window main owns) and screen-capture exclusion.
    - **Audit spool** (`browser-audit.jsonl`): origins and verdicts only.
    - Proof: the `workspace:` checks in `npm run test:browser-parity` (a local server
      stands in for a mesh peer under a made-up host name).

    Next slices: key custody and the pinned key; the platform route
    `GET /v1/workspace/browser-policy` and its signer; device posture and step-up before a
    private app opens; audit upload; an embedded mesh dialler.
