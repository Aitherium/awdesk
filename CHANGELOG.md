# Changelog

## 0.1.26 - 2026-10-22

- Aither tells you when a big upload to your workspace pauses, finishes or fails, once per upload. Click the notice to open your workspace.

## 0.1.25 - 2026-10-22

Run Aither on this PC when your workspace is offline.

- New **Local AI** in the tray menu: install a Bonsai model on this computer with one click. Aither recommends the size that fits your PC; other sizes are under **Other sizes**. It starts by itself when you sign in.
- If your workspace can't be reached, Aither shows **Your workspace is offline** and opens a local chat. Local chat works without company documents.
- **Remove** deletes the local model.

## 0.1.24 - 2026-10-20

No more floating buttons on your desktop.

- While the AitherOS desktop and its bottom taskbar are on screen, the round buttons that
  floated at the right edge are gone. The taskbar already has the same buttons. They come
  back only when the desktop is hidden.
- Opening Aither on a company computer now opens straight to the AitherOS taskbar.
- Aither checks for updates every hour (was every six) and shows a notice when one is ready.

## 0.1.23 - 2026-10-20

Clicks reach your apps again.

- The avatar window no longer blocks clicks. Its empty area, including the space around
  the side buttons, used to catch every click; now clicks go through to the app
  underneath. The buttons and the avatar still respond.
- Opening a dropdown in an AitherOS Online window (Documents "Move to") no longer hides
  every window.

## 0.1.22 - 2026-10-18

Your running agents, from the palette.

- New "Agents…" row in the command palette (Ctrl+K) and the taskbar jump list. It opens
  the Agents window on its Running tab: your agent sessions on every computer, which one
  needs you, and a Start button to begin one on a machine you pick. The same screen is
  in AitherOS Online and in the Aither phone app.
- Also in this release: Hearth "message everyone", every desk character syncs into your
  Avatar library, and the Shop open / After hours / Game on posture.

## 0.1.21 - 2026-10-17

Quit Aither finishes in seconds.

- "Quit Aither" (the taskbar jump list and the Start menu) closed Aither within about
  4 seconds, but its own helper process stayed for 40 seconds or more. It kept waiting
  for its own background processes, and at the end it could close an Aither you had
  just started again. It now ignores its own processes, waits 3 seconds of real time,
  and only ever closes the Aither that was running when you chose Quit.
- Quit Aither also starts faster: it no longer loads the rest of Aither before asking
  the running one to close (that alone took 3 to 9 seconds).

## 0.1.20 - 2026-10-16

Every Aither on Windows can update itself again.

- 0.1.19 installs for all users, so its installer was marked "administrator only".
  Aither 0.1.18 and older start their downloaded update without asking Windows for
  administrator rights, and Windows refuses to start such an installer that way. So
  no PC running 0.1.18 or older could ever update to 0.1.19. The installer now starts
  normally and asks for administrator approval itself: one Windows prompt when the
  update installs. Click Yes and Aither updates and restarts.
- Upgrading from a per-user Aither (0.1.18 or older) removes that copy, so the Start
  menu and desktop shortcuts open the new version. Your settings and sign-in stay.
- Hide and Quit Aither are on the AitherOS dock. Hide puts the overlay away, like Esc;
  Quit ends Aither, like the tray's Quit. The dock shows them only on an Aither that
  can do them (0.1.20 and later), so an older one never shows a button that does nothing.
- The company setup page now starts the newest installed Aither, and does not
  reinstall it every time it runs, when an older per-user copy is still registered.

## 0.1.19 - 2026-10-16

Aither on a customer's PC is now light, gets out of the way of the Windows desktop,
and can always be quit.

- The Aither Browser no longer grows without limit on a workspace (company) site. A
  title fight on the workspace taskbar page made Desk re-lay its window thousands of
  times a second; on one customer PC Desk reached 7 GB and had to be ended from Task
  Manager. Desk now acts on that signal at most four times a second and ignores it
  while it flaps, re-sizes nothing that did not move, and the docked avatar is moved
  only when its slot really moves.
- Clicks and hover reach your real Windows desktop everywhere the AitherOS overlay is
  not drawing. Before, a page that did not report where its windows are made the whole
  screen belong to the overlay.
- Quit Aither is on the taskbar: right-click the Aither icon. It also ends an Aither
  that has stopped responding. Quit Aither is still on the tray menu.
- Desk watches its own memory: it closes hidden browser tabs and clears caches under
  pressure, restarts itself if it passes a hard limit, and ends itself if its main
  process stops responding. Hidden tabs you have not looked at for 10 minutes give
  their memory back and reload when you open them.
- On a company (workspace) install Desk uses the light settings: normal process
  priority, Chromium's own throttling for hidden and covered windows, and Lend memory
  off until you turn it on. The avatar stage stays hidden until you add a character or
  show it from the tray, and only the windows you asked for open at start. Opening
  Aither again brings up your workspace. Your own machine (no workspace) is unchanged;
  AWDESK_POSTURE=owner or customer chooses explicitly.

## Unreleased

