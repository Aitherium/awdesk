"use strict";

function voiceState(activity, phase = "active") {
  return {
    type: "state",
    state: {
      activity,
      microphoneMuted: false,
      outputMuted: false,
      phase,
    },
  };
}

function parseProtocolUrl(rawUrl, protocolScheme = "desk") {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== `${protocolScheme}:`) return null;
    const action = (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase();
    if (action === "show" || action === "hide" || action === "toggle") {
      return [{ type: action }];
    }
    // desk://fleet -> the Fleet control window (`game panel`, Start-menu link).
    if (action === "fleet") {
      return [{ type: "fleet" }];
    }
    // desk://command -> the Command chat window.
    if (action === "command") {
      return [{ type: "command" }];
    }
    // desk://console -> the unified console (Command | Fleet | Cards | Chat in ONE
    // window, each pane detachable). The front door as of 2026-09-08; the single-pane
    // links above stay, because a detached pane must still have a way to be opened.
    if (action === "console") {
      return [{ type: "console" }];
    }
    // desk://setup -> "Set up Aither" (the awnix [oobe] terminal opens it through WSL
    // interop, so first boot of the image lands in the window, not a terminal prompt).
    if (action === "setup") {
      return [{ type: "setup" }];
    }
    // desk://overlay -> the AitherOS overlay (aitherium.com Living Desktop over the
    // Windows desktop); desk://desktop -> the AitherDesktop app window.
    if (action === "overlay" || action === "living-desktop") {
      return [{ type: "overlay" }];
    }
    if (action === "desktop" || action === "aither-desktop") {
      return [{ type: "desktop" }];
    }
    // desk://enroll?c=<code>&d=<device>&i=<identity> -> "Connect this device" from
    // aitherium.com: device-identity.cjs validates and confirms it.
    // desk://darkmatters -> "Play Dark Matters" (the Living OS app's Start button): the
    // idempotent launcher -- start the local engine if it is down, open the game. Only
    // PLAY is reachable from a web link; restart (which ends a running engine) is not.
    if (action === "darkmatters") {
      return [{ type: "run", command: "darkmatters.play" }];
    }
    if (action === "enroll") {
      return [{ type: "enroll", url: rawUrl }];
    }
    // desk://browse?url=<http(s) URL> -> open that page in a new OWNER tab of the
    // desk's Aither Browser. The plain-web hand-off from the OS's Browser app: a
    // workspace member's browsing runs HERE, on their computer, never on the
    // platform's remote session (owner 2026-10-14). Only http(s) is carried; the
    // window applies browser-policy sanitizeUrl again before loading anything.
    if (action === "browse") {
      const target = String(url.searchParams.get("url") || "").trim();
      if (!/^https?:\/\//i.test(target)) return null;
      return [{ type: "browse", url: target.slice(0, 4096) }];
    }
    if (action === "listening") {
      return [{ type: "event", event: voiceState("listening") }];
    }
    if (action === "speaking") {
      const commands = [{ type: "event", event: voiceState("speaking") }];
      const level = Number(url.searchParams.get("level"));
      if (Number.isFinite(level)) {
        commands.push({
          type: "event",
          event: { type: "audio-level", level: Math.max(0, Math.min(1, level)) },
        });
      }
      return commands;
    }
    if (action === "thinking") {
      return [{ type: "event", event: voiceState("idle") }];
    }
    if (action === "inactive" || action === "stop") {
      return [{ type: "event", event: voiceState("idle", "inactive") }];
    }
    const animation = {
      idle: "IDLE",
      greeting: "GREETING",
      happy: "HAPPY",
      "finger-gun": "FINGER_GUN",
      dance: "DANCE",
    }[action];
    if (animation) {
      return [
        {
          type: "event",
          event: { type: "animation", animation },
        },
      ];
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = { parseProtocolUrl, voiceState };
