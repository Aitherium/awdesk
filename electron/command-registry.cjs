"use strict";

/**
 * The command registry — ONE inventory of what Desk can do, and where each
 * capability appears.
 *
 * WHY THIS EXISTS (owner, 2026-09-18): "the whole UI/UX is starting to just
 * become a stacked mess of things -- we need a real proper reimplementation
 * that makes this actually functional."
 *
 * The mess is not visual. Measured that day: 10 BrowserWindows across 7 modules,
 * 6 preload bridges, 43 ipcMain channels, and THREE menus (tray, avatar
 * right-click, console bar) that each listed capabilities by hand. Nothing in
 * the tree could answer "where does this capability appear?", so:
 *
 *   - avatar window size hung off exactly ONE gesture (a right-click that lands
 *     on a body and travels under 6px) plus two global shortcuts whose
 *     registration result was discarded. A gesture change removed it, silently.
 *   - "Aither Console…" was hand-written in three templates, and each menu drifted
 *     from the others between consolidations (09-13 was the last one).
 *
 * So menus stop being hand-written. Every capability is declared HERE once, with
 * the surfaces it belongs on, and each menu is RENDERED from this list. A
 * capability that reaches only one surface must say why, in the record, where a
 * reviewer sees it -- `conformance()` fails otherwise, and its test fails with it.
 *
 * This module is deliberately electron-free and side-effect-free: it is data plus
 * two pure functions, so the inventory can be asserted under `node --test`
 * without a window. Behaviour stays in main.cjs, injected as `run(id)`.
 *
 * Slice 1 of docs/UX-REIMPLEMENTATION.md. Slice 2 gives routes the same
 * treatment (one owner for "where is this surface right now").
 */

/**
 * Every surface that can present a command.
 *
 * `beads` is the round button rail beside the avatar and `jumplist` is the Windows
 * taskbar's right-click list. Both were hand-wired (a `desk:deck-action` verb per
 * bead, no jump list at all), which is how the chat bead came to say "Talk to
 * Aither" while the tray said "Talk to the agents" and meant the microphone.
 */
const SURFACES = Object.freeze(["tray", "avatar-menu", "palette", "beads", "jumplist"]);

/**
 * A group's ONE parent label, for every menu that nests it.
 *
 * Owner, 2026-09-20: "the whole task bar tray menu is completely different and
 * disconnected". Measured that day: the same six size rows sat under "Avatar
 * window size" on the tray and "Avatar window" on the avatar's menu, because
 * each caller passed its own `nest` map. The label is DATA here, so a group
 * cannot be called two things. A group with no entry renders flat.
 */
const GROUPS = Object.freeze({
  desktop: Object.freeze({ menu: "AitherOS Online" }),
  "window-size": Object.freeze({ menu: "Avatar window" }),
  stage: Object.freeze({ menu: "Stage" }),
  fleet: Object.freeze({ menu: "Fleet" }),
  arc: Object.freeze({ menu: "ARC" }),
  blog: Object.freeze({ menu: "Blog" }),
  sprite: Object.freeze({ menu: "Sprite" }),
  sandbox: Object.freeze({ menu: "Windows Sandbox" }),
  aw: Object.freeze({ menu: "aw tools" }),
  layout: Object.freeze({ menu: "Browser layout" }),
});

/**
 * Group ORDER per menu. Commands keep declaration order inside a group; a group
 * not named here follows the named ones in declaration order.
 *
 * The two menus answer different questions, so they lead with different groups:
 * the tray is "where do I go" (console, inbox, the desktop), a body's menu is
 * "what about THIS one" (talk to it, move it) and ends on the way out. The
 * ITEMS are one list; only the reading order differs.
 */
const LAYOUT = Object.freeze({
  tray: Object.freeze(["go", "desktop", "avatar", "window-size", "talk", "audio", "stage", "fleet", "arc", "blog", "sprite", "sandbox", "aw", "capture", "app"]),
  // ONE menu (owner, 2026-10-04: "the 3 different menu surfaces are still confusing").
  // A body's menu is the tray's menu with what is about THAT body on top: the rows
  // after "body"/"slot" read in exactly the tray's order, and the browser's Aither
  // button pops the tray's menu itself.
  "avatar-menu": Object.freeze(["talk", "body", "slot", "go", "sprite", "aw", "desktop", "avatar", "window-size", "stage"]),
  // The rail reads top to bottom: what is waiting, where to go, who to talk to,
  // the desktop. The bell stays on top -- it is the one bead read without a click.
  beads: Object.freeze(["go", "talk", "desktop"]),
});

/**
 * The inventory.
 *
 * - `id`        stable, dotted, never shown to anyone.
 * - `label`     a string, or (ctx) => string for the ones that count things.
 * - `surfaces`  where it appears. Order within a surface follows this array.
 * - `group`     menu separators are derived from a group change, never placed by hand.
 * - `dynamic`   the submenu is built by main at popup time (roster, sizes).
 * - `fleet`     a fleet/ARC verb (fleet-control.cjs ACTIONS, or `open_panel`);
 *               main routes it to fleetAction. `destructive` marks the ones a
 *               menu should not fire on a slip -- main confirms those first.
 * - `blog`      a blog verb (blog-commands.cjs BLOG_VERBS): main routes it to
 *               runBlogCommand, which speaks to the gateway's blog_* MCP tools.
 *               NO verb publishes: `publish` opens the Veil editor for a human.
 * - `prompt`    `{ placeholder }` -- the command needs ONE typed argument (a title,
 *               a slug). Only the palette has a text field, so a prompt command
 *               may name no other surface (`conformance()` refuses), and it still
 *               writes a `whySingle` like every other single-surface record.
 * - `whySingle` REQUIRED when `surfaces` names exactly one. It is the review note
 *               that stops another gesture-only affordance being born by accident.
 * - `menuLabel` the label INSIDE a nested group, where the parent already says
 *               the noun ("Stage ▸ Line them up"). The palette has no parent, so
 *               it keeps `label` ("Stage: line them up"). Same command, same id.
 * - `accel`     the global shortcut, in the form a human reads ("Ctrl+Shift+D").
 *               main REGISTERS shortcuts from this field and reports the ones it
 *               could not get in `ctx.deadAccels`; a label only advertises a key
 *               that is really bound. It used to be typed into the label text, so
 *               a key another app held was still promised on every menu.
 * - `scope`     "slot" -- the command is about ONE body. It renders only when
 *               `ctx.slotId` is set (a right-click that landed on a body) and its
 *               handler receives that slot. Off a body it does not exist, rather
 *               than existing as a row that acts on nothing.
 * - `when`      (ctx) => boolean. A row that does not apply is ABSENT.
 * - `enabled`   (ctx) => boolean. A row that applies but cannot act yet is greyed.
 * - `type` / `checked`  "checkbox" | "radio" with (ctx) => boolean, for the
 *               desktop's live switches. The state is main's; the row only reads it.
 */