- Desk.exe is locked down. It can no longer be started as a plain Node shell
  (ELECTRON_RUN_AS_NODE), NODE_OPTIONS and --inspect are ignored, it only loads its own
  app.asar, and an edited app.asar refuses to start. Cookies are encrypted on disk.
- On Windows, Desk now installs for all users under Program Files, so a standard account
  cannot replace it. Updates ask for administrator approval (UAC). An existing per-user
  copy in %LOCALAPPDATA%\Programs of the account that approves the install is removed;
  a copy under another account (on a kid-desk PC, the child's) is uninstalled from that
  account.
- Kid desk: Desk will not start at all if it is launched with a debugging switch
  (--inspect, --remote-debugging-*, --js-flags) or with ELECTRON_RUN_AS_NODE or
  NODE_OPTIONS set.

## 0.1.16 - 2026-10-14

- Desk can open your company's workspace instead of the public Aitherium desktop. When the
  setup page installs Desk it writes your workspace address, and the desktop overlay, the
  Aither Browser home page and the tray "Open workspace" item all go there. Only Aitherium
  workspace addresses are accepted; anything else falls back to the standard desktop.
- Desk tells you when a newer version is available (at start and every 6 hours) and can
  install it from the tray.
- Desk now shows Aitherium as its publisher. Existing installs upgrade in place.

## 0.1.15 - 2026-10-14

- Desk works on a second laptop. When this machine has no local gateway, the decisions
  pane reads and answers the same queue through the cloud gateway (mcp.aitherium.com, with
  your session sign-in), so a laptop shows the same cards as the PC. Approving a
  destructive card still opens the signed approval window. Steering a card still needs the
  PC; Desk says so instead of pretending.
- Desk switches to the cloud gateway only when the local gateway could not be reached at
  all. If a request reached the local gateway and then went quiet or dropped (for example
  a long backup or restart), Desk reports the error and does not send it again through
  the cloud, so an action never runs twice.
- The relay feed falls back to the gateway's relay tools when the local relay does not
  answer, and its endpoints can be set with AWDESK_RELAY_URL / AWDESK_GATEWAY_URL.
- The Fleet pane shows the remote-access doors: app.aitherium.com, mcp.aitherium.com,
  gateway.aitherium.com and the relay.
- A muted desk voice answers `/speak` with 409 and the reason (for example `voice.muted`)
  instead of 502, so callers see a setting, not a broken voice service. Desk does not
  unmute itself.

## 0.1.12 - 2026-10-06

- Sign in to awconnect inside the Aither Browser. Chromium gives an embedded browser no
  sign-in window for extensions, so the extension's Sign in button used to die with
  "sign-in window closed". Desk now hosts the real auth window itself: it opens on the
  browser's own session, catches the return to the extension's callback before that host is
  ever contacted, and hands the result back -- with Chromium's own wording when the window
  is closed early or a page fails to load, and the exact reason available to older callers
  through the standard error channel.

## 0.1.11 - 2026-10-05

- Settings → Connections no longer dead-ends a computer that has not been set up yet. A
  daemon that is down shows **Set up** — and one running without its platform tools shows
  **Fix** — right on its row; one click opens "Install the full local stack", the same
  installer that signs you in and sets everything up with nothing typed. (Owner 2026-10-05,
  onboarding a laptop: the row said the adk daemon was not running and offered no way to
  set it up and connect.)

## 0.1.10 - 2026-10-04

- Install the full local stack, with nothing typed. Tray or palette: "Install the full local
  stack…". It also starts on its own once, right after "Connect this computer" (and on the
  first launch of this version on a computer that is already connected). It uses Desk's own
  sign-in (your browser only if Desk is not signed in yet), then installs awdk, awnode, the
  aither terminal, your household devices, your mesh and your settings into your home folder,
  with a live row per step. No sudo and no system packages, so it works on a Steam Deck.
- Desk updates itself. The AppImage checks the latest release shortly after it starts and
  every few hours, checks the download against the release's SHA256SUMS.txt, swaps it in and
  restarts (never in the middle of an install). AWDESK_NO_UPDATE=1 turns it off.

## 0.1.9 - 2026-10-04

- Clicking the avatar with the microphone muted no longer talks over it. It used to say
  "Microphone is muted" in the avatar's own voice and cut off whatever it was saying; now a
  silent notification appears, at most once every 30 seconds.
- One sign-in. When a Desk window needs you to sign in, it runs Desk's own sign-in (your saved
  login, then your browser) instead of a password page, so your browser is signed in too.
- Sign out now also clears app.aitherium.com, so a leftover cookie there no longer keeps you
  looking signed in.

## 0.1.8 - 2026-10-04

- Desk can speak in your workspace's own voices. Pick a voice like "custom:aither" in the
  cast window and the avatar, /speak, the MCP speak tool and drop verdicts all use it.
- Mac: Desk starts at login in the background (Lend memory and the device check-in resume
  after a restart), for your user only. It is set up the first time Desk runs from
  Applications; a copy run from the disk image is left alone.

## 0.1.7 - 2026-10-03

