"use strict";

/**
 * voice-client — the desk's voice: awvoice/aithervoice over the shared
 * gateway-mcp transport (owner 2026-08-25: "finish integrating
 * awvoice/aithervoice"). The aw* registry brick is AitherOS/packages/awvoice
 * ("turn speech into text and text into speech, on a service you host");
 * the desk speaks to it through the gateway's voice tools, never a vendor
 * SDK:
 *
 *   - get_voice_status    — is the hosted voice service up
 *   - get_available_voices — which voices exist
 *   - synthesize_speech   — text -> audio (the avatar's mouth)
 *   - transcribe_audio    — audio file -> text (the avatar's ears)
 *
 * Same degradation contract as system-client: every source fails soft, a
 * dead gateway yields ok:true with ERROR notes the UI renders as
 * "unavailable", never a half-truth (security-review-patterns #5). The
 * action functions (synthesize/transcribe) are exported for the IPC bridge;
 * the self-test is read-only (status + voices) because synthesis spends real
 * GPU time.
 */

const { callTool, parseMaybeJson } = require("./gateway-mcp.cjs");

const _http = require("node:http");
const _fs = require("node:fs");
const STT_SHIM_URL = process.env.AWDESK_STT_SHIM_URL || "http://127.0.0.1:8195/voice/transcribe/base64";

/** Host STT shim (perception :8084 down; desk_stt_shim.py mirrors its contract
 *  on the host and reads the HOST file directly). Resolves the transcript
 *  string, or null on any failure so the caller falls back to the gateway. */
