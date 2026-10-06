# Changelog

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