const COMMANDS = Object.freeze([
  Object.freeze({
    id: "inbox.open", group: "go", icon: "bell",
    surfaces: ["tray", "palette", "beads", "jumplist"],
    label: (ctx = {}) => {
      const waiting = Number(ctx.decisionsWaiting || 0);
      const total = Number(ctx.decisionsTotal || 0);
      if (waiting > 0) return `Inbox — ${waiting} decision${waiting === 1 ? "" : "s"} waiting`;
      if (total > 0) return `Inbox — ${total} card${total === 1 ? "" : "s"}`;
      return "Inbox";
    },
  }),
  Object.freeze({
    // ADHD gap 3 (owner, 2026-11-01): the Inbox as ONE card on the whole window,
    // the next sliding in after each answer. Not a bead: the bell already opens
    // the Inbox, whose header carries the same Now button.
    id: "inbox.now", group: "go", icon: "bell",
    surfaces: ["tray", "palette"],
    label: (ctx = {}) => {
      const waiting = Number(ctx.decisionsWaiting || 0);
      return waiting > 0 ? `Now — one card at a time (${waiting})` : "Now — one card at a time";
    },
  }),
  Object.freeze({
    // The launcher's answer path (1-9 / typed option) declares itself here too, so
    // "where does answering appear?" has ONE answer. A menu row cannot carry the
    // card id, so the palette's text field is its manual path; the launcher calls
    // the same id directly.
    id: "card-answer", group: "go", icon: "bell",
    surfaces: ["palette"],
    prompt: Object.freeze({ placeholder: "<card id> <option key|number> — e.g. d-3f2a ack" }),
    whySingle: "Answers ONE named card, so it needs a card id the menus do not have in hand; the launcher's number keys/typed answers and the palette are the only places with that argument.",
    label: "Answer a decision card…",
  }),
  Object.freeze({
    // "Open Aither" since the browser became the console (plan slice 9): it raises the
    // Aither Browser on the Inbox, with AitherOS Online and Workspace pinned beside it.
    id: "console.open", label: "Open Aither", group: "go", icon: "grid",
    surfaces: ["tray", "avatar-menu", "palette", "beads", "jumplist"],
  }),
  // 🚩 AitherOS Online -- the Living Desktop held over the real one. It is what the
  // ecosystem registry says this app IS ("tray, avatars, decision cards, the Living
  // Desktop as an overlay"), and from 2026-09-13 to 2026-09-20 no human could open
  // it: the 09-13 menu consolidation deleted its two tray rows, this registry was
  // written five days later from the menus that were left, and the overlay was
  // never re-declared. It survived as a protocol URL, a CLI flag and an MCP tool
  // -- reachable by an agent, not by the owner. Its menu fragment
  // (buildLivingDesktopMenu) sat exported with zero callers the whole time.
  //
  // These records ARE that fragment, so the shell picker, ghost mode and sign-in
  // are on the tray, on every body's menu and in the palette, and a future
  // consolidation cannot drop them without failing `conformance()`'s reach test.
  Object.freeze({
    id: "desktop.overlay.toggle", group: "desktop", accel: "Ctrl+Shift+D", icon: "desktop",
    surfaces: ["tray", "avatar-menu", "palette", "beads", "jumplist"],
    label: (ctx = {}) => (ctx.overlayVisible ? "Hide AitherOS Online overlay" : "Open AitherOS Online overlay"),
    menuLabel: (ctx = {}) => (ctx.overlayVisible ? "Hide overlay" : "Open overlay"),
  }),
  Object.freeze({
    id: "desktop.app.open", label: "AitherOS Online: open as a window…", menuLabel: "Open as a window…",
    group: "desktop", surfaces: ["tray", "palette"],
  }),
  // Owner, 2026-10-05: closing the Desk left no way back but a terminal. One tap.
  Object.freeze({
    id: "desk.restart", label: "Restart Aither", group: "desktop", surfaces: ["tray", "palette"],
  }),
  // The shells mirror Veil's SHELL_REGISTRY (components/os/shell-registry.tsx). An
  // id Veil does not know falls back to the Living OS server-side, so a stale row
  // here degrades to the default rather than to a blank overlay.
  Object.freeze({
    id: "desktop.shell.living-os", label: "AitherOS Online shell: Living Desktop", menuLabel: "Shell: Living Desktop",
    group: "desktop", surfaces: ["tray", "palette"],
    shell: null, type: "radio", checked: (ctx = {}) => !ctx.overlayShell,
  }),
  Object.freeze({
    id: "desktop.shell.aither-desktop", label: "AitherOS Online shell: Desktop Anywhere", menuLabel: "Shell: Desktop Anywhere",
    group: "desktop", surfaces: ["tray", "palette"],
    shell: "aither-desktop", type: "radio", checked: (ctx = {}) => ctx.overlayShell === "aither-desktop",
  }),
  Object.freeze({
    id: "desktop.shell.aither-shell", label: "AitherOS Online shell: awsh cockpit", menuLabel: "Shell: awsh cockpit",
    group: "desktop", surfaces: ["tray", "palette"],
    shell: "aither-shell", type: "radio", checked: (ctx = {}) => ctx.overlayShell === "aither-shell",
  }),
  Object.freeze({
    id: "desktop.shell.gobbonet", label: "AitherOS Online shell: GobboNet", menuLabel: "Shell: GobboNet",
    group: "desktop", surfaces: ["tray", "palette"],
    shell: "gobbonet", type: "radio", checked: (ctx = {}) => ctx.overlayShell === "gobbonet",
  }),
  Object.freeze({
    id: "desktop.overlay.ghost", label: "AitherOS Online: click-through desktop", menuLabel: "Click-through desktop",
    group: "desktop", surfaces: ["tray", "palette"],
    type: "checkbox", checked: (ctx = {}) => Boolean(ctx.overlayGhost),
  }),
  Object.freeze({
    id: "desktop.overlay.solid", label: "AitherOS Online: solid background", menuLabel: "Solid background",
    group: "desktop", surfaces: ["tray", "palette"],
    type: "checkbox", checked: (ctx = {}) => Boolean(ctx.overlaySolid),
  }),
  Object.freeze({
    id: "desktop.overlay.reload", label: "AitherOS Online: reload", menuLabel: "Reload",
    group: "desktop", surfaces: ["tray", "palette"],
    enabled: (ctx = {}) => Boolean(ctx.overlayOpen),
  }),
  // Owner, 2026-10-01: "AITHERDESKTOP DOESNT SHOW ME AS SIGNED IN ... THERE IS NOWHERE
  // TO EVEN SIGN IN". The row now SAYS who the AitherDesktop window and the overlay
  // are signed in as (`ctx.account`, living-desktop-window.cjs accountStatus()), and
  // the click signs in BOTH windows (desk-session.cjs: auth.json, then the system
  // browser's idp.aitherium.com session -- nothing typed).
  Object.freeze({
    id: "desktop.signin", group: "desktop", surfaces: ["tray", "palette"],
    label: (ctx = {}) => (ctx.account && ctx.account.signedIn
      ? `AitherOS Online: signed in as ${ctx.account.username || "you"} (refresh)`
      : "AitherOS Online: sign in…"),
    menuLabel: (ctx = {}) => (ctx.account && ctx.account.signedIn
      ? `Signed in as ${ctx.account.username || "you"}`
      : "Sign in…"),
  }),
  // Owner, 2026-11-12: switching workspace was a tray-only picker, so awsh, an agent and
  // the palette could not do it and nothing said where the Desk was. One verb:
  // no arg = where you are + the list, `garg` / `aitherium` = go there. The label IS
  // the status line (law 3: restate state), so the palette row answers "where am I".
  Object.freeze({
    id: "workspace.switch", group: "desktop", surfaces: ["palette"],
    whySingle: "the tray already carries the owner's picker rows (desk-tenant-auto ownerTrayItems); this is the same switch by name for the palette, awsh /desk and agents",
    label: (ctx = {}) => `Workspace: ${(ctx.workspace && ctx.workspace.name) || "Aitherium"} — switch…`,
    when: (ctx = {}) => Boolean(ctx.workspace && ctx.workspace.owner),
  }),
  Object.freeze({
    id: "desktop.signout", label: "AitherOS Online: sign out", menuLabel: "Sign out",
    group: "desktop", surfaces: ["tray", "palette"],
    when: (ctx = {}) => Boolean(ctx.account && ctx.account.signedIn),
  }),
  // When the desk may raise the overlay BY ITSELF (overlay-policy.cjs, 2026-10-14: it
  // "randomly pops up on the side of the monitor"). All off by default; the rows above
  // (and the hotkey) always work. Same switches as Settings -> Desktop overlay.
  Object.freeze({
    id: "desktop.overlay.auto-start", label: "Open the desktop overlay when Aither starts",
    menuLabel: "Open the desktop overlay when Aither starts",
    group: "desktop", surfaces: ["tray", "palette"],
    type: "checkbox", checked: (ctx = {}) => Boolean(ctx.overlayPolicy && ctx.overlayPolicy.autoOpenOnStart),
  }),
  Object.freeze({
    id: "desktop.overlay.edge-reveal", label: "Reveal the overlay at the screen edge",
    menuLabel: "Reveal the overlay at the screen edge",
    group: "desktop", surfaces: ["tray", "palette"],
    type: "checkbox", checked: (ctx = {}) => Boolean(ctx.overlayPolicy && ctx.overlayPolicy.edgeReveal),
  }),
  Object.freeze({
    id: "desktop.overlay.raise-on-notify", label: "Bring the overlay forward for notifications",
    menuLabel: "Bring the overlay forward for notifications",
    group: "desktop", surfaces: ["tray", "palette"],
    type: "checkbox", checked: (ctx = {}) => Boolean(ctx.overlayPolicy && ctx.overlayPolicy.raiseOnNotifications),
  }),
  Object.freeze({
    id: "desktop.overlay.dnd", label: "Do not disturb", menuLabel: "Do not disturb",
    group: "desktop", surfaces: ["tray", "palette"],
    type: "checkbox", checked: (ctx = {}) => Boolean(ctx.overlayPolicy && ctx.overlayPolicy.doNotDisturb),
  }),
  // BeadSpace as home (space-home.cjs): the Settings pane's row, and this id for the
  // palette and POST /commands/run. Deliberately NOT on the tray: one switch, one place.
  Object.freeze({
    id: "desktop.space-home", label: "Inbox and Fleet open into Space",
    group: "desktop", surfaces: ["palette"],
    whySingle: "A settings switch, not a door: its row is in Settings (Desktop overlay); the palette and POST /commands/run are its keyboard and agent paths (owner, 2026-10-15: no more menus).",
    type: "checkbox", checked: (ctx = {}) => Boolean(ctx.overlayPolicy && ctx.overlayPolicy.spaceHome),
  }),
  // Companion (owner 2026-11-02): the fairy is the default; the full avatar is opt-in.
  // main.cjs companionMode()/setCompanionMode(); exactly one row shows.
  Object.freeze({
    id: "companion.fairy", label: "Companion: fairy only", group: "avatar",
    surfaces: ["tray", "palette"], when: (ctx = {}) => ctx.companion === "avatar",
  }),
  Object.freeze({
    id: "companion.avatar", label: "Companion: full avatar", group: "avatar",
    surfaces: ["tray", "palette"], when: (ctx = {}) => ctx.companion !== "avatar",
  }),
  Object.freeze({
    id: "avatar.toggle", group: "avatar", accel: "Ctrl+Shift+A",
    surfaces: ["tray", "palette"],
    label: (ctx = {}) => (ctx.avatarShown ? "Hide avatar" : "Show avatar"),
  }),
  // The layers (owner, 2026-10-04: "the avatar should be attached to the Aither
  // Browser and the browser just forms around it like a shell"). Docked, the avatar
  // sits in the browser rail and moves with it; floating, it is the desktop overlay
  // it always was. avatar-dock.cjs; the rail's layer strip runs the same id.
  Object.freeze({
    id: "avatar.dock", group: "avatar", icon: "layers",
    surfaces: ["tray", "avatar-menu", "palette"],
    label: (ctx = {}) => (ctx.avatarDocked ? "Float the avatar on the desktop" : "Dock the avatar in the browser"),
  }),
  // 🚩 The commands this registry was born for. They are on the tray as well as
  // the avatar's own menu because that menu needs a right-click that lands on a
  // BODY: with the avatar hidden, tiny or off-screen there was no path at all.
  //
  // The presets are DATA here rather than a submenu main builds, so the palette
  // can list them one per row while the menus nest them. A dynamic submenu is
  // invisible to anything that is not a menu -- which is how "size" stayed
  // unreachable from everywhere except one gesture.
  Object.freeze({
    id: "window.size.small", label: "Small", group: "window-size",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", size: Object.freeze({ width: 430, height: 680 }),
  }),
  Object.freeze({
    id: "window.size.medium", label: "Medium", group: "window-size",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", size: Object.freeze({ width: 600, height: 950 }),
  }),
  Object.freeze({
    id: "window.size.large", label: "Large", group: "window-size",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", size: Object.freeze({ width: 800, height: 1266 }),
  }),
  Object.freeze({
    id: "window.size.xlarge", label: "Extra large", group: "window-size",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", size: Object.freeze({ width: 1000, height: 1583 }),
  }),
  Object.freeze({
    id: "window.size.bigger", label: "Avatar window: bigger", menuLabel: "Bigger",
    group: "window-size", accel: "Ctrl+Shift+=",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.",
  }),
  Object.freeze({
    id: "window.size.smaller", label: "Avatar window: smaller", menuLabel: "Smaller",
    group: "window-size", accel: "Ctrl+Shift+-",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.",
  }),
  // These two lived ONLY in the hand-written avatar menu, appended after the
  // registry's size rows -- so the tray's "Avatar window size" and the body's
  // "Avatar window" were different menus with different contents.
  Object.freeze({
    id: "window.outline", label: "Avatar window: show / hide its boundary", menuLabel: "Show / hide boundary",
    group: "window-size", surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.",
  }),
  Object.freeze({
    id: "layout.reset-all", label: "Avatar window: reset every avatar's layout (reload)",
    menuLabel: "Reset every avatar's layout (reload)",
    group: "window-size", surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.",
  }),
  // 🚩 "Talk" meant TWO things under THREE labels (measured 2026-09-20): the tray's
  // "Talk to the agents" toggled the MICROPHONE, the avatar menu's "Talk to <agent>"
  // and the chat bead's "Talk to Aither" opened the CHAT pane -- and the avatar
  // menu's row sat where the registry said voice.talk lived, so the mic was
  // unreachable from the one surface you are looking at a body on. One verb per
  // meaning now: you SPEAK with your voice, you CHAT in the pane.
  //
  // Plan 40 slice C: the label says which way the toggle goes, because a button
  // that might already be listening is a button nobody presses.
  Object.freeze({
    id: "voice.talk", group: "talk", accel: "Ctrl+Shift+Space", icon: "mic",
    surfaces: ["tray", "avatar-menu", "palette", "jumplist"],
    label: (ctx = {}) => {
      if (ctx.talkMode === "open") return ctx.openMic ? "Turn open mic off" : "Turn open mic on";
      return ctx.listening ? "Stop listening" : "Speak to the agents (microphone)";
    },
  }),
  // Plan: configurable voice + hotkeys (owner 2026-09-22: "let you click on the
  // avatar... enable voice mode or mute"). A dedicated mute toggle separate from
  // voice.talk: muting must not depend on remembering whether you were mid-listen.
  Object.freeze({
    id: "voice.mute", group: "talk", accel: "Ctrl+Shift+M", icon: "mic-off",
    surfaces: ["tray", "avatar-menu", "palette"],
    label: (ctx = {}) => (ctx.micMuted ? "Unmute microphone" : "Mute microphone"),
  }),
  // Agent VOICES, not the mic (owner, 2026-10-04: "there is no way to unmute an
  // agent voice"). voice.muted lived only behind a checkbox in the Voices pane,
  // so once set it looked permanent. Both rows say which way they go.
  Object.freeze({
    id: "voice.mute-all", group: "talk", accel: "Ctrl+Alt+M", icon: "volume-off",
    surfaces: ["tray", "avatar-menu", "palette"],
    label: (ctx = {}) => (ctx.voiceMuted ? "Unmute all voices" : "Mute all voices"),
  }),
  Object.freeze({
    id: "voice.mute-agent", group: "talk", scope: "slot", icon: "volume-off",
    surfaces: ["avatar-menu"],
    label: (ctx = {}) => {
      const who = ctx.agent || "this agent";
      return ctx.agentMuted ? `Unmute ${who}'s voice` : `Mute ${who}'s voice`;
    },
    whySingle: "Mutes the agent behind the body that was right-clicked; voice.mute-all is the everywhere twin.",
  }),
  // ── SYSTEM AUDIO (owner, 2026-11-02: "hot keys and better way to control audio
  // / system speaker and mic settings"). These act on the WINDOWS endpoints --
  // voice.mute above mutes the desk's own call microphone, a different thing.
  // system-audio.cjs reads/writes Core Audio; audio-control.cjs owns the OSD and
  // the Audio flyout. accelFallback exists because graphics drivers also bind
  // Ctrl+Alt+Arrow on some machines: if Windows refuses the default, the Desk
  // still gets a key instead of a dead row (main reports it in liveAccels).
  Object.freeze({
    id: "audio.volume.up", label: "Speaker volume up 5%", group: "audio",
    accel: "Ctrl+Alt+Up", accelFallback: "Ctrl+Alt+Shift+Up", icon: "volume",
    surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "audio.volume.down", label: "Speaker volume down 5%", group: "audio",
    accel: "Ctrl+Alt+Down", accelFallback: "Ctrl+Alt+Shift+Down", icon: "volume",
    surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "audio.mute", group: "audio", accel: "Ctrl+Alt+0", icon: "volume-off",
    surfaces: ["tray", "palette"],
    label: (ctx = {}) => (ctx.speakerMuted ? "Unmute speakers" : "Mute speakers"),
  }),
  Object.freeze({
    id: "audio.mic.mute", group: "audio", accel: "Ctrl+Alt+9", icon: "mic-off",
    surfaces: ["tray", "palette"],
    label: (ctx = {}) => (ctx.systemMicMuted ? "Unmute microphone (system)" : "Mute microphone (system)"),
  }),
  Object.freeze({
    id: "audio.settings", label: "Audio settings…", group: "audio", icon: "volume",
    surfaces: ["tray", "palette"],
  }),
  // The settings page the owner asked for by name ("there still isnt just a
  // shared settings page"). Opens as a console pane (kind:"file", no vite
  // build) so it ships without touching the React bundle.
  Object.freeze({
    id: "settings.open", group: "avatar", accel: "Ctrl+Shift+,", icon: "settings",
    surfaces: ["tray", "palette"],
    label: "Settings…",
  }),
  Object.freeze({
    id: "chat.open", group: "talk", icon: "chat",
    surfaces: ["tray", "avatar-menu", "palette", "beads"],
    label: (ctx = {}) => `Chat with ${ctx.agent || "Aither"}…`,
  }),
  // U27, the second half of the same regression: talking to a session meant
  // finding its body first. Not on tray -- "this session" is meaningless
  // without a body or a palette row already scoped to one, unlike cast.open.
  // On a body with no live session behind it the row is greyed, not hidden: it
  // tells you an ordinary character has nobody to steer.
  Object.freeze({
    id: "room.steer", label: "Message this session…", group: "talk",
    surfaces: ["avatar-menu", "palette"],
    enabled: (ctx = {}) => !ctx.slotId || Boolean(ctx.sessionAddress),
  }),
  // The body verbs. They were literals in popupAvatarMenu; as records they are
  // also palette rows ("frame everyone" needs no body) and the handler is the
  // one runCommand switch instead of five closures.
  Object.freeze({
    id: "avatar.focus", label: "Focus camera here", group: "body", scope: "slot",
    surfaces: ["avatar-menu"],
    whySingle: "'Here' is the body that was right-clicked; no other surface has a body in hand. "
      + "stage.focus is the unscoped twin on the tray and the palette.",
  }),
  Object.freeze({
    id: "avatar.frame-all", label: "Frame everyone", group: "body",
    surfaces: ["avatar-menu", "palette"],
  }),
  Object.freeze({
    id: "avatar.reset", label: "Reset position & size", group: "body", scope: "slot",
    surfaces: ["avatar-menu"],
    whySingle: "Resets ONE body, so it needs the body that was right-clicked. "
      + "layout.reset-all is the everywhere twin.",
  }),
  Object.freeze({
    id: "characters.pick", label: "Characters", group: "avatar",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", dynamic: true,
  }),
  // U27 (owner, 2026-09-19): today the ONLY way to assign an agent's avatar a
  // voice/cast identity is the same nested tray submenu this file was built to
  // replace -- reachable only from whichever character is resident right now.
  // ONE door to everything about bodies (owner, 2026-10-03: "why so many separate
  // menus and screens and options just to manage stage/avatars/vroid"): the console's
  // Stage pane -- who is on stage, Characters (VRoid/market) and Voices as tabs, and
  // the avatar window's size. It replaces Stage ▸, Avatar window ▸, Characters ▸ and
  // Cast & voices… on the tray and on every body's menu.
  Object.freeze({
    id: "stage.open", label: "Stage & characters…", group: "avatar",
    surfaces: ["tray", "avatar-menu", "palette"],
  }),
  // cast.open is the one door onto cast.json (U01) from all three surfaces.
  Object.freeze({
    id: "cast.open", label: "Cast & voices…", group: "avatar",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.",
  }),
  // Plan 40 slice G, "think macOS Stage Manager": the verbs for a stage with
  // several bodies on it. Arranging four avatars by dragging each one is the work
  // this removes, and on a frameless overlay it is also the least accurate work
  // there is. The renderer owns the geometry; a command only names the shape.
  Object.freeze({
    id: "stage.row", label: "Stage: line them up", menuLabel: "Line them up", group: "stage",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", arrangement: "row",
  }),
  Object.freeze({
    id: "stage.arc", label: "Stage: gather in an arc", menuLabel: "Gather in an arc", group: "stage",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", arrangement: "arc",
  }),
  Object.freeze({
    id: "stage.pair", label: "Stage: face each other", menuLabel: "Face each other", group: "stage",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", arrangement: "pair",
  }),
  Object.freeze({
    id: "stage.focus", label: "Stage: focus one, others step back", menuLabel: "Focus one, others step back", group: "stage",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", arrangement: "focus",
  }),
  Object.freeze({
    id: "stage.reset", label: "Stage: reset everyone", menuLabel: "Reset everyone", group: "stage",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", arrangement: "reset",
  }),
  Object.freeze({
    id: "avatar.remove", label: "Remove this avatar", group: "slot", scope: "slot",
    surfaces: ["avatar-menu"], when: (ctx = {}) => Boolean(ctx.removable),
    whySingle: "Removes ONE spawned body, so it needs the body that was right-clicked; the "
      + "Stage pane's 'Send away' is the same action with the body chosen from a list.",
  }),
  // Command and control (owner, 2026-09-19: "i need controls in awdesk and awsh").
  // Until today the fleet verbs lived on ONE page (the Fleet window) and the ARC
  // verbs lived nowhere a human could click -- a solver that had been stopped
  // twice overnight could only be restarted from a shell. A `fleet` record is
  // DATA: main hands the verb to the same runner the Fleet window and the MCP
  // `fleet_control` tool use, so a tray click, a palette row, an awsh command
  // and an agent call execute the same script with the same argv.
  // Lend memory (kv-lend.cjs): this computer holds part of the owner's model context, only
  // on AC power, idle and with no game running; the owner's workspace still decides.
  Object.freeze({
    id: "device.connect", label: "Connect this computer to my workspace…", menuLabel: "Connect this computer…",
    group: "fleet", surfaces: ["tray", "palette"],
  }),
  // Nearby devices (nearby-devices.cjs): what is in pairing mode on this Wi-Fi, for 5 minutes;
  // approving opens the signed-in Devices tab where the device's code and number are typed.
  Object.freeze({
    id: "device.nearby", label: "Add a nearby device…", menuLabel: "Nearby devices…",
    group: "fleet", surfaces: ["tray", "palette"],
  }),
  // Owner, 2026-10-04 (Steam Deck): nothing typed. awdk, awnode, awsh, household and mesh
  // install per-user from here (local-stack.cjs runs aitherium.com/install.sh).
  Object.freeze({
    id: "local.install", label: "Install the full local stack…", menuLabel: "Install the full local stack…",
    group: "fleet", surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "kvlend.toggle", label: "Lend memory to my models", menuLabel: "Lend memory",
    group: "fleet", surfaces: ["tray", "palette"],
    type: "checkbox", checked: (ctx = {}) => Boolean(ctx.kvLend),
  }),
  Object.freeze({
    id: "fleet.open", label: "Fleet window…", group: "fleet",
    surfaces: ["tray", "palette"], fleet: "open_panel",
  }),
  // The inference widget (owner, 2026-09-27): a compact always-on-top list of
  // every inference node and model with live load, and Restart / Probe / Logs
  // through the same Veil actions API the web board /workspace/ops uses.
  Object.freeze({
    id: "inference.open", label: "Inference ops widget…", group: "fleet",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.",
  }),
  // The Disk Explorer (disk index contract, Surfaces lane): tree / search / dupes
  // / proposals / shares over the caller's own indexed disks. Every destructive
  // outcome is a proposal whose decision card a human answers -- never a verb here.
  Object.freeze({
    id: "disk.open", label: "Disk Explorer…", group: "go",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.",
  }),
  // Darkmatter Link (2026-10-14): agents inside the owner's games, as an app in the desk --
  // never its own installer (one installable app per platform). Supervisor, game health,
  // pawn personas, model access and the opt-in training-data toggle (darkmatter-link.cjs).
  Object.freeze({
    id: "darkmatter.open", label: "Darkmatter Link…", group: "go",
    surfaces: ["palette", "jumplist"],
  }),
  // Local AI (customer ask 2026-10-22): a model on THIS computer that keeps the chat going
  // when the workspace is offline (local-ai.cjs). On the tray so a customer finds it in
  // two clicks, and on the jump list for when the workspace window will not load.
  Object.freeze({
    id: "localai.open", label: "Local AI…", group: "go",
    surfaces: ["tray", "palette", "jumplist"],
  }),
  // Agent notebooks (owner, 2026-10-27: "how do I discover / find them, view them, replay
  // them"): aither://notebooks -- this computer's index first, the platform merged in.
  Object.freeze({
    id: "notebooks.open", label: "Notebooks…", group: "go",
    surfaces: ["palette"],
    whySingle: "A Console pane (Agents section) already; the palette (Ctrl+K) is its keyboard path.",
  }),
  // Aither Files (files-window.cjs): the owner's File Explorer replacement --
  // tabs, breadcrumb + address bar, list/grid with thumbnails, preview, new
  // folder / rename / copy / move / delete-to-Recycle-Bin, Send to Aitherium, Ask
  // Aither. Win+E can open it (files-wine.cjs, owner-consented, reversible).
  Object.freeze({
    id: "files.open", label: "Files…", group: "go", icon: "folder",
    surfaces: ["palette", "jumplist"],
  }),
  // Strata (the console's storage page: tiers, artifacts, the mesh file index). The
  // desktop right-click menu opens it directly (owner, 2026-11-07).
  Object.freeze({
    id: "strata.open", label: "Strata storage", group: "go", icon: "database",
    surfaces: ["palette", "jumplist"],
  }),
  // The awsh surface (aither://terminal): the radial's "awsh" slice and one tray row.
  // Same page the browser's console opens; no second terminal exists.
  Object.freeze({
    id: "terminal.open", label: "awsh terminal", group: "go", icon: "terminal",
    surfaces: ["palette", "tray"],
  }),
  // Universal search (owner, 2026-11-01: replace Windows' Start search). One box over
  // apps, files, screenshots, clipboard, desk actions and agents/tools/skills
  // (universal-search.cjs); the window is search-window.cjs toggleLauncher. Alt+Space,
  // because Electron cannot register Win-key combos (the shell reserves Win+S).
  // `accelFallback`: measured 2026-11-01, PowerToys Run holds Alt+Space on the owner's
  // box, so the key was dead and the launcher had no shortcut at all. main tries the
  // fallback when the first key is refused, and the label names the live one.
  Object.freeze({
    id: "search.universal", label: "Search this PC…", group: "go", accel: "Alt+Space",
    accelFallback: "Ctrl+Alt+Space",
    surfaces: ["tray", "palette"],
  }),
  // Public URL (tunnel-window.cjs): give one local port a public URL via the
  // awtunnel CLI; fleet internals (8182/8150/8151/8111/8001/5432) are refused
  // unless the owner ticks the explicit override.
  Object.freeze({
    id: "tunnel.open", label: "Public URL for a port…", group: "go",
    surfaces: ["palette"],
    whySingle: "A utility, not a destination (owner, 2026-10-03: too many menus); the palette (Ctrl+K) and the System window's port rows are its paths.",
  }),
  // The System window (owner, 2026-11-01: "stop using Task Manager, Resource Monitor and
  // netstat"): processes, ports, connections, adapters, startup apps. system-monitor*.cjs.
  // Windows itself owns Ctrl+Shift+Esc; when register() is refused the key lands in
  // deadAccels and the label stops promising it.
  Object.freeze({
    id: "system.open", label: "System (processes & network)…", menuLabel: "System…", group: "go",
    accel: "Ctrl+Shift+Escape", surfaces: ["tray", "palette"],
  }),
  // The Aither Browser (browser-window.cjs): a browser INSIDE the desk where an
  // agent drives (MCP browser_* tools) while the owner watches and can take over,
  // and where the owner browses with an "Ask about this page" panel.
  // 2026-10-03: it was tray + palette only, with no icon, and the owner could find
  // no app to launch it from. It is a bead, a body-menu row, a jump-list task and
  // an Aither Console launcher (console-window.cjs LAUNCHERS) now.
  Object.freeze({
    id: "browser.open", label: "Aither Browser…", group: "go", icon: "globe",
    surfaces: ["palette", "beads", "jumplist"],
  }),
  // ── the browser's layout and the pin canvas (owner, 2026-11-07: "resize and
  // detach/reattach, reorganize and rearrange, and have access to a canvas for pinning
  // apps and widgets"). DATA rows: `layout` is the verb browser-window.layoutCommand
  // runs, so every drag, right-click and Customize-panel button has a palette path
  // (docs/UX-REIMPLEMENTATION.md: no capability is gesture-only). One commented block.
  Object.freeze({
    id: "layout.edit", label: "Browser: edit layout (move, detach, hide panes)", menuLabel: "Edit layout",
    group: "layout", layout: "edit", surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "layout.preset.default", label: "Browser layout: Default", menuLabel: "Default", group: "layout",
    layout: "preset:Default", surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "layout.preset.focus", label: "Browser layout: Focus (rail collapsed, no panel)", menuLabel: "Focus", group: "layout",
    layout: "preset:Focus", surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "layout.preset.ops", label: "Browser layout: Ops (tall dock, wide panel)", menuLabel: "Ops", group: "layout",
    layout: "preset:Ops", surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "layout.save", label: "Browser layout: save as…", group: "layout", layout: "save",
    surfaces: ["palette"], prompt: Object.freeze({ placeholder: "Name for this layout" }),
    whySingle: "Needs a typed name (only the palette has a text field); the browser's Customize panel has Save as.",
  }),
  Object.freeze({
    id: "layout.load", label: "Browser layout: load a saved layout…", group: "layout", layout: "load",
    surfaces: ["palette"], prompt: Object.freeze({ placeholder: "Name of a saved layout" }),
    whySingle: "Needs a typed name; the Customize panel's layout picker is the mouse path.",
  }),
  Object.freeze({
    id: "layout.export", label: "Browser layout: export to a file…", menuLabel: "Export…", group: "layout",
    layout: "export", surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "layout.import", label: "Browser layout: import from a file…", menuLabel: "Import…", group: "layout",
    layout: "import", surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "layout.reset", label: "Browser layout: reset", menuLabel: "Reset", group: "layout",
    layout: "reset", surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "layout.move-pane", label: "Browser layout: move a pane…", group: "layout", layout: "side",
    surfaces: ["palette"], prompt: Object.freeze({ placeholder: "panel left | dock top | rail right | avatar bottom | layers top" }),
    whySingle: "Needs a pane and a side typed; edit-layout mode's drop zones and buttons are the mouse path.",
  }),
  Object.freeze({
    id: "layout.detach-pane", label: "Browser layout: detach a pane into its own window…", group: "layout", layout: "detach",
    surfaces: ["palette"], prompt: Object.freeze({ placeholder: "panel | dock | taskbar" }),
    whySingle: "Needs a pane typed; edit-layout mode's Detach buttons are the mouse path.",
  }),
  Object.freeze({
    id: "layout.attach-pane", label: "Browser layout: reattach a pane…", group: "layout", layout: "attach",
    surfaces: ["palette"], prompt: Object.freeze({ placeholder: "panel | dock | taskbar" }),
    whySingle: "Needs a pane typed; edit-layout mode's Reattach button and closing the pane's window are the mouse paths.",
  }),
  Object.freeze({
    id: "layout.layers", label: "Browser layout: show or hide the layer tiles", menuLabel: "Layer tiles", group: "layout",
    layout: "layers", surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "rail.pin", label: "Rail: pin a row…", group: "layout", layout: "rail.pin",
    surfaces: ["palette"], prompt: Object.freeze({ placeholder: "Row name (e.g. Files)" }),
    whySingle: "Needs a row named; right-click a rail row for the mouse path.",
  }),
  Object.freeze({
    id: "rail.remove", label: "Rail: remove a row…", group: "layout", layout: "rail.remove",
    surfaces: ["palette"], prompt: Object.freeze({ placeholder: "Row name (e.g. Chaos)" }),
    whySingle: "Needs a row named; right-click a rail row for the mouse path.",
  }),
  Object.freeze({
    id: "rail.move", label: "Rail: move a row…", group: "layout", layout: "rail.move",
    surfaces: ["palette"], prompt: Object.freeze({ placeholder: "Files up | Files down | Files to Work" }),
    whySingle: "Needs a row and a direction typed; dragging in edit-layout mode and Alt+Up/Down on a row are the other paths.",
  }),
  Object.freeze({
    id: "rail.restore", label: "Rail: restore removed rows", menuLabel: "Restore removed rail rows", group: "layout",
    layout: "rail.restore", surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "canvas.open", label: "Canvas: pinned apps and widgets", menuLabel: "Canvas", group: "go", icon: "grid",
    layout: "canvas.open", surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "canvas.pin-tab", label: "Canvas: pin the current tab", group: "layout", layout: "canvas.pin-tab",
    surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "canvas.pin-url", label: "Canvas: pin an address…", group: "layout", layout: "canvas.pin-url",
    surfaces: ["palette"], prompt: Object.freeze({ placeholder: "https://… or aither://fleet" }),
    whySingle: "Needs an address typed; the canvas page's own Pin field and a tab's right-click are the mouse paths.",
  }),
  // Aither Hearth (2026-09-30): the owner's PLATFORM Hearth -- reminders, approval
  // cards, signed receipts -- as the `hearth` window on the AitherDesktop app. The
  // cards are answered there, by the owner; no row here approves anything.
  Object.freeze({
    id: "hearth.open", label: "Hearth…", group: "go",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.",
  }),
  // The Aither app's own apps (2026-10-03, one app per platform): the same OS windows the
  // phone's shortcuts open, on the AitherDesktop app window (`?app=<osApp>`). DATA rows:
  // main.cjs opens any record that carries `osApp`, so a new one is a line here.
  Object.freeze({
    id: "osapp.family", label: "Family…", group: "go", osApp: "family",
    surfaces: ["palette", "jumplist"],
  }),
  // Owner, 2026-10-05: "why is mission control so buried???" It lives at
  // app.aitherium.com/mission-control; this row is its palette/tray door.
  Object.freeze({
    id: "missioncontrol.open", label: "Mission Control", group: "go",
    surfaces: ["palette", "tray"],
  }),
  // The desk's own snipping tool + clipboard mirror (owner, 2026-11-01: "stop using
  // the Windows Snipping Tool"). snip-window.cjs / clipboard-sync.cjs; both upload to
  // the owner's AitherOS Online folders through strata-sync.cjs.
  Object.freeze({
    id: "snip.region", label: "Snip a region", group: "capture", accel: "PrintScreen",
    surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "snip.screen", label: "Snip the whole screen", group: "capture",
    surfaces: ["tray", "palette"],
  }),
  // ── the floating ask orb (orb-window.cjs, owner 2026-11-02: "click and ask it
  // what it sees ... a floating orb with a chat bubble on your desktop"). The
  // `orb` field is the verb main hands orb-window.run(); the accel is the summon
  // key. Ctrl+Alt+O / Ctrl+Alt+W were measured free of every other row here.
  Object.freeze({
    id: "orb.toggle", label: "Show or hide the ask orb", group: "go",
    accel: "Ctrl+Alt+O", accelFallback: "Ctrl+Alt+Shift+O",
    surfaces: ["tray", "palette"], orb: "toggle",
  }),
  Object.freeze({
    id: "orb.ask-screen", label: "Ask Aither about my screen", group: "capture",
    accel: "Ctrl+Alt+W", accelFallback: "Ctrl+Alt+Shift+W",
    surfaces: ["tray", "palette"], orb: "ask-screen",
  }),
  // ── the spirit (orb-window.cjs, owner 2026-11-02: "integrate with the awdesk
  // avatar/persona too" · "make the spirit attachable/detachable" · "awdesk avatars
  // ... can send the spirit orb to do stuff around the desktop, go look at files,
  // for context" · "go find this file and give me the path" · "and things like web
  // searches too!"). One commented block: other lanes merge this file 3-way.
  // `orb` is the verb run() hands orb-window.run(). A slot-scoped row CANNOT carry
  // a prompt (conformance: a prompt only lives on the palette), so a body's row
  // opens the bubble's field with that body's slot remembered for the answer.
  Object.freeze({
    id: "spirit.ask-screen", label: "Ask what's on my screen", group: "body", scope: "slot",
    surfaces: ["avatar-menu"], orb: "ask-screen",
    whySingle: "The body that was right-clicked is the one that answers, in its voice; "
      + "no other surface has a body in hand. orb.ask-screen is the unscoped twin.",
  }),
  Object.freeze({
    id: "spirit.find-file", label: "Find a file…", group: "body", scope: "slot",
    surfaces: ["avatar-menu"], orb: "find",
    whySingle: "A trip dispatched by THIS body, which speaks the result; the bubble's "
      + "field takes the query because an avatar menu has no text field.",
  }),
  Object.freeze({
    id: "spirit.web-search", label: "Search the web…", group: "body", scope: "slot",
    surfaces: ["avatar-menu"], orb: "web",
    whySingle: "A web trip dispatched by THIS body, which speaks the answer; the "
      + "bubble's field takes the query. spirit.go is the palette's general door.",
  }),
  // The fairy's right-click menu, reachable from the keyboard (owner 2026-11-12:
  // "menus are navigable"). It opens beside the fairy; arrows, Enter and Esc work.
  Object.freeze({
    id: "fairy.menu", label: "Open the fairy menu", group: "go",
    surfaces: ["palette"], orb: "menu",
    whySingle: "A right click on the fairy is the pointer's door; this row is the keyboard's "
      + "and the bridge's (POST /commands/run). The tray has its own menu already.",
  }),
  Object.freeze({
    id: "spirit.attach-toggle", label: "Attach or detach the spirit", group: "go",
    accel: "Ctrl+Alt+G", accelFallback: "Ctrl+Alt+Shift+G",
    surfaces: ["tray", "palette"], orb: "attach",
  }),
  Object.freeze({
    id: "spirit.go", label: "Send the spirit…", group: "go",
    surfaces: ["palette"], orb: "go",
    prompt: Object.freeze({ placeholder: 'JSON {kind,target,question?}, or "find notes.md"' }),
    whySingle: "Agents reach it over the bridge (POST /commands/run only runs a palette "
      + "row); a person reaches it in the palette. The tray carries the named verbs instead.",
  }),
  // ── the fairy IS the owner's AitherSprite (owner 2026-11-02). sprite-core.cjs
  // reads/teaches through the portal's /api/sprite/* as the signed-in owner; the
  // orb verbs live in orb-window.run(). No `prompt`: Alt+Space and the menus run
  // these too, and a teach with nothing typed takes the highlighted selection
  // (UI Automation, no faked keys), else the clipboard, else the last snip's
  // caption -- the bubble field is the typed path.
  Object.freeze({
    id: "sprite.teach", label: "Teach my sprite the selection / clipboard", menuLabel: "Teach it the selection",
    group: "sprite", surfaces: ["tray", "palette", "avatar-menu"], orb: "sprite-teach",
  }),
  Object.freeze({
    id: "sprite.status", label: "How is my sprite?", menuLabel: "How is it?",
    group: "sprite", surfaces: ["tray", "palette", "avatar-menu"], orb: "sprite-status",
  }),
  Object.freeze({
    id: "sprite.open", label: "Open my sprite (aitherium.com)", menuLabel: "Open Sprite…",
    group: "sprite", surfaces: ["tray", "palette", "avatar-menu"], orb: "sprite-open",
  }),
  // ── Windows Sandbox (sandbox-detonate.cjs): a file you do not trust runs in a
  // fresh throwaway guest with networking OFF. The picker only PREPARES a confirm
  // card naming the file, its size and its SHA-256; the owner's click on that card
  // is the confirmation, and nothing reaches the daemon before it. doctor's "not
  // ready" text is shown verbatim -- the desk never elevates on its own.
  Object.freeze({
    id: "sandbox.detonate", label: "Detonate a file in Windows Sandbox…", menuLabel: "Detonate a file in a sandbox…",
    group: "sandbox", surfaces: ["tray", "palette"],
  }),
  // ── the aw* CLIs (aw-cli.cjs): system binaries via execFile, 30 s cap, output in
  // the orb's bubble. A verb that needs a query opens the bubble's field when run
  // with nothing typed (the avatar-menu has no text field; see spirit.find-file).
  Object.freeze({
    id: "aw.memory.recall", label: "aw: recall from memory (awm)…", menuLabel: "Recall from memory…",
    group: "aw", surfaces: ["tray", "palette", "avatar-menu"], orb: "aw-recall",
  }),
  Object.freeze({
    id: "aw.graph.query", label: "aw: query the code graph (awgraph)…", menuLabel: "Query the code graph…",
    group: "aw", surfaces: ["tray", "palette", "avatar-menu"], orb: "aw-graph",
  }),
  Object.freeze({
    id: "aw.git.status", label: "aw: git state (awgit)", menuLabel: "Git state",
    group: "aw", surfaces: ["tray", "palette", "avatar-menu"], orb: "aw-git",
  }),
  Object.freeze({
    id: "aw.recover", label: "aw: list snapshots (awrecover)…", menuLabel: "List snapshots…",
    group: "aw", surfaces: ["tray", "palette", "avatar-menu"], orb: "aw-recover",
  }),
  Object.freeze({
    // Undoable by construction: awrecover moves the current dest aside, never deletes it.
    id: "aw.recover.restore", label: "aw: restore a snapshot (awrecover)…", menuLabel: "Restore a snapshot…",
    group: "aw", surfaces: ["tray", "palette", "avatar-menu"], orb: "aw-recover-restore",
  }),
  Object.freeze({
    id: "aw.settings.sync", label: "aw: pull synced settings (awsettings)", menuLabel: "Pull synced settings",
    group: "aw", surfaces: ["tray", "palette", "avatar-menu"], orb: "aw-settings",
  }),
  Object.freeze({
    id: "clipboard.sync.toggle", label: "Sync clipboard to AitherOS Online", group: "capture",
    surfaces: ["tray", "palette"],
    type: "checkbox", checked: (ctx = {}) => Boolean(ctx.clipboardSync),
  }),
  // Windows 11 hands PrtSc to Snipping Tool until HKCU PrintScreenKeyForSnippingEnabled
  // is 0. Flipping it is the owner's one-time consent; the twin row undoes it.
  Object.freeze({
    id: "snip.printscreen.claim", label: "Use Aither for Print Screen", group: "capture",
    surfaces: ["tray", "palette"],
    when: (ctx = {}) => ctx.platform === "win32" && ctx.printScreenOwner !== "aither",
  }),
  Object.freeze({
    id: "snip.printscreen.restore", label: "Restore Windows Snipping Tool", group: "capture",
    surfaces: ["tray", "palette"],
    when: (ctx = {}) => ctx.platform === "win32" && ctx.printScreenOwner === "aither",
  }),
  // The desk's screen recorder (owner 2026-11-01: replace the Windows utilities).
  // recorder-window.cjs; the region overlay IS the snipping tool's snip.html; the
  // saved MP4/GIF uploads to the owner's Strata `screenshots` folder (strata-sync.cjs).
  Object.freeze({
    id: "record.region", group: "capture", accel: "Shift+PrintScreen",
    label: (ctx = {}) => (ctx.recording ? "Stop recording" : "Record a region"),
    surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "record.screen", label: "Record the whole screen", group: "capture",
    surfaces: ["tray", "palette"],
    when: (ctx = {}) => !ctx.recording,
  }),
  Object.freeze({
    id: "record.region.audio", label: "Record a region with sound (system + mic)", group: "capture",
    surfaces: ["palette"],
    when: (ctx = {}) => !ctx.recording,
    whySingle: "A variant of Record a region; the tray carries the plain verb, the palette (Ctrl+K) carries the options.",
  }),
  Object.freeze({
    id: "record.region.gif", label: "Record a region as GIF", group: "capture",
    surfaces: ["palette"],
    when: (ctx = {}) => !ctx.recording,
    whySingle: "A variant of Record a region; the tray carries the plain verb, the palette (Ctrl+K) carries the options.",
  }),
  Object.freeze({
    id: "record.pause", label: "Pause / resume recording", group: "capture",
    surfaces: ["tray", "palette"],
    when: (ctx = {}) => Boolean(ctx.recording),
    // ACCEL (owner 2026-11-02: the bar must name a Pause hotkey). Ctrl+Alt+P is free
    // against every other accel in this registry; Ctrl+Alt+Shift+P is the fallback
    // when another app already owns the plain chord. Recording-only.
    accel: "Ctrl+Alt+P", accelFallback: "Ctrl+Alt+Shift+P",
  }),
  // ── Quick menu, notes and whiteboards (owner 2026-11-02) ─────────────────────
  // "just right click anywhere and start capturing/recording/drawing/writing/
  // taking notes" and "spawn a virtual clipboard/whiteboard anywhere and put it
  // away ... just like the rest of the taskbar". quick-menu.cjs pops the compact
  // grid AT the cursor; boards-window.cjs owns notes/whiteboards, persisted under
  // ~/Aither Boards and listed in the tray's Boards submenu. The hotkeys were
  // probed free on this desk (2026-11-02); each has a Shift fallback for machines
  // where another tool holds the primary.
  Object.freeze({
    id: "quick.open", label: "Quick menu at the cursor", group: "capture",
    accel: "Ctrl+Alt+Q", accelFallback: "Ctrl+Alt+Shift+Q",
    surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "note.new", label: "New note", group: "capture",
    accel: "Ctrl+Alt+N", accelFallback: "Ctrl+Alt+Shift+N",
    surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "board.new", label: "New whiteboard", group: "capture",
    accel: "Ctrl+Alt+B", accelFallback: "Ctrl+Alt+Shift+B",
    surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "boards.open", label: "Boards…", group: "capture",
    surfaces: ["tray", "palette"],
  }),
  // OWNER-CONSENTED and reversible: shell-menu.cjs writes per-user HKCU verbs
  // (the files-wine.cjs pattern). Both rows are Windows-only; main keeps
  // ctx.shellMenu in step so exactly ONE of them is visible.
  Object.freeze({
    id: "shellmenu.add", label: "Add Aither to right-click menu", group: "capture",
    surfaces: ["tray", "palette"],
    when: (ctx = {}) => ctx.platform === "win32" && ctx.shellMenu !== true,
  }),
  Object.freeze({
    id: "shellmenu.remove", label: "Remove Aither from right-click menu", group: "capture",
    surfaces: ["tray", "palette"],
    when: (ctx = {}) => ctx.platform === "win32" && ctx.shellMenu === true,
  }),
  // Screen ink (owner, 2026-11-02: "give us screen drawing tools and pens and
  // stuff"; "record presentations on the fly"). ink-window.cjs draws a per-display
  // overlay that recorders and screenshots CAN see, so a pen mark survives into
  // the video. The four keys are the only door: while drawing, the overlay holds
  // the mouse, so the tray is one glance away rather than in the way.
  Object.freeze({
    id: "ink.toggle", group: "capture", accel: "Ctrl+Alt+D",
    // The tray's visible ink state (no floating bar): the row says it is drawing.
    label: (ctx = {}) => (ctx.inkMode && ctx.inkMode !== "interact" ? "Drawing on screen — stop (Esc)" : "Draw on screen"),
    surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "ink.laser", label: "Laser pointer", group: "capture", accel: "Ctrl+Alt+L",
    surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "ink.spotlight", label: "Spotlight", group: "capture", accel: "Ctrl+Alt+S",
    surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "ink.clear", label: "Clear drawings", group: "capture", accel: "Ctrl+Alt+C",
    surfaces: ["tray", "palette"],
  }),
  // Ink, pins and GIFs (owner 2026-11-07: "drawing over the screen, searching for
  // GIFs and pinning them on the desktop, or a YouTube video, or a web page tab, or
  // an app"). Ctrl+Alt+K / Ctrl+Alt+I were free against every accel in this file
  // that day; each has the usual Shift fallback. Alt+Space verbs (desk-verbs.cjs)
  // reach all of them by typing: draw, gif <word>, pin <url|this tab|app>, pins.
  Object.freeze({
    id: "ink.passthrough", label: "Draw with clicks going through", group: "capture",
    accel: "Ctrl+Alt+K", accelFallback: "Ctrl+Alt+Shift+K",
    surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "ink.board", label: "Save drawing to a board", group: "capture",
    accel: "Ctrl+Alt+E", accelFallback: "Ctrl+Alt+Shift+E",
    surfaces: ["palette"],
    whySingle: "Its button is on the ink toolbar (To board); the palette (Ctrl+K) and Alt+Space `draw board` are its keyboard paths.",
  }),
  Object.freeze({
    id: "ink.snip", label: "Snip with ink", group: "capture",
    accel: "Ctrl+Alt+X", accelFallback: "Ctrl+Alt+Shift+X",
    surfaces: ["palette"],
    whySingle: "Its button is on the ink toolbar (Snip); the palette (Ctrl+K) and Alt+Space `draw snip` are its keyboard paths.",
  }),
  Object.freeze({
    id: "gif.open", label: "GIF picker…", group: "capture",
    accel: "Ctrl+Alt+I", accelFallback: "Ctrl+Alt+Shift+I",
    surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "gif.pin", label: "Pin a GIF to the desktop", group: "capture",
    // The key has no text to carry: with no words it opens the GIF picker.
    accel: "Ctrl+Alt+F", accelFallback: "Ctrl+Alt+Shift+F",
    surfaces: ["palette"],
    whySingle: "Needs words to search; the palette (and POST /commands/run, the phone link, awconnect) carry the text. The GIF picker is its menu door.",
    prompt: Object.freeze({ placeholder: "Words to search; the top GIF is pinned" }),
  }),
  Object.freeze({
    id: "pins.add", label: "Pin to desktop…", group: "capture",
    // The key pins the address on the clipboard (a copied link becomes a pin).
    accel: "Ctrl+Alt+U", accelFallback: "Ctrl+Alt+Shift+U",
    surfaces: ["palette"],
    whySingle: "Needs an address; the palette (and POST /commands/run, the phone link, awconnect) carry it. Alt+Space `pin <address>` is its other door.",
    prompt: Object.freeze({ placeholder: "A web address, a YouTube or GIF link, or aither://page" }),
  }),
  Object.freeze({
    id: "pins.tab", label: "Pin this tab to desktop", group: "capture",
    accel: "Ctrl+Alt+T", accelFallback: "Ctrl+Alt+Shift+T",
    surfaces: ["palette"],
    whySingle: "Acts on the Aither browser's tab: its menu row is the tab's own right-click menu (browser chrome); the palette and Alt+Space `pin this tab` are its keyboard paths.",
  }),
  Object.freeze({
    id: "pins.open", label: "Pins…", group: "capture",
    // The key shows every pin, or hides them all when they are all showing.
    accel: "Ctrl+Alt+H", accelFallback: "Ctrl+Alt+Shift+H",
    surfaces: ["tray", "palette"],
  }),
  // ONE sheet of every live key (owner 2026-11-07: "every ink, pin and gif action
  // ... with a default key"): what is bound, what fell back, what another app holds.
  Object.freeze({
    id: "shortcuts.open", label: "Keyboard shortcuts…", group: "capture",
    accel: "Ctrl+Alt+/", accelFallback: "Ctrl+Alt+Shift+/",
    surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "osapp.learn", label: "Learn…", group: "go", osApp: "learn",
    surfaces: ["palette", "jumplist"],
  }),
  Object.freeze({
    id: "osapp.sprite", label: "Sprite…", group: "go", osApp: "sprite",
    surfaces: ["palette", "jumplist"],
  }),
  Object.freeze({
    id: "osapp.academy", label: "Academy…", group: "go", osApp: "academy",
    surfaces: ["palette", "jumplist"],
  }),
  Object.freeze({
    id: "osapp.spaces", label: "Spaces…", group: "go", osApp: "spaces",
    surfaces: ["palette", "jumplist"],
  }),
  Object.freeze({
    id: "osapp.avatar", label: "Avatar…", group: "go", osApp: "avatar",
    surfaces: ["palette", "jumplist"],
  }),
  Object.freeze({
    id: "osapp.control", label: "Aither Control…", group: "go", osApp: "control",
    surfaces: ["palette", "jumplist"],
  }),
  // The customer Image Studio (craft brick B4, 2026-10-07): the Living OS `image-studio`
  // window -- library, canvas mask, inpaint / edit / cut-out on the hosted credits lane.
  Object.freeze({
    id: "osapp.image-studio", label: "Image Studio…", group: "go", osApp: "image-studio",
    surfaces: ["palette", "jumplist"],
  }),
  // Aither Cinema Studio (2026-10-31): the camera-rig shot desk -- moves, lenses, grades,
  // keyframe/t2v/i2v, WebMCP tools. It runs on this machine (the awnix unit aither-cinema,
  // or a self-hosted install from its one-line start command) at 127.0.0.1:8765 and has no
  // sign-in, so it is a local page, never a hosted one.
  Object.freeze({
    id: "osapp.cinema", label: "Cinema Studio…", group: "go", osApp: "cinema",
    surfaces: ["palette", "jumplist"],
  }),
  // Passkeys (2026-10-31, owner: "why can't I do it from awdesk"): granting admin and approving
  // an agent need a passkey or authenticator code, and a passkey is bound to the aitherium.com
  // site, so it is created in a browser engine -- this desk's own, where Windows Hello works.
  // awsh/awdk sign in with a device code and never count as "you, in person", on purpose.
  Object.freeze({
    id: "osapp.passkeys", label: "Passkeys & sign-in…", group: "go", osApp: "passkeys",
    surfaces: ["palette", "jumplist"],
  }),
  // My agent sessions on every machine (2026-10-18, owner: awdk/awsh in the Aither app): the
  // OS Agents window, which lands on its Running tab -- the same awkit AgentSessionsPanel
  // the phone's "Running agents" row opens. The browser side panel's Agents tab stays the
  // in-page glance; this is the full window (read, answer, start).
  Object.freeze({
    id: "osapp.agents", label: "Agents…", group: "go", osApp: "agents",
    surfaces: ["palette", "jumplist"],
  }),
  // The MoE view (owner 2026-10-20: "make it easy to view the MoE selection and routing
  // visually + context + agents"): the Living OS `moe` window -- V4.1's 40x384 expert atlas,
  // per-layer device tiers, keep-set coverage, llama-server slots and the agents in flight.
  Object.freeze({
    id: "osapp.moe", label: "MoE view…", group: "go", osApp: "moe",
    surfaces: ["palette", "jumplist"],
  }),
  Object.freeze({
    id: "fleet.gaming", label: "GPU sleep (game on)", group: "fleet",
    surfaces: ["tray", "palette"], fleet: "gpu-sleep", destructive: true,
  }),
  Object.freeze({
    id: "fleet.resume", label: "GPU wake (game off)", group: "fleet",
    surfaces: ["tray", "palette"], fleet: "gpu-wake",
  }),
  // Model postures (owner, 2026-09-27): one click swaps what runs on the 5090 and the
  // DGX Spark, through awmodels -- the same engine Claude Code / awsh reach as the
  // models_status / models_use MCP tools. Switches are confirm-first.
  Object.freeze({
    id: "models.status", label: "Models: what is running where", group: "fleet",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", fleet: "models-status",
  }),
  Object.freeze({
    id: "models.full-mesh", label: "Models: full mesh (DeepSeek split + drafter + gemma4)", group: "fleet",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", fleet: "models-full-mesh", destructive: true,
  }),
  Object.freeze({
    id: "models.pool-fast", label: "Models: pool fast (DeepSeek max tok/s, no gemma4)", group: "fleet",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", fleet: "models-pool-fast", destructive: true,
  }),
  Object.freeze({
    id: "models.pool-lean", label: "Models: pool lean (DeepSeek local + gemma4, no backends)", group: "fleet",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", fleet: "models-pool-lean", destructive: true,
  }),
  Object.freeze({
    id: "arc.status", label: "ARC: is it solving?", menuLabel: "Is it solving?", group: "arc",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", fleet: "arc-status",
  }),
  Object.freeze({
    id: "arc.now", label: "ARC: run now (4 h, overrides quiet hours)", menuLabel: "Run now (4 h, overrides quiet hours)", group: "arc",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", fleet: "arc-now",
  }),
  Object.freeze({
    id: "arc.start", label: "ARC: start (respect quiet hours)", menuLabel: "Start (respect quiet hours)", group: "arc",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", fleet: "arc-start",
  }),
  Object.freeze({
    id: "arc.stop", label: "ARC: stop the solver", menuLabel: "Stop the solver", group: "arc",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", fleet: "arc-stop", destructive: true,
  }),
  // Blog (owner ruling 2026-09-19, .claude/rules/blog-voice.md): machine paths
  // create DRAFTS; a human publishes. These records speak to the gateway's
  // blog_* MCP tools through gateway-mcp.cjs -- the same client the market and
  // system panels use -- so the desk never grows a second Veil credential.
  // `blog.publish` therefore does NOT publish: it opens the Veil editor for the
  // slug, where the owner reads the draft and flips the status with a click.
  Object.freeze({
    id: "blog.list", label: "Blog: list posts (drafts included)", menuLabel: "List posts (drafts included)", group: "blog",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.", blog: "list",
  }),
  Object.freeze({
    id: "blog.draft", label: "Blog: new draft…", group: "blog",
    surfaces: ["palette"], blog: "draft",
    prompt: Object.freeze({ placeholder: "Title for the new draft" }),
    whySingle: "Needs a typed title; the palette is the only surface with a text "
      + "field. A tray row could only create an untitled draft.",
  }),
  Object.freeze({
    id: "blog.show", label: "Blog: show a post…", group: "blog",
    surfaces: ["palette"], blog: "show",
    prompt: Object.freeze({ placeholder: "Post slug (e.g. bonsai-2-ptq-verdict)" }),
    whySingle: "Needs a typed slug; the palette is the only surface with a text field.",
  }),
  Object.freeze({
    id: "blog.publish", label: "Blog: open in the Veil editor to publish…", group: "blog",
    surfaces: ["palette"], blog: "publish",
    prompt: Object.freeze({ placeholder: "Slug of the draft to review and publish" }),
    whySingle: "Needs a typed slug; the palette is the only surface with a text field. "
      + "Opens the editor -- publishing itself is the human's click there.",
  }),
  // Aeon's inner state (owner, 2026-10-02: Aeon/Sense/Daydream must be integrated
  // with the desk). One read of the gateway's sense_inner_state tool -- the same
  // data Veil's Sense Command Center shows -- through gateway-mcp.cjs.
  Object.freeze({
    id: "aeon.state", label: "Aeon: how is the agent feeling?", menuLabel: "How is Aeon feeling?", group: "app",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.",
  }),
  Object.freeze({
    // The browser extension. The label says what a click will do given the last
    // `adk awconnect status` (awconnect-setup.cjs); main runs the adk command.
    id: "awconnect.setup",
    label: (ctx) => require("./awconnect-setup.cjs").setupLabel(ctx && ctx.awconnect),
    group: "app", surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.",
  }),
  // First-time setup of this machine as ONE window (owner, 2026-09-28: "WE NEED A
  // BETTER WAY TO DO THIS" -- after being handed a python script and a terminal
  // password prompt). setup-window.cjs; also the Start-menu shortcut (`--setup`).
  Object.freeze({
    id: "setup.open", label: "Set up Aither…", group: "app",
    surfaces: ["palette", "jumplist"],
  }),
  Object.freeze({
    id: "about", label: "About Aither", group: "app",
    surfaces: ["palette"],
    whySingle: "Lives on the Stage page / console now (owner, 2026-10-03: too many menus); the palette (Ctrl+K) is its keyboard path.",
  }),
  Object.freeze({
    // Not on the palette or a body's context menu: there it is a misclick with no undo.
    // The tray and the taskbar's own right-click (jump list) are deliberate places, and
    // the tray alone was not enough: Windows 11 hides tray icons under the overflow
    // arrow, and a customer (Garg, 2026-10-16) ended Desk from Task Manager. The jump
    // list row launches `--quit` (main.cjs), which also ends a Desk that is not answering.
    id: "quit", label: "Quit Aither", group: "app", surfaces: ["tray", "jumplist"],
  }),
]);

