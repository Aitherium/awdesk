"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  COMMANDS,
  GROUPS,
  SURFACES,
  buildMenu,
  byId,
  commandsFor,
  conformance,
  rowsFor,
  shortcuts,
} = require("./command-registry.cjs");
const { ACTIONS: fleetActions } = require("./fleet-control.cjs");
const { BLOG_VERBS } = require("./blog-commands.cjs");

test("the inventory itself is healthy", () => {
  assert.deepEqual(conformance(), []);
});

test("a capability with ONE entry point must say why", () => {
  // The regression this registry exists to prevent: avatar window size reachable
  // only through a right-click that lands on a body. Single-surface is allowed --
  // silently single-surface is not.
  for (const command of COMMANDS) {
    if (command.surfaces.length === 1) {
      assert.ok(
        typeof command.whySingle === "string" && command.whySingle.length > 20,
        `${command.id} is single-surface with no written reason`,
      );
    }
  }
});

test("window size lives on the Stage page, the palette and its hotkeys -- not two menus", () => {
  // Owner, 2026-10-03: too many separate menus for one stage. The "Avatar window"
  // submenu sat on the tray AND on every body's menu; it is the Stage page's
  // "Avatar window" row now (stage-window.cjs STAGE_RUNNABLE), the palette, and the
  // two global keys. A size preset with none of those would be unreachable.
  const { STAGE_RUNNABLE } = require("./stage-window.cjs");
  const sizes = COMMANDS.filter((command) => command.group === "window-size");
  assert.ok(sizes.length >= 4, "the size group lost its presets");
  for (const command of sizes) {
    assert.ok(command.surfaces.includes("palette"), `${command.id} is missing from the palette`);
    assert.ok(STAGE_RUNNABLE.includes(command.id), `${command.id} has no button on the Stage page`);
    assert.ok(!command.surfaces.includes("tray") && !command.surfaces.includes("avatar-menu"),
      `${command.id} crept back onto a menu`);
  }
  assert.equal(byId("window.size.bigger").accel, "Ctrl+Shift+=");
  assert.equal(byId("window.size.smaller").accel, "Ctrl+Shift+-");
  const rows = require("./command-registry.cjs").paletteRows({});
  assert.equal(rows.filter((row) => row.group === "window-size").length, sizes.length);
});

test("U27: configuration is reachable from three surfaces, not one gesture", () => {
  // The regression this unit exists for: a character's cast/voice identity had ONE
  // door. Since 2026-10-03 the door is stage.open -- the Stage pane, whose tabs are
  // On stage / Characters / Voices -- on the tray, every body's menu and the palette.
  const door = byId("stage.open");
  assert.ok(door, "stage.open is missing from the registry");
  assert.deepEqual(door.surfaces, ["tray", "avatar-menu", "palette"]);
  const cast = byId("cast.open");
  assert.ok(cast && cast.surfaces.includes("palette"), "the Voices tab lost its keyboard path");
  const { PANES } = require("./console-window.cjs");
  assert.equal(PANES.find((p) => p.id === "cast").tabOf, "stage", "Voices is a tab of Stage");
  assert.equal(PANES.find((p) => p.id === "characters").tabOf, "stage", "Characters is a tab of Stage");

  const steer = byId("room.steer");
  assert.ok(steer, "room.steer is missing from the registry");
  assert.equal(steer.group, "talk");
  assert.deepEqual(steer.surfaces, ["avatar-menu", "palette"]);
  assert.equal(steer.whySingle, undefined, "room.steer names two surfaces, not one");
});

