"use strict";

/**
 * bricks-window.cjs -- main's half of aither://bricks: the awkno catalog and man pages
 * (brick-catalog.cjs). Installed versions and upgrade/test/rollback reuse the existing
 * desk:bricks-list / desk:bricks-act channels (bricks-client.cjs, Settings > Updates).
 * These two channels answer only the aither://bricks page.
 */

const { createBrickCatalog } = require("./brick-catalog.cjs");
const { createSkillsCatalog } = require("./skills-catalog.cjs");

let wired = false;
let catalogImpl = null;
const catalog = () => catalogImpl || (catalogImpl = createBrickCatalog());
let skillsImpl = null;
/** Skills: yours, installed plugins', and the Projects page's repos' (skills-catalog.cjs). */
const skills = () => skillsImpl || (skillsImpl = createSkillsCatalog({
  projectDirs: async () => (await require("./projects-client.cjs").createProjectsClient().folders()).map((p) => p.dir),
}));

function fromBricksPage(sender) {
  try {
    const url = new URL(sender.getURL());
    return url.protocol === "aither:" && url.hostname === "bricks";
  } catch {
    return false;
  }
}

function bricksHandlers(c = catalog(), { isBricks = fromBricksPage, sk = null } = {}) {
  const skillsCat = () => sk || skills();
  const guard = (fn) => async (event, ...args) => {
    if (!event || !event.sender || !isBricks(event.sender)) return { ok: false, error: "not the bricks page" };
    try {
      return await fn(...args);
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  };
  return {
    "desk:brickcat-list": guard(() => c.list()),
    "desk:brickcat-page": guard((name) => c.page(name)),
    "desk:skills-list": guard(() => skillsCat().list()),
    "desk:packs-list": guard(() => c.packs()),
    "desk:packs-act": guard((verb, id) => c.packAct(String(verb), String(id))),
    "desk:skills-read": guard((file) => skillsCat().read(file)),
  };
}

function ensureBricksIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = require("electron");
  for (const [channel, handler] of Object.entries(bricksHandlers())) ipcMain.handle(channel, handler);
}

module.exports = { bricksHandlers, ensureBricksIpc, fromBricksPage };
