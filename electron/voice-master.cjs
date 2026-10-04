"use strict";

/**
 * The room's master voice switch, with the in-flight target held in memory.
 *
 * Muting is said aloud BEFORE it lands ("Voices off." must be audible), so
 * cast.json lags the request by one spoken sentence. Without a remembered
 * target, "off" then "on" inside that sentence read the file (still unmuted),
 * treated "on" as already done, and the late write muted the room anyway.
 * Here target() answers with the pending state while the sentence plays, an
 * unmute cancels a pending mute, and a superseded mute never writes.
 *
 *   createVoiceMaster({ cast, speak, onChange, log }) -> { set(muted), target(), pending() }
 *
 * cast:  { allMuted(), setAllMuted(on) }  (cast-config.cjs)
 * speak: (text) => Promise                 (main.cjs speakAloud, fixed slot/origin)
 */
function createVoiceMaster({ cast, speak, onChange = () => {}, log = () => {} }) {
  let pendingMute = false;
  let generation = 0;

  function fileSays() {
    try { return Boolean(cast.allMuted()); } catch { return false; }
  }

  /** The state the room is heading to: the pending mute, else the file. */
  function target() {
    return pendingMute ? true : fileSays();
  }

  function say(text) {
    try { return Promise.resolve(speak(text)); } catch (error) { return Promise.reject(error); }
  }

  /** Set (not flip) the master switch; returns the state the room is heading to. */
  function set(muted) {
    const next = Boolean(muted);
    if (next === target()) return next;
    const mine = ++generation;
    if (!next) {
      // Cancel any mute still being announced, then unmute and confirm audibly.
      pendingMute = false;
      cast.setAllMuted(false);
      onChange();
      say("Voices on.").catch((error) => log("voices-on speech failed", error && error.message));
      return false;
    }
    pendingMute = true;
    say("Voices off.")
      .catch((error) => log("voices-off speech failed", error && error.message))
      .then(() => {
        if (mine !== generation) return; // an unmute (or a newer mute) superseded this one
        try {
          cast.setAllMuted(true);
        } catch (error) {
          log("setAllMuted write failed", error && error.message);
        }
        pendingMute = false;
        onChange();
      });
    onChange();
    return true;
  }

  return { set, target, pending: () => pendingMute };
}

module.exports = { createVoiceMaster };