/** The commands on one surface, in declaration order. */
function commandsFor(surface) {
  return COMMANDS.filter((command) => command.surfaces.includes(surface));
}

function byId(id) {
  return COMMANDS.find((command) => command.id === String(id || "")) || null;
}

/** One group's commands on a surface -- what a menu nests and a palette flattens. */
function groupFor(group, surface) {
  return commandsFor(surface).filter((command) => command.group === String(group));
}

/**
 * The palette's rows: id + resolved label + group, nothing a page cannot render.
 *
 * A palette entry says which MENU would also have offered it, because "I know it
 * is in a menu somewhere" is the state the palette exists to end.
 */
function paletteRows(ctx = {}) {
  return commandsFor("palette")
    .filter((command) => !command.dynamic && appliesTo(command, ctx))
    .map((command) => ({
      id: command.id,
      label: labelOf(command, ctx),
      group: command.group,
      // The shell asks for the argument before it calls run(id, arg); a row
      // without `prompt` runs on Enter as before.
      ...(command.prompt ? { prompt: { placeholder: String(command.prompt.placeholder || "") } } : {}),
    }));
}

/** Does this command exist for this caller? `scope: "slot"` needs a body in hand. */
function appliesTo(command, ctx = {}) {
  if (command.scope === "slot" && !ctx.slotId) return false;
  if (typeof command.when === "function" && !command.when(ctx)) return false;
  return true;
}