test("every surface renders, and separators come from groups", () => {
  for (const surface of SURFACES) {
    const ran = [];
    const template = buildMenu(surface, (id) => ran.push(id), {
      ctx: { avatarShown: true, decisionsWaiting: 2, decisionsTotal: 5, slotId: "slot1", removable: true },
      submenus: Object.fromEntries(
        commandsFor(surface).filter((c) => c.dynamic).map((c) => [c.id, [{ label: "x" }]]),
      ),
    });
    assert.ok(template.length > 0, `${surface} rendered nothing`);
    assert.ok(!template[0].type, `${surface} starts with a separator`);
    assert.ok(!template[template.length - 1].type, `${surface} ends with a separator`);
    for (let i = 1; i < template.length; i += 1) {
      assert.ok(
        !(template[i].type === "separator" && template[i - 1].type === "separator"),
        `${surface} has two separators in a row`,
      );
    }
    // Every non-dynamic row must actually do something -- nested ones included.
    const leaves = template.flatMap((row) => (Array.isArray(row.submenu) ? row.submenu : [row]));
    const clickable = leaves.filter((row) => typeof row.click === "function");
    assert.ok(clickable.length > 0, `${surface} has nothing to click`);
    for (const row of clickable) row.click();
    assert.equal(ran.length, clickable.length, "a rendered row did not reach run()");
    assert.ok(ran.every((id) => byId(id)), "a row ran an id the registry does not know");
  }
});

test("a dynamic command with no submenu is DROPPED, never rendered dead", () => {
  // The roster picker left both menus for the Stage pane (2026-10-03), so no menu
  // carries a dynamic row today; buildMenu must still drop one it is not fed.
  const labels = (template) => template.map((row) => row.label).filter(Boolean);
  for (const surface of ["tray", "avatar-menu"]) {
    const bare = labels(buildMenu(surface, () => {}, { submenus: {}, ctx: { slotId: "slot1" } }));
    assert.ok(!bare.includes("Characters"), `${surface}: a roster row came back`);
    assert.ok(bare.includes("Stage & characters…"), `${surface}: the one stage door is missing`);
    assert.ok(bare.includes("Aither Console…"), `${surface}: static rows must still render`);
  }
  assert.ok(byId("characters.pick").dynamic, "the picker is still dynamic in the palette");
});

// ── 2026-09-20: "the whole tray menu is completely different and disconnected
//    from the console ... and there is a separate right-click menu on the avatars
//    ... and the ability to bring up the AitherOS Online overlay is GONE" ─────────

/** id -> { label, parent } for every leaf a menu renders. */
function leavesOf(surface, ctx) {
  const ids = [];
  const template = buildMenu(surface, (id) => ids.push(id), {
    ctx, submenus: { "characters.pick": [{ label: "x" }] },
  });
  const out = new Map();
  for (const row of template) {
    for (const leaf of Array.isArray(row.submenu) && row.submenu[0] && row.submenu[0].click ? row.submenu : [row]) {
      if (typeof leaf.click !== "function") continue;
      const before = ids.length;
      leaf.click();
      out.set(ids[before], { label: leaf.label, parent: leaf === row ? null : row.label });
    }
  }
  return out;
}

test("a command on BOTH menus reads the same and sits under the same parent", () => {
  // The measured drift: six size rows under "Avatar window size" on the tray and
  // "Avatar window" on a body; "Talk to the agents" (microphone) on the tray and
  // "Talk to <agent>" (chat pane) where the body's menu claimed the same command.
  const ctx = { slotId: "slot1", removable: true, sessionAddress: {}, agent: "Aither" };
  const tray = leavesOf("tray", ctx);
  const body = leavesOf("avatar-menu", ctx);
  let shared = 0;
  for (const [id, onTray] of tray) {
    const onBody = body.get(id);
    if (!onBody) continue;
    shared += 1;
    assert.equal(onBody.label, onTray.label, `${id} is labelled differently on the two menus`);
    assert.equal(onBody.parent, onTray.parent, `${id} sits under a different parent on the two menus`);
  }
  // 2026-10-03 the menus were cut to what each is FOR (tray: where to go; a body:
  // talk to it, place it). What both still carry must read the same.
  assert.ok(shared >= 5, `only ${shared} commands are shared -- the menus have come apart again`);
  // A nested group has ONE name, and it lives in the registry, not at a call site.
  for (const name of Object.keys(GROUPS)) assert.ok(GROUPS[name].menu.length > 2);
});

