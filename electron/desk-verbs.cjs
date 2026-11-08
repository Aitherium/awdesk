"use strict";

/**
 * desk-verbs.cjs -- the Alt+Space VERBS (owner 2026-11-07: make the drawing and
 * pinning tools "better integrated into Alt+Space"). A verb is the first word:
 *
 *   draw [through|board|snip|clear]   screen ink (ink-window.cjs)
 *   ink ...                            same as draw
 *   gif <words>                        inline GIF results; Enter pins the top one
 *   gifs                               the GIF picker
 *   pin <url | this tab | app name>    a desktop pin (pin-item.cjs pinItemFromUrl)
 *   youtube <words | url>  (yt)        a URL pins the video; words search YouTube
 *   board | whiteboard | canvas        a new whiteboard / the canvas
 *   pins                               the pins on the desk, to show or close
 *
 * A bare verb that is also an ordinary word ("draw", "board", "canvas", "pins")
 * keeps the normal search underneath its verb rows: an app called "Draw..." still
 * shows. A verb with an argument answers with its own rows only.
 *
 * parseDeskVerb() and verbRows() are pure, so desk-verbs.test.cjs asserts every
 * verb under `node --test`; launcher-window.cjs runs the actions.
 */

const { pinItemFromUrl, youtubeId } = require("./pin-item.cjs");
const { launchPin } = require("./pins-core.cjs");

/** "example.com/x" -> "https://example.com/x"; anything with a scheme is left alone. */
function withScheme(text) {
  const t = String(text == null ? "" : text).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
  return /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#]|$)/i.test(t) ? `https://${t}` : t;
}

const ALIASES = Object.freeze({
  draw: "draw", ink: "draw",
  gif: "gif", gifs: "gif",
  pin: "pin",
  youtube: "youtube", yt: "youtube",
  board: "board", whiteboard: "board",
  canvas: "canvas",
  pins: "pins",
});
const DRAW_MODES = Object.freeze(["through", "board", "snip", "clear", "laser", "spotlight"]);
const TAB_WORDS = /^(this\s+tab|tab|current\s+tab|this\s+page|page)$/i;
const MAX_ARG = 300;

/**
 * The verb in a launcher query, or null when the text is an ordinary search.
 * @param {string} text
 * @returns {null | {verb: string, arg: string, bare: boolean, target?: string, value?: string, mode?: string}}
 */
function parseDeskVerb(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw || /^[>?@!]/.test(raw)) return null;
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(raw);
  if (!m) return null;
  const verb = ALIASES[m[1].toLowerCase()];
  if (!verb) return null;
  const arg = String(m[2] || "").replace(/\s+/g, " ").trim().slice(0, MAX_ARG);
  const out = { verb, arg, bare: !arg };
  if (verb === "draw") {
    const mode = arg.toLowerCase();
    if (arg && !DRAW_MODES.includes(mode)) return null; // "draw.io", "draw something": an ordinary search
    out.mode = mode || "toggle";
    // "gifs" with nothing after it opens the picker.
  } else if (verb === "gif" && !arg) {
    out.target = "picker";
  } else if (verb === "pin") {
    if (!arg) out.target = "help";
    else if (TAB_WORDS.test(arg)) out.target = "tab";
    else if (pinItemFromUrl(withScheme(arg))) { out.target = "url"; out.value = withScheme(arg); }
    else { out.target = "app"; out.value = arg; }
  } else if (verb === "youtube") {
    if (!arg) out.target = "help";
    else if (youtubeId(withScheme(arg))) { out.target = "video"; out.value = withScheme(arg); }
    else { out.target = "search"; out.value = arg; }
  } else if ((verb === "board" || verb === "canvas" || verb === "pins") && arg) {
    // "board games", "canvas print": an ordinary search.
    return null;
  }
  return out;
}

function row(key, title, subtitle, action, kind = "verb") {
  return { key: `verb:${key}`, kind, title, subtitle, action };
}