/**
 * A command's label. `nested` picks `menuLabel` (the parent already said the noun).
 * The shortcut is appended only when main really holds it: `ctx.deadAccels` lists
 * the ones `globalShortcut.register` refused, and a key another app owns is not
 * promised on a menu.
 */
function labelOf(command, ctx, { nested = false } = {}) {
  const pick = nested && command.menuLabel ? command.menuLabel : command.label;
  const text = typeof pick === "function" ? pick(ctx || {}) : pick;
  const dead = (ctx && ctx.deadAccels) || [];
  // The key main actually holds: a fallback that went live when the first was taken.
  const live = ctx && ctx.liveAccels && typeof ctx.liveAccels[command.id] === "string" ? ctx.liveAccels[command.id] : null;
  if (live) return `${text}  (${live})`;
  return command.accel && !dead.includes(command.accel) ? `${text}  (${command.accel})` : text;
}

/**
 * The key a UI may advertise for one command, or null when none is really bound:
 * a live fallback when the default was taken, the default when it was not, and
 * null when another app owns the chord (a dead key is never promised).
 */
function accelFor(id, ctx = {}) {
  const command = COMMANDS.find((c) => c.id === id);
  if (!command || !command.accel) return null;
  const live = ctx && ctx.liveAccels && typeof ctx.liveAccels[id] === "string" ? ctx.liveAccels[id] : null;
  if (live) return live;
  const dead = (ctx && ctx.deadAccels) || [];
  return dead.includes(command.accel) ? null : command.accel;
}