- Steam Deck and Linux by clicks only. The first run of the downloaded AppImage adds Desk to
  your app launcher, starts it at login, and makes "Open Aither Desktop" links from
  aitherium.com open it, all for your user only. A "Connect this computer" window takes the
  8-character code from aitherium.com (Family, then "Make this computer a fleet node"), so no
  link handler is needed the first time. Tray: "Connect this computer…".
- Lend memory pauses while a Steam game runs (the same rule as the Deck installer's guard) and,
  by default, lends only on mains power.
- A downloaded AppImage is not executable yet: in Dolphin right-click it, choose Properties,
  Permissions, tick "Is executable", then double-click it (or choose Execute when Dolphin asks).
- This build is not code-signed; check downloads against SHA256SUMS.txt.

## 0.1.6 - 2026-10-03

- Lend memory uses the fast GPU. On Windows, Desk keeps itself on the integrated GPU so the
  avatar never stutters, and Windows applies that choice to the whole program. The lending
  engine now runs as its own process ("Desk Lend", a link to the same program, no copy) that
  may use the discrete GPU: measured 11 ms per attention call on an RTX 5090, against 33 ms on
  the integrated GPU. `"gpu": "low-power"` in kv-lend.json keeps lending on the integrated GPU,
  and `"battery"` does so only while a laptop runs on battery.
- This build is not code-signed: on Windows choose More info, then Run anyway; check the
  download against SHA256SUMS.txt.

## 0.1.5 - 2026-10-03

- Connect this computer to your workspace with one click: "Connect this device" on
  aitherium.com opens Desk with a single-use code (`desk://enroll?...`). Desk makes its
  own device key, which never leaves the computer, and joins as that device. No terminal and
  no admin rights.
- Lend memory (tray and palette): while on mains power, idle and with no game running, Desk
  holds part of your model's context in a hidden window (WebGPU, or the CPU) and connects
  outward to your workspace relay. Nothing listens on your computer. Your workspace decides
  whether it may lend, and removing the device stops it.
- This build is not code-signed. On Windows, SmartScreen says "Windows protected your PC":
  choose More info, then Run anyway. Check the download against SHA256SUMS.txt.

## 0.1.4 - 2026-10-01

- The Sessions pane shows what each Claude Code session was for and its next step
  (hover a row for the latest ask and where it stopped), from the session-focus
  records.

## 0.1.3 - 2026-09-29

- Same as 0.1.2, which never shipped: its release build failed on 7 lint errors,
  now fixed.

## 0.1.2 - 2026-09-29

- Windows open again in the installed app. The packager listed only `*.cjs`, so
  0.1.1's installers shipped without the HTML, CSS and JSON the windows load. A test
  now fails if any page the app loads is left out.
- Aither Browser: a browser window with an assistant panel. An agent can open, read,
  click and type through the desk's MCP tools while a banner shows it is driving, and
  "Take over" pauses it. Only http/https addresses open; page content gets no bridge
  into the desk, and camera/mic/location/notification requests are denied.

## 0.1.1 - 2026-09-13

- Hair no longer floats after a reboot: the avatar's saved SCALE was the cause.
  three-vrm's spring bones compare collider radii in model units against world
  distances, so a 0.3x avatar wore a 3x head collider that shoved every hair
  chain outward. Spring constants and collider radii now follow the scale.
- One command center. The Aither Console is the front door (tray: double-click
  or "Aither Console…"); its first pane is the Inbox — decision cards and the
  agents' #agents messages. The tray, the avatar's right-click menu and the
  floating beads each list only what lives nowhere else: the tray is console /
  inbox / show-hide / characters; the avatar menu is talk, camera, its window
  and characters; the beads are inbox, talk, console, drag mode.
- A real notification area: the inbox count is drawn on the tray icon, on the
  console's taskbar button (overlay badge) and on its Inbox tab — the same
  number everywhere, from one source.

## 0.1.0 - 2026-09-12

Desk's first release.

- Realtime character animation and amplitude-driven lip sync.
- PipeWire, WASAPI process-loopback, and Core Audio process-tap listeners.
- Transparent desktop presence with manual lifecycle, tray controls, shortcut,
  URL protocol, always-on-top behavior, zoom, orbit, and pan.
- Short-silence speech holding and smooth animation crossfades.
- Bring your own character: no model ships with Desk. Enroll any VRM you have
  the rights to — [VRoid Hub](https://hub.vroid.com/en/) is the guided path —
  and it is stored per-user, never redistributed. The release gate fails
  closed if a model is present.
- Hair, tails and tool chains hang naturally: springs that carry no authored
  gravity (the VRM default) get VRoid Studio's default instead of holding
  whatever level pose the file was authored in.
- Stable, replaceable model and animation slots with a strict release asset
  gate.
- Linux, Windows, macOS arm64, and macOS x64 validation and release workflows.
- The Aither Console: one window over Command, Fleet, Sessions, Cards, Chat and
  the Living Desktop — every pane detachable and reattachable.
- A Sessions pane: the unified directory of every Claude Code session on the
  machine (daemon-owned runs and discovered terminal tabs), with live
  transcript tails and each session's honest steering capability.
- Agent commands answer on the backend YOU chose (a launcher-resolved profile)
  instead of the default sign-in; Fleet status probes retry under load and
  label stale numbers instead of showing "?".
