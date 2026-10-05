"use strict";

/**
 * projects-window.cjs -- main's half of aither://projects (projects-client.cjs). Every
 * channel answers only the aither://projects page.
 */

const { createProjectsClient } = require("./projects-client.cjs");

let wired = false;
let clientImpl = null;

function client() {
  if (!clientImpl) {
    let file = null;
    try { file = require("node:path").join(require("electron").app.getPath("userData"), "projects.json"); } catch { /* tests */ }
    clientImpl = createProjectsClient({ file });
  }
  return clientImpl;
}

function fromProjectsPage(sender) {
  try {
    const url = new URL(sender.getURL());
    return url.protocol === "aither:" && url.hostname === "projects";
  } catch {
    return false;
  }
}

function projectsHandlers(c = client(), { isProjects = fromProjectsPage } = {}) {
  const guard = (fn) => async (event, ...args) => {
    if (!event || !event.sender || !isProjects(event.sender)) return { ok: false, error: "not the projects page" };
    try {
      return await fn(...args);
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  };
  return {
    "desk:projects-list": guard(async () => ({ ok: true, projects: await c.folders() })),
    "desk:projects-add": guard((dir) => c.add(dir)),
    "desk:projects-remove": guard((dir) => c.remove(dir)),
    "desk:projects-state": guard((dir) => c.state(dir)),
    "desk:projects-pr": guard((dir, n) => c.pr(dir, n)),
  };
}

function ensureProjectsIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = require("electron");
  for (const [channel, handler] of Object.entries(projectsHandlers())) ipcMain.handle(channel, handler);
}

module.exports = { ensureProjectsIpc, fromProjectsPage, projectsHandlers };