/** "Ctrl+Shift+D" -> Electron's "CommandOrControl+Shift+D". */
function electronAccel(accel) {
  return String(accel || "").replace(/^Ctrl\+/, "CommandOrControl+");
}

/**
 * Every key the desk binds, from the registry (accel + accelFallback) plus the keys
 * registered OUTSIDE it (`extra`: [{accel, id}], e.g. the launcher's LAUNCHER_ACCELS),
 * and the conflicts: the same chord bound to two DIFFERENT commands. Chords compare
 * case-insensitively. shortcuts.test.cjs fails on any conflict.
 */
function bindingConflicts(extra = [], commands = COMMANDS) {
  const owners = new Map();
  const add = (accel, id, role) => {
    if (!accel) return;
    const key = String(accel).toLowerCase().replace(/\s+/g, "");
    if (!owners.has(key)) owners.set(key, []);
    owners.get(key).push({ id, accel, role });
  };
  for (const c of commands) {
    add(c.accel, c.id, "default");
    add(c.accelFallback, c.id, "fallback");
  }
  for (const e of Array.isArray(extra) ? extra : []) add(e.accel, e.id, "extra");
  const conflicts = [];
  for (const [, list] of owners) {
    const ids = [...new Set(list.map((o) => o.id))];
    if (ids.length > 1) conflicts.push({ accel: list[0].accel, ids });
  }
  return conflicts;
}