test("every id a body's menu claims is really ON a body's menu", () => {
  // popupAvatarMenu was hand-written, so `surfaces: [... "avatar-menu"]` was a
  // claim nothing checked: cast.open was declared there and absent from it.
  const body = leavesOf("avatar-menu", { slotId: "slot1", removable: true, sessionAddress: {} });
  for (const command of commandsFor("avatar-menu")) {
    if (command.dynamic) continue;
    assert.ok(body.has(command.id), `${command.id} names avatar-menu and does not render there`);
  }
});

test("'talk' means ONE thing per label", () => {
  const speak = byId("voice.talk");
  const chat = byId("chat.open");
  assert.ok(speak && chat, "the microphone and the chat pane are two commands");
  assert.match(speak.label({}), /microphone/i, "the mic row must say it is the mic");
  assert.match(chat.label({ agent: "Atlas" }), /^Chat with Atlas/);
  assert.doesNotMatch(chat.label({}), /talk/i, "'Talk' on the chat row is what made two commands read as one");
  for (const surface of ["tray", "avatar-menu", "palette"]) {
    assert.ok(speak.surfaces.includes(surface) && chat.surfaces.includes(surface),
      `${surface} must offer both, or one impersonates the other again`);
  }
});

test("the AitherOS Online overlay is reachable BY HAND, from every menu", () => {
  // 09-13's consolidation deleted its two tray rows; this registry was written
  // from what was left; for a week the overlay was reachable by protocol URL, CLI
  // flag and MCP tool -- by an agent, not by the owner.
  const toggle = byId("desktop.overlay.toggle");
  assert.ok(toggle, "the overlay has no command");
  for (const surface of ["tray", "avatar-menu", "palette", "beads", "jumplist"]) {
    assert.ok(toggle.surfaces.includes(surface), `the overlay is missing from ${surface}`);
  }
  assert.equal(toggle.accel, "Ctrl+Shift+D", "the overlay never had a hotkey; it has one now");
  assert.equal(toggle.label({ overlayVisible: true }), "Hide AitherOS Online overlay");
  // The shell picker mirrors the overlay module's own list: a shell it offers and
  // the menu does not is a shell nobody can pick.
  // (Read as text: that module requires electron, which `node --test` has not got.)
  const overlaySrc = fs.readFileSync(path.join(__dirname, "living-desktop-window.cjs"), "utf8");
  const block = overlaySrc.slice(overlaySrc.indexOf("const SHELL_CHOICES = ["), overlaySrc.indexOf("];", overlaySrc.indexOf("const SHELL_CHOICES = [")));
  const theirs = [...block.matchAll(/\{ id: (null|"[^"]+")/g)].map((m) => (m[1] === "null" ? null : m[1].slice(1, -1)));
  assert.ok(theirs.length >= 2, "could not read SHELL_CHOICES -- this arm would pass on nothing");
  const offered = COMMANDS.filter((c) => "shell" in c).map((c) => c.shell);
  assert.deepEqual(offered, theirs);
  // Exactly one radio is checked for any state.
  for (const shell of [null, "aither-shell", "gobbonet"]) {
    const checked = COMMANDS.filter((c) => "shell" in c && c.checked({ overlayShell: shell }));
    assert.equal(checked.length, 1, `shell=${shell} checks ${checked.length} radios`);
  }
});

test("main.cjs RENDERS the avatar menu from the registry too", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const at = main.indexOf("function popupAvatarMenu(");
  assert.ok(at > 0, "popupAvatarMenu is gone");
  const body = main.slice(at, main.indexOf("\nipcMain.on(\"desk:avatar-context-menu\"", at));
  assert.match(body, /commandRegistry\.buildMenu\(\s*"avatar-menu"/, "the avatar menu is hand-written again");
  assert.match(body, /slotId/, "the right-clicked body no longer reaches the commands");
  // The only literal rows allowed are the disabled header and its separator.
  const literals = body.match(/\{\s*label:/g) || [];
  assert.ok(literals.length <= 1, `popupAvatarMenu hand-writes ${literals.length} rows; declare them in the registry`);
  // And no caller passes its own parent labels any more.
  assert.doesNotMatch(main, /nest:\s*\{/, "a call site is naming a group again -- GROUPS owns that");
});

test("an exported overlay opener has a caller", () => {
  // buildLivingDesktopMenu sat exported with ZERO callers for a week. An export
  // nothing imports is a feature nobody can reach.
  const overlay = fs.readFileSync(path.join(__dirname, "living-desktop-window.cjs"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  for (const name of ["toggleLivingDesktop", "setShell", "setGhostMode", "setSolidBackground", "reloadLivingDesktop", "beginSignIn"]) {
    assert.match(overlay, new RegExp(`\\b${name}\\b`), `${name} left the overlay module`);
    assert.match(main, new RegExp(`\\b${name}\\b`), `${name} is exported and main never calls it`);
  }
  assert.doesNotMatch(overlay, /buildLivingDesktopMenu/, "the hand-built overlay menu is back");
});

test("shortcuts are registered FROM the registry, and a dead key is not advertised", () => {
  const keys = shortcuts();
  assert.deepEqual(keys.map((k) => k.accel).sort(),
    ["Ctrl+Shift+,", "Ctrl+Shift+-", "Ctrl+Shift+=", "Ctrl+Shift+A", "Ctrl+Shift+D", "Ctrl+Shift+M", "Ctrl+Shift+Space"]);
  assert.ok(keys.every((k) => k.electron.startsWith("CommandOrControl+")));
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  // Plan: configurable hotkeys -- main now passes cast.json overrides through,
  // so the call is no longer bare (); the guarantee this test protects (main
  // asks the REGISTRY, never hand-writes its own key list) still holds.
  assert.match(main, /commandRegistry\.shortcuts\(/, "main keeps its own shortcut list again");
  assert.match(main, /deadAccels\.add\(accel\)/, "a refused shortcut is not recorded");
  const live = buildMenu("tray", () => {}, { ctx: {} }).find((r) => r.label && r.label.startsWith("AitherOS Online"));
  assert.match(live.submenu[0].label, /Ctrl\+Shift\+D/);
  const dead = buildMenu("tray", () => {}, { ctx: { deadAccels: ["Ctrl+Shift+D"] } })
    .find((r) => r.label && r.label.startsWith("AitherOS Online"));
  assert.doesNotMatch(dead.submenu[0].label, /Ctrl/, "a key another app holds is still promised");
});

test("the beads are registry rows, and the deck-action door accepts an id", () => {
  const rows = rowsFor("beads", { decisionsWaiting: 3 });
  assert.deepEqual(rows.map((r) => r.id), ["inbox.open", "console.open", "browser.open", "chat.open", "desktop.overlay.toggle"]);
  assert.ok(rows.every((r) => r.icon), "a bead with no icon is a blank circle");
  const beads = fs.readFileSync(path.join(__dirname, "..", "src", "components", "Beads.tsx"), "utf8");
  assert.match(beads, /commands\?\.\('beads'\)/, "the bead rail is a typed list again");
  assert.doesNotMatch(beads, /action\('talk'\)|action\('console'\)/, "a bead is sending a deck verb, not a command id");
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /if \(commandRegistry\.byId\(name\)\)/, "deck-action no longer accepts a registry id");
  // slot-scoped rows never leak onto a surface with no body in hand
  assert.ok(!conformance().length);
  assert.ok(conformance([{ id: "x", label: "X", group: "x", scope: "slot", surfaces: ["tray", "avatar-menu"] }])
    .some((p) => /needs a body/.test(p)));
});

test("counting labels say what is actually waiting", () => {
  const label = (ctx) => byId("inbox.open").label(ctx);
  assert.equal(label({ decisionsWaiting: 1, decisionsTotal: 3 }), "Inbox — 1 decision waiting");
  assert.equal(label({ decisionsWaiting: 0, decisionsTotal: 3 }), "Inbox — 3 cards");
  assert.equal(label({}), "Inbox");
});

test("every command either has a handler or a dynamic submenu", () => {
  // A row that renders and does nothing is the failure mode a registry invites:
  // the inventory is easy to extend, the switch is easy to forget.
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const at = main.indexOf("function runCommand(");
  assert.ok(at > 0, "runCommand is gone -- the registry has no HOW");
  const body = main.slice(at, main.indexOf("\nfunction ", at + 10));
  const trayAt = main.indexOf("buildMenu(\"tray\"");
  const traySubmenus = main.slice(trayAt, trayAt + 600);
  for (const command of COMMANDS) {
    if (command.dynamic) {
      assert.match(
        traySubmenus,
        new RegExp(`"${command.id.replace(".", "\\.")}":`),
        `${command.id} is dynamic but nothing supplies its submenu`,
      );
      continue;
    }
    // A command is answerable three ways: a case in the switch, a dynamic submenu,
    // or DATA on its own record -- the size presets and the stage arrangements --
    // which the default branch applies without a case per entry.
    if (command.size) {
      assert.match(body, /command\.size/, "the size branch is gone");
      continue;
    }
    if (command.arrangement) {
      assert.match(body, /command\.arrangement/, "the arrangement branch is gone");
      assert.match(body, /stage-arrange/, "nothing sends the arrangement to the renderer");
      continue;
    }
    if (command.fleet) {
      // Fleet/ARC verbs are data too: the verb must be one the runner knows (or
      // the panel opener), and the default branch must hand it over.
      assert.match(body, /command\.fleet/, "the fleet branch is gone");
      assert.match(body, /runFleetCommand/, "nothing routes a fleet verb to fleetAction");
      const known = command.fleet === "open_panel" || Object.prototype.hasOwnProperty.call(fleetActions, command.fleet);
      assert.ok(known, `${command.id} names fleet verb "${command.fleet}" that fleet-control.cjs does not know`);
      continue;
    }
    if (command.blog) {
      // Blog verbs: the default branch hands the record (and the palette's typed
      // argument) to runBlogMenuCommand, and the verb is one blog-commands.cjs runs.
      assert.match(body, /command\.blog/, "the blog branch is gone");
      assert.match(body, /runBlogMenuCommand\(command, arg/, "nothing routes a blog verb with its argument");
      assert.ok(BLOG_VERBS.includes(command.blog),
        `${command.id} names blog verb "${command.blog}" that blog-commands.cjs does not know`);
      continue;
    }
    if ("shell" in command) {
      // The overlay's shells are data too: the default branch hands the id to the
      // overlay module, so a new shell is one record and no case.
      assert.match(body, /"shell" in command/, "the shell branch is gone");
      assert.match(body, /setDesktopShell\(command\.shell\)/, "nothing hands a shell to the overlay");
      continue;
    }
    assert.ok(body.includes(`"${command.id}"`), `${command.id} has no case in runCommand`);
  }
  // The palette hands the argument through: run(id, arg) in main, (id, arg) on
  // the console IPC and the preload, so a `prompt` record is not a dead row.
  assert.match(body, /function runCommand\(id, arg/, "runCommand takes no argument -- prompt rows cannot work");
  assert.match(main, /run: \(id, arg\) => runCommand\(id, arg/, "the palette runner drops the argument");
  const consoleWindow = fs.readFileSync(path.join(__dirname, "console-window.cjs"), "utf8");
  assert.match(consoleWindow, /"desk:console-command-run", async \(_event, id, arg\)/);
  assert.match(consoleWindow, /commandsImpl\.run\(command, arg/);
  const preload = fs.readFileSync(path.join(__dirname, "console-preload.cjs"), "utf8");
  assert.match(preload, /runCommand: \(id, arg\)/);
  const html = fs.readFileSync(path.join(__dirname, "console.html"), "utf8");
  assert.match(html, /row\.prompt/, "the palette never asks for a prompt row's argument");
  assert.match(html, /runCommand\(id, arg\)/, "the palette does not send the argument");
});

test("blog: drafts everywhere, publishing nowhere (owner ruling 2026-09-19)", () => {
  // The four records exist, in one group, and the ones that need typing say so
  // in DATA the palette reads -- not in a label a human must decode.
  const blog = COMMANDS.filter((command) => command.group === "blog");
  assert.deepEqual(blog.map((c) => c.id), ["blog.list", "blog.draft", "blog.show", "blog.publish"]);
  for (const command of blog) assert.ok(BLOG_VERBS.includes(command.blog), `${command.id} has no blog verb`);
  // Off the tray since 2026-10-03 (one-line menus); the palette lists without typing.
  assert.deepEqual(byId("blog.list").surfaces, ["palette"], "listing lives in the palette");
  assert.ok(byId("blog.list").whySingle, "blog.list is single-surface and says why");
  for (const id of ["blog.draft", "blog.show", "blog.publish"]) {
    const command = byId(id);
    assert.ok(command.prompt && command.prompt.placeholder.length > 5, `${id} needs an argument and declares none`);
    assert.deepEqual(command.surfaces, ["palette"], `${id} prompts for text; only the palette can type`);
    assert.ok(command.whySingle, `${id} is single-surface and says nothing`);
  }
  // blog.publish is the door to the editor, not a publish: its label says so and
  // blog-commands.test.cjs pins that the verb never calls blog_publish_post.
  assert.match(byId("blog.publish").label, /editor/i);
  // The palette rows carry the prompt so the shell can ask before it runs.
  const rows = require("./command-registry.cjs").paletteRows({});
  const asking = rows.filter((row) => row.prompt).map((row) => row.id);
  assert.deepEqual(asking, ["blog.draft", "blog.show", "blog.publish"]);
  assert.equal(rows.find((row) => row.id === "blog.list").prompt, undefined);
  // And a prompt row on a surface with no text field is a conformance problem.
  const stray = [{
    id: "x.typed", label: "Typed", group: "x", surfaces: ["tray", "palette"],
    prompt: { placeholder: "type here" },
  }];
  assert.ok(conformance(stray).some((p) => /sits on tray/.test(p)), "a prompt on the tray must be refused");
  assert.ok(conformance([{ id: "x", label: "X", group: "x", surfaces: ["palette"], whySingle: "twenty-one characters ok", prompt: {} }])
    .some((p) => /no placeholder/.test(p)));
});

test("main.cjs RENDERS the tray from the registry, it does not hand-write it", () => {
  // The whole point: three menus drifted because each was a literal template.
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const built = main.indexOf("commandRegistry.buildMenu(\"tray\"");
  const set = main.indexOf("tray?.setContextMenu(");
  assert.ok(built > 0, "the tray is no longer rendered from the registry");
  assert.ok(set > built, "the tray menu is set before it is rendered");
  // and what it sets is that template, not a second hand-written one.
  assert.match(main.slice(set, set + 200), /Menu\.buildFromTemplate\(trayTemplate\)/);
});

test("voice.talk names what the hotkey does in the current talk mode", () => {
  const reg = require("./command-registry.cjs");
  const talk = reg.byId("voice.talk");
  const says = (ctx, text) => assert.ok(reg.labelOf(talk, ctx).startsWith(text), reg.labelOf(talk, ctx));
  says({ talkMode: "open", openMic: false }, "Turn open mic on");
  says({ talkMode: "open", openMic: true }, "Turn open mic off");
  says({ talkMode: "hold", listening: true }, "Stop listening");
  says({}, "Speak to the agents (microphone)");
});
