"use strict";

/**
 * custom-voice.cjs -- the desk speaks in a workspace's OWN built voice.
 *
 * A voice id of the form "custom:<name>" names a voice the workspace built
 * through Genesis /voice-builds (merged #11472). Those voices are not on the
 * stock AitherVoice :8084 path drop-router dials -- they are synthesized by
 * Genesis itself, scoped to the CALLER's workspace:
 *
 *   GET  /voice-builds/voices              -> {voices:[{id,name,reader,language,built_at,gate}]}
 *   POST /voice-builds/voices/{name}/say   {text, speed?} -> {audio_base64, format:"wav", voice}
 *
 * Reached through the same door browser-context-push.cjs uses: Veil's Genesis
 * bridge on loopback (GENESIS_BRIDGE_URL, DESK_GENESIS_BRIDGE_URL overrides)
 * with the session bearer. Nothing new is invented here -- no host, no port.
 *
 * Fail-soft like every desk lane: a dead bridge, a 401 or a 404 resolves a
 * verdict ({ok:false, reason}), never an exception into speakAloud. A failed
 * custom synthesis leaves the line captioned and muted, exactly as a dead
 * stock voice service does today; it does NOT silently swap in a stock voice
 * (the owner picked THIS voice -- a different voice saying it is a lie).
 */

const { GENESIS_BRIDGE_URL } = require("./browser-context-push.cjs");
const { bearer } = require("./gateway-mcp.cjs");

const PREFIX = "custom:";
const LIST_PATH = "/voice-builds/voices";
// Genesis SayRequest: text 1..1000 chars, speed 0.5..2.0 -- anything outside is a
// 422, so it is clamped HERE rather than turned into a mute by the server.
const SAY_MAX_CHARS = 1000;
const SAY_SPEED_MIN = 0.5;
const SAY_SPEED_MAX = 2.0;
const LIST_TIMEOUT_MS = 5000;
const SAY_TIMEOUT_MS = 60000;

function isCustomVoice(voice) {
  return typeof voice === "string" && voice.startsWith(PREFIX) && voice.length > PREFIX.length;
}

function customVoiceName(voice) {
  return isCustomVoice(voice) ? voice.slice(PREFIX.length).trim() : "";
}

function clampSaySpeed(speed) {
  const num = Number(speed);
  if (!Number.isFinite(num)) return 1.0;
  return Math.max(SAY_SPEED_MIN, Math.min(SAY_SPEED_MAX, num));
}

/** Exact WAV length from the RIFF header (byteRate at offset 28, the data chunk's
 *  size). Piper writes 22.05 kHz, not drop-router's assumed 24 kHz, and room-stage
 *  paces the next speaker on this number. 0 when the header cannot be read. */
function wavDurationMs(audioBase64) {
  let buf;
  try {
    buf = Buffer.from(String(audioBase64 || ""), "base64");
  } catch {
    return 0;
  }
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return 0;
  const byteRate = buf.readUInt32LE(28);
  if (!byteRate) return 0;
  // Walk the chunks for "data"; fall back to everything after the 44-byte header.
  let dataBytes = buf.length - 44;
  for (let off = 12; off + 8 <= buf.length;) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      dataBytes = Math.min(size, buf.length - off - 8);
      break;
    }
    off += 8 + size + (size % 2);
  }
  return Math.round((Math.max(0, dataBytes) / byteRate) * 1000);
}

/** One JSON request through the bridge. Resolves {status, json, reason}, never rejects. */
function bridgeRequest(method, urlPath, body, { base, token, request, timeoutMs }) {
  return new Promise((resolve) => {
    if (!token) return resolve({ status: 0, json: null, reason: "no session bearer" });
    const url = String(base || GENESIS_BRIDGE_URL).replace(/\/+$/, "") + urlPath;
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
    if (data) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = data.length;
    }
    let req;
    try {
      const mod = request || require(url.startsWith("https:") ? "node:https" : "node:http");
      req = mod.request(url, { method, headers, timeout: timeoutMs }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* a non-JSON body is judged by status alone */ }
          resolve({ status: res.statusCode, json, reason: "" });
        });
      });
    } catch (error) {
      return resolve({ status: 0, json: null, reason: String((error && error.message) || error) });
    }
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ status: 0, json: null, reason: String((error && error.message) || error) }));
    req.end(data || undefined);
  });
}

function failReason(res, fallback) {
  const detail = res.json && (res.json.detail || res.json.error);
  if (res.status) return `${fallback}: HTTP ${res.status}${detail ? ` ${String(detail).slice(0, 120)}` : ""}`;
  return `${fallback}: ${res.reason || "unreachable"}`;
}

/**
 * The workspace's built voices, as picker rows. {ok:false, voices:[]} on any
 * failure -- an empty picker addition, never a thrown error.
 */
async function listCustomVoices({ base, token = bearer(), request = null } = {}) {
  const res = await bridgeRequest("GET", LIST_PATH, undefined, { base, token, request, timeoutMs: LIST_TIMEOUT_MS });
  if (res.status !== 200 || !res.json || !Array.isArray(res.json.voices)) {
    return { ok: false, voices: [], reason: failReason(res, "custom voices unavailable") };
  }
  const voices = [];
  for (const row of res.json.voices) {
    const name = row && typeof row.name === "string" ? row.name.trim() : "";
    if (!name) continue;
    voices.push({
      id: PREFIX + name,
      name,
      language: typeof row.language === "string" ? row.language : "",
      gate: row.gate === undefined ? null : row.gate,
    });
  }
  return { ok: true, voices };
}

/**
 * Say `text` in custom voice `voice` ("custom:<name>"). Resolves the SAME shape
 * drop-router.synthesizeVerdict does: {ok:true, audioBase64, durationMs} or
 * {ok:false, reason}.
 */
async function synthesizeCustom(text, voice, { speed, maxChars, base, token = bearer(), request = null } = {}) {
  const name = customVoiceName(voice);
  if (!name) return { ok: false, reason: `not a custom voice: ${String(voice).slice(0, 40)}` };
  const cap = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
    ? Math.min(Number(maxChars), SAY_MAX_CHARS)
    : SAY_MAX_CHARS;
  const short = String(text || "").slice(0, cap);
  if (!short.trim()) return { ok: false, reason: "nothing to say" };
  const res = await bridgeRequest(
    "POST",
    `${LIST_PATH}/${encodeURIComponent(name)}/say`,
    { text: short, speed: clampSaySpeed(speed) },
    { base, token, request, timeoutMs: SAY_TIMEOUT_MS },
  );
  if (res.status === 404) return { ok: false, reason: `custom voice ${name} not found in this workspace` };
  const audio = res.json && res.json.audio_base64;
  if (res.status !== 200 || !audio) return { ok: false, reason: failReason(res, `custom voice ${name} failed`) };
  // Lazy: drop-router requires THIS module, so a top-level require would be a cycle.
  const { pickDurationMs, sniffAudioFormat } = require("./drop-router.cjs");
  const exact = wavDurationMs(audio);
  return { ok: true, audioBase64: audio, durationMs: exact > 0 ? exact : pickDurationMs(null, audio, sniffAudioFormat(audio)) };
}

module.exports = {
  PREFIX,
  SAY_MAX_CHARS,
  SAY_SPEED_MIN,
  SAY_SPEED_MAX,
  isCustomVoice,
  customVoiceName,
  clampSaySpeed,
  wavDurationMs,
  listCustomVoices,
  synthesizeCustom,
};