/**
 * The Shortcuts sheet: one row per bound command, in registry order, with what is
 * LIVE right now (ctx.liveAccels / ctx.deadAccels from main's applyHotkeys).
 */
function shortcutSheet(ctx = {}) {
  const dead = new Set(Array.isArray(ctx.deadAccels) ? ctx.deadAccels : []);
  const live = ctx.liveAccels && typeof ctx.liveAccels === "object" ? ctx.liveAccels : {};
  return COMMANDS.filter((c) => c.accel).map((c) => {
    const now = live[c.id] || (dead.has(c.accel) ? null : c.accel);
    return {
      id: c.id, label: labelOf(c, ctx), accel: c.accel, fallback: c.accelFallback || null, live: now,
      state: now === c.accel ? "bound" : now ? "fallback" : "held by another app",
    };
  });
}

/** The sheet as plain text lines ("Ctrl+Alt+D   Draw on screen"). */
function shortcutSheetText(ctx = {}) {
  return shortcutSheet(ctx).map((r) => {
    const key = r.live || `${r.accel} (taken)`;
    return `${key.padEnd(20)} ${r.label}${r.state === "fallback" ? `  [fallback; ${r.accel} is taken]` : ""}`;
  }).join("\n");
}

/** Every command that owns a global shortcut, for main to register from. */
function shortcuts(overrides = {}) {
  // overrides: id -> accel string from cast.json's hotkeys{} (Plan: configurable
  // hotkeys, owner 2026-09-22). Falls back to the DEFAULT accel so a machine
  // with no overrides behaves exactly as before this landed.
  return COMMANDS.filter((command) => command.accel)
    .map((command) => {
      const override = overrides && typeof overrides[command.id] === "string" && overrides[command.id].trim();
      const accel = override || command.accel;
      // An owner's own key is never second-guessed: the fallback only backs the default.
      const fallback = !override && command.accelFallback
        ? { accel: command.accelFallback, electron: electronAccel(command.accelFallback) } : null;
      return { id: command.id, accel, electron: electronAccel(accel), defaultAccel: command.accel, fallback };
    });
}