/**
 * The launcher rows a verb answers with. Actions are plain data the launcher runs:
 *   {type: "command", id, arg?}     a command-registry row (runCommand)
 *   {type: "pin", card}             pins-window addPin
 *   {type: "pin-tab"}               the active browser tab
 *   {type: "gif-pin", id}           a GIF result id (gif-search lookup)
 *   {type: "gif-picker", query}
 *   {type: "browse", url}           an Aither browser tab
 *   {type: "pin-show", id} / {type: "pin-close", id}
 *
 * @param {ReturnType<typeof parseDeskVerb>} v
 * @param {{gifs?: object, apps?: object[], pins?: object[], hasCanvas?: boolean}} [ctx]
 *   gifs  a gif-search answer for v.arg ({ok, results} | {ok:false, reason, needsKey})
 *   apps  ranked universal-search app items ({title, subtitle, target}) for `pin <app>`
 *   pins  pins-window listPins()
 * @returns {{rows: object[], status: string}}
 */
function verbRows(v, { gifs = null, apps = [], pins = [], hasCanvas = false } = {}) {
  if (!v) return { rows: [], status: "" };
  if (v.verb === "draw") {
    const modes = {
      toggle: row("draw", "Draw on screen", "Ink over every display · Ctrl+Alt+D", { type: "command", id: "ink.toggle" }),
      through: row("draw-through", "Draw, clicks go through", "Ink stays, your apps keep the mouse · Ctrl+Alt+K", { type: "command", id: "ink.passthrough" }),
      board: row("draw-board", "Save the drawing to a board", "Your marks become an editable whiteboard", { type: "command", id: "ink.board" }),
      snip: row("draw-snip", "Snip with ink", "Cut a region, annotations included", { type: "command", id: "ink.snip" }),
      clear: row("draw-clear", "Clear drawings", "Every display · undoable · Ctrl+Alt+C", { type: "command", id: "ink.clear" }),
      laser: row("draw-laser", "Laser pointer", "Ctrl+Alt+L", { type: "command", id: "ink.laser" }),
      spotlight: row("draw-spot", "Spotlight", "Ctrl+Alt+S", { type: "command", id: "ink.spotlight" }),
    };
    const first = modes[v.mode] || modes.toggle;
    const rest = v.mode === "toggle" ? [modes.through, modes.board, modes.snip, modes.clear] : [];
    return { rows: [first, ...rest], status: "Enter runs it" };
  }
  if (v.verb === "gif") {
    if (v.target === "picker") {
      return { rows: [row("gif-picker", "Open the GIF picker", "Search, then click to pin · Ctrl+Alt+I", { type: "gif-picker", query: "" })],
        status: "Type gif <word> to search here" };
    }
    const picker = row("gif-picker", `Browse GIFs for “${v.arg}”`, "The picker: Shift+click puts one on your board",
      { type: "gif-picker", query: v.arg });
    if (!gifs) return { rows: [picker], status: "Searching GIFs…" };
    if (!gifs.ok) {
      return { rows: [picker], status: gifs.needsKey ? "0 GIF sources — add a GIF key (TENOR_API_KEY) in the vault"
        : `1 GIF source down — ${gifs.reason || "no answer"}` };
    }
    const rows = gifs.results.map((g) => row(`gif:${g.id}`, g.title || "GIF",
      `${g.width}×${g.height} · ${g.provider} · Enter pins it to the desktop`, { type: "gif-pin", id: g.id }, "gif"));
    return { rows: [...rows, picker], status: rows.length ? `${rows.length} GIFs · Enter pins the top one` : `0 GIFs for “${v.arg}”` };
  }
  if (v.verb === "pin") {
    if (v.target === "help") {
      return { rows: [
        row("pin-tab", "Pin this browser tab to the desktop", "The page you are on in the Aither browser", { type: "pin-tab" }),
      ], status: "pin <address>, pin this tab, or pin <app name>" };
    }
    if (v.target === "tab") {
      return { rows: [row("pin-tab", "Pin this browser tab to the desktop", "The page you are on in the Aither browser", { type: "pin-tab" })],
        status: "Enter pins it" };
    }
    if (v.target === "url") {
      const card = pinItemFromUrl(v.value);
      const what = { youtube: "YouTube video", gif: "GIF", image: "image", url: "web page", app: "app" }[card.kind] || card.kind;
      return { rows: [row(`pin-url`, `Pin this ${what} to the desktop`, card.src, { type: "pin", card })], status: "Enter pins it" };
    }
    const rows = (Array.isArray(apps) ? apps : []).slice(0, 8).map((a, i) => {
      // A native app's launch tile (pins-core launchPin): only a Start-menu shortcut or
      // an AppsFolder id qualifies -- "cmd.exe" would otherwise read as a host name.
      const card = launchPin(String(a.target || ""), a.title);
      return card ? row(`pin-app-${i}`, `Pin ${a.title} to the desktop`, `${a.subtitle || "App"} · a tile that launches it`,
        { type: "pin", card }) : null;
    }).filter(Boolean);
    return { rows, status: rows.length ? "Enter pins the app as a launch tile" : `0 apps match “${v.value}” — pin takes an address, “this tab” or an app name` };
  }
  if (v.verb === "youtube") {
    if (v.target === "video") {
      const card = pinItemFromUrl(v.value);
      return { rows: [
        row("yt-pin", "Pin this video to the desktop", card.src, { type: "pin", card }),
        row("yt-open", "Open it in the Aither browser", card.src, { type: "browse", url: card.src }),
      ], status: "Enter pins it" };
    }
    if (v.target === "help") return { rows: [], status: "youtube <a link to pin> or youtube <words to search>" };
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(v.value)}`;
    return { rows: [row("yt-search", `Search YouTube for “${v.value}”`, "Opens in the Aither browser — then “pin this tab”", { type: "browse", url })],
      status: "Enter searches YouTube" };
  }
  if (v.verb === "board") {
    return { rows: [
      row("board-new", "New whiteboard", "Ctrl+Alt+B", { type: "command", id: "board.new" }),
      row("boards", "Boards…", "Every open board and note", { type: "command", id: "boards.open" }),
    ], status: "Enter opens it" };
  }
  if (v.verb === "canvas") {
    const rows = [];
    if (hasCanvas) rows.push(row("canvas", "Open the canvas", "aither://canvas", { type: "command", id: "canvas.open" }));
    rows.push(row("board-new", "New whiteboard", "Ctrl+Alt+B", { type: "command", id: "board.new" }));
    return { rows, status: "Enter opens it" };
  }
  if (v.verb === "pins") {
    const sorted = [...(Array.isArray(pins) ? pins : [])].sort((a, b) => (b.z || 0) - (a.z || 0));
    const rows = sorted.map((p) => row(`pin-show:${p.id}`, `${p.title}`,
      `${p.kind}${p.hidden ? " · hidden" : ""}${p.locked ? " · locked" : ""} · Enter shows it`, { type: "pin-show", id: p.id }, "pin"));
    for (const p of sorted) {
      rows.push(row(`pin-close:${p.id}`, `Close pin: ${p.title}`, p.kind, { type: "pin-close", id: p.id }, "pin"));
    }
    rows.push(row("gif-picker", "Pin a GIF…", "The GIF picker · Ctrl+Alt+I", { type: "gif-picker", query: "" }));
    return { rows, status: sorted.length ? `${sorted.length} pin${sorted.length === 1 ? "" : "s"} on the desk` : "0 pins — pin <address> or gif <word>" };
  }
  return { rows: [], status: "" };
}

/** The verb rows as ONE launcher group (the page renders it like any other). */
function verbGroup(v, rows) {
  if (!rows || !rows.length) return null;
  const label = { draw: "Draw", gif: "GIFs", pin: "Pin to desktop", youtube: "YouTube", board: "Boards",
    canvas: "Canvas", pins: "Pins" }[v.verb] || "Desk";
  return { id: "verbs", label, total: rows.length, items: rows.map((r) => ({ key: r.key, kind: r.kind, title: r.title, subtitle: r.subtitle })) };
}

module.exports = { ALIASES, DRAW_MODES, parseDeskVerb, verbRows, verbGroup };