function transcribeHostFile(hostPath) {
  return new Promise((resolve) => {
    let b64;
    try { b64 = _fs.readFileSync(hostPath).toString("base64"); } catch { return resolve(null); }
    let u;
    try { u = new URL(STT_SHIM_URL); } catch { return resolve(null); }
    const body = JSON.stringify({ audio_base64: b64, format: String(hostPath).split(".").pop() || "wav" });
    const req = _http.request({
      host: u.hostname, port: u.port, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 120000,
    }, (res) => {
      let t = ""; res.setEncoding("utf8");
      res.on("data", (c) => { t += c; });
      res.on("end", () => { try { const j = JSON.parse(t); resolve(j && j.success ? String(j.text || "") : null); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

/** Aither's own recognizer in the cloud: POST {base}/api/voice/hear (multipart
 *  `audio`, <= 60 s, any signed-in account; Veil verifies the session and sends
 *  the clip to AitherVoice, which keeps nothing). The lane a customer's desk has
 *  when no fleet runs beside it. Uses the user's own login (~/.aither/auth.json,
 *  written by "Set up Aither" / `adk login`), else the desk session bearer.
 *  Resolves the transcript ("" = nobody spoke), or null on ANY failure so the
 *  caller falls through to the next lane. The token is never logged. */
const CLOUD_HEAR_BASE = String(process.env.AWDESK_CLOUD_API_URL || "https://api.aitherium.com").replace(/\/+$/, "");
const CLOUD_HEAR_PATH = "/api/voice/hear";
const CLOUD_HEAR_MAX_BYTES = 10 * 1024 * 1024;

function cloudToken() {
  try {
    const picked = require("./desk-session.cjs").readAuthStoreToken();
    if (picked && picked.token) return picked.token;
  } catch { /* no auth store: try the session bearer */ }
  try { return require("./gateway-mcp.cjs").bearer(); } catch { return ""; }
}

/** The multipart body /api/voice/hear reads: one `audio` part. */
function hearBody(audio, ext, boundary) {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="clip.${ext}"\r\n`
      + "Content-Type: application/octet-stream\r\n\r\n"),
    audio,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

function transcribeCloud(hostPath, { base = CLOUD_HEAR_BASE, token, request = null } = {}) {
  return new Promise((resolve) => {
    const bearerToken = token === undefined ? cloudToken() : token;
    if (!bearerToken) return resolve(null);
    let audio;
    try { audio = _fs.readFileSync(hostPath); } catch { return resolve(null); }
    if (!audio.length || audio.length > CLOUD_HEAR_MAX_BYTES) return resolve(null);
    const ext = (String(hostPath).split(".").pop() || "wav").toLowerCase();
    const boundary = `awdesk${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const body = hearBody(audio, ext, boundary);
    let req;
    try {
      const url = String(base).replace(/\/+$/, "") + CLOUD_HEAR_PATH;
      const mod = request || require(url.startsWith("https:") ? "node:https" : "node:http");
      req = mod.request(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${bearerToken}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
        timeout: 95000,
      }, (res) => {
        let t = ""; res.setEncoding("utf8");
        res.on("data", (c) => { t += c; });
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve(null);
          try { const j = JSON.parse(t); resolve(typeof j.text === "string" ? j.text : null); } catch { resolve(null); }
        });
      });
    } catch { return resolve(null); }
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

async function voiceStatus(call = callTool) {
  const text = await call("get_voice_status", {});
  return parseMaybeJson(text) ?? { note: text.slice(0, 300) };
}

async function listVoices(call = callTool) {
  const text = await call("get_available_voices", {});
  return parseMaybeJson(text) ?? { note: text.slice(0, 300) };
}

/** text -> audio. Returns the parsed result (the hosted service reports
 *  where the audio landed); the caller renders it, never echoes verbatim. */
async function synthesize(text, voice, call = callTool) {
  const args = { text };
  if (voice) args.voice = voice;
  const out = await call("synthesize_speech", args);
  return parseMaybeJson(out) ?? { note: out.slice(0, 300) };
}

/** audio file -> transcript. `audioPath` is a HOST path — the desk and the
 *  gateway share the box, so no upload hop is involved. */
async function transcribe(audioPath, call = callTool) {
  const out = await call("transcribe_audio", { audio_path: audioPath });
  return parseMaybeJson(out) ?? { note: out.slice(0, 300) };
}

/** One read-only awareness call for the deck section: service status +
 *  available voices. */
async function voiceSnapshot(call = callTool) {
  try {
    const [statusText, voicesText] = await Promise.all([
      call("get_voice_status", {}).catch((error) => `ERROR: ${error.message}`),
      call("get_available_voices", {}).catch((error) => `ERROR: ${error.message}`),
    ]);
    return {
      ok: true,
      status: parseMaybeJson(statusText) ?? { note: statusText.slice(0, 300) },
      voices: parseMaybeJson(voicesText) ?? { note: voicesText.slice(0, 300) },
      at: Math.floor(Date.now() / 1000),
    };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 300) };
  }
}

module.exports = { voiceStatus, listVoices, synthesize, transcribe, transcribeHostFile, transcribeCloud, voiceSnapshot };

if (require.main === module) {
  // Self-test: read-only. Exit 0 = service up, 1 = service down/unreachable
  // (the status envelope reports its own error), 2 = module broken. A
  // healthy transport over a down service is UNAVAILABLE, never OK.
  (async () => {
    try {
      const snap = await voiceSnapshot();
      if (!snap.ok) {
        console.error(`VOICE UNAVAILABLE: ${snap.reason}`);
        process.exit(1);
      }
      if (snap.status?.status === "error") {
        console.error(`VOICE UNAVAILABLE: ${snap.status.error || "service error"}`);
        process.exit(1);
      }
      // A note fallback means the source did not parse — and one that
      // opens with "ERROR:" is a failed probe, not a valid answer.
      if (snap.status?.note?.startsWith("ERROR:")) {
        console.error(`VOICE UNAVAILABLE: ${snap.status.note}`);
        process.exit(1);
      }
      const voices = snap.voices;
      const count = Array.isArray(voices?.voices) ? voices.voices.length
        : Array.isArray(voices) ? voices.length
          : voices?.note ? `prose list (${voices.note.slice(0, 40)}...)` : "?";
      console.log(`VOICE OK: ${count} voice(s)`);
      process.exit(0);
    } catch (error) {
      console.error(`MODULE BROKEN: ${error && error.stack ? error.stack : error}`);
      process.exit(2);
    }
  })();
}