/** The groups of one surface, in that surface's reading order (see LAYOUT). */
function groupOrder(surface, commands) {
  const present = [];
  for (const command of commands) if (!present.includes(command.group)) present.push(command.group);
  const wanted = (LAYOUT[surface] || []).filter((group) => present.includes(group));
  return [...wanted, ...present.filter((group) => !wanted.includes(group))];
}

function rowFor(command, ctx, run, nested) {
  const row = { label: labelOf(command, ctx, { nested }), click: () => run(command.id) };
  if (command.type) {
    row.type = command.type;
    row.checked = typeof command.checked === "function" ? Boolean(command.checked(ctx)) : false;
  }
  if (typeof command.enabled === "function" && !command.enabled(ctx)) row.enabled = false;
  return row;
}

/**
 * Render one surface to a menu template.
 *
 * Returns PLAIN objects (`{ label, click }` / `{ type: "separator" }` /
 * `{ label, submenu }`), so Electron is not needed to assert the shape. Separators
 * come from `group` changes -- a menu cannot grow a stray divider by hand -- and a
 * group named in GROUPS nests under its one label on every menu.
 *
 * `run(id)` performs a command. `submenus[id]` supplies a dynamic command's items;
 * a dynamic command with no submenu supplied is DROPPED rather than rendered as a
 * dead row, because a menu entry that does nothing is worse than an absent one.
 */
function buildMenu(surface, run, { ctx = {}, submenus = {} } = {}) {
  const wanted = commandsFor(surface)
    .filter((command) => appliesTo(command, ctx))
    .filter((command) => !command.dynamic || submenus[command.id]);
  const template = [];
  for (const group of groupOrder(surface, wanted)) {
    const members = wanted.filter((command) => command.group === group);
    if (template.length) template.push({ type: "separator" });
    const nest = GROUPS[group] && GROUPS[group].menu;
    if (nest) {
      // A menu nests a group; the palette lists the same commands one per row.
      // Both read this list, so neither can carry an entry the other lacks.
      template.push({ label: nest, submenu: members.map((child) => rowFor(child, ctx, run, true)) });
      continue;
    }
    for (const command of members) {
      if (command.dynamic) template.push({ label: labelOf(command, ctx), submenu: submenus[command.id] });
      else template.push(rowFor(command, ctx, run, false));
    }
  }
  return template;
}

/**
 * The rows of a NON-menu surface (the bead rail, the Windows jump list): id,
 * resolved label and icon. A page or a jump list cannot run a closure, so it
 * gets data and sends the id back.
 */
function rowsFor(surface, ctx = {}) {
  // One taskbar owner (customer report 2026-10-20: "the side bar with the alert thing
  // really does just block my input ... this can almost be removed, I really enjoy the
  // bottom deskbar"). While the desktop overlay is on screen its dock carries the same
  // doors, so the floating bead rail is empty and draws nothing.
  if (surface === "beads" && ctx.overlayVisible) return [];
  const wanted = commandsFor(surface).filter((command) => appliesTo(command, ctx) && !command.dynamic);
  return groupOrder(surface, wanted)
    .flatMap((group) => wanted.filter((command) => command.group === group))
    .map((command) => ({ id: command.id, label: labelOf(command, ctx), icon: command.icon || null, group: command.group }));
}

/**
 * Everything wrong with the inventory itself, as sentences. Empty = healthy.
 *
 * Exported (not just tested) so a future palette or a startup assertion can read
 * the same verdict: a checker nobody can run from the app is documentation.
 */
function conformance(commands = COMMANDS) {
  const problems = [];
  const seen = new Set();
  for (const command of commands) {
    if (seen.has(command.id)) problems.push(`duplicate id: ${command.id}`);
    seen.add(command.id);
    if (!command.label) problems.push(`${command.id} has no label`);
    if (!command.group) problems.push(`${command.id} has no group`);
    if (!Array.isArray(command.surfaces) || command.surfaces.length === 0) {
      problems.push(`${command.id} names no surface -- it is unreachable`);
      continue;
    }
    for (const surface of command.surfaces) {
      if (!SURFACES.includes(surface)) problems.push(`${command.id} names unknown surface ${surface}`);
    }
    // The rule the size regression earned: one entry point is allowed only as a
    // decision somebody wrote down.
    if (command.surfaces.length === 1 && !command.whySingle) {
      problems.push(`${command.id} reaches only ${command.surfaces[0]} and gives no whySingle`);
    }
    if (command.type && !["checkbox", "radio"].includes(command.type)) {
      problems.push(`${command.id} has unknown type ${command.type}`);
    }
    if (command.type && typeof command.checked !== "function") {
      problems.push(`${command.id} is a ${command.type} that cannot say whether it is checked`);
    }
    // A slot-scoped command has no body to act on anywhere but a body's own menu.
    if (command.scope === "slot") {
      for (const surface of command.surfaces) {
        if (surface !== "avatar-menu") problems.push(`${command.id} needs a body but sits on ${surface}, which never has one`);
      }
    }
    // A command that needs typing can only live where typing exists. On a tray
    // it would be a row that runs with no argument -- a dead row with a label.
    if (command.prompt) {
      if (!command.prompt.placeholder) problems.push(`${command.id} has a prompt with no placeholder`);
      for (const surface of command.surfaces) {
        if (surface !== "palette") problems.push(`${command.id} prompts for text but sits on ${surface}, which has no text field`);
      }
    }
  }
  // Two commands on one key: the second registration silently loses.
  const keys = new Map();
  for (const command of commands) {
    if (!command.accel) continue;
    if (keys.has(command.accel)) problems.push(`${command.id} and ${keys.get(command.accel)} both claim ${command.accel}`);
    keys.set(command.accel, command.id);
  }
  // Every group GROUPS or LAYOUT names must exist, or the entry is a typo that
  // silently nests or reorders nothing.
  if (commands === COMMANDS) {
    const groups = new Set(commands.map((command) => command.group));
    for (const name of [...Object.keys(GROUPS), ...Object.values(LAYOUT).flat()]) {
      if (!groups.has(name)) problems.push(`group ${name} is named in GROUPS/LAYOUT and no command belongs to it`);
    }
  }
  return problems;
}

// osApps that open as a PAGE in an Aither Browser tab instead of the AitherDesktop
// shell (owner, 2026-10-05: "the family app forces the full aitheros online overlay
// to open -- it should just open in a new browser tab in aitherbrowser"). One line
// to move another app. Consumed by main.cjs's osApp dispatch.
const OSAPP_BROWSER_TAB = Object.freeze({
  family: "https://app.aitherium.com/family",
  cinema: "http://127.0.0.1:8765/",
  passkeys: "https://app.aitherium.com/settings/passkeys",
});

/** The browser-tab URL for an osApp, or null when it opens the desktop shell. */
function osAppTabUrl(osApp) {
  return OSAPP_BROWSER_TAB[String(osApp || "")] || null;
}

module.exports = {
  SURFACES, GROUPS, LAYOUT, COMMANDS, commandsFor, groupFor, paletteRows, rowsFor, byId, labelOf,
  buildMenu, conformance, shortcuts, electronAccel, accelFor, appliesTo, osAppTabUrl,
  bindingConflicts, shortcutSheet, shortcutSheetText,
};
