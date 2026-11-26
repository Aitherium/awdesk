"use strict";

/**
 * voice-bridge.cjs -- Sovereign local voice bridge for Unified AitherBrowser.
 *
 * Talks directly to local awvoice (:8768, Kokoro TTS + local Whisper STT) and
 * the host STT shim (:8195), degrading honestly to `{ ok: false, offline: true }`
 * when no local voice service is running. Zero vendor API keys required.
 *
 * Pure Node CJS (zero Electron imports; injectable fetchImpl for unit tests).
 */

const DEFAULT_AWVOICE_BASE = process.env.AWVOICE_URL || "http://127.0.0.1:8768";
const DEFAULT_STT_SHIM_URL = process.env.AWDESK_STT_SHIM_URL || "http://127.0.0.1:8195/voice/transcribe/base64";
const DEFAULT_VOICE = process.env.AITHER_VOICE || "af_heart";

function createVoiceBridge({
  awvoiceBase = DEFAULT_AWVOICE_BASE,
  sttShimUrl = DEFAULT_STT_SHIM_URL,
  defaultVoice = DEFAULT_VOICE,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = String(awvoiceBase || DEFAULT_AWVOICE_BASE).replace(/\/+$/, "");

  async function status() {
    if (typeof fetchImpl !== "function") {
      return { ok: false, offline: true, endpoint: base };
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1500);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const res = await fetchImpl(`${base}/health`, { signal: ac.signal });
      return { ok: res.ok, offline: !res.ok, endpoint: base, status: res.status };
    } catch {
      return { ok: false, offline: true, endpoint: base };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Synthesize speech via local awvoice OpenAI-compatible `/v1/audio/speech`.
   * Returns `{ ok: true, audioDataUrl, mime, voice }` so the renderer plays
   * real Kokoro audio cleanly in `<audio>` without temp files.
   */
  async function speak(text, voice = defaultVoice) {
    const clean = String(text || "").trim().slice(0, 1200);
    if (!clean) return { ok: false, error: "empty text" };
    if (typeof fetchImpl !== "function") {
      return { ok: false, offline: true, fallbackBrowserSpeech: true };
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const res = await fetchImpl(`${base}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "kokoro",
          input: clean,
          voice: String(voice || defaultVoice),
          response_format: "wav",
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        return { ok: false, offline: true, fallbackBrowserSpeech: true, status: res.status };
      }
      const mime = String(res.headers?.get?.("content-type") || "audio/wav").split(";")[0];
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) {
        return { ok: false, offline: true, fallbackBrowserSpeech: true };
      }
      return {
        ok: true,
        offline: false,
        voice: String(voice || defaultVoice),
        mime,
        audioDataUrl: `data:${mime};base64,${buf.toString("base64")}`,
      };
    } catch (err) {
      return {
        ok: false,
        offline: true,
        fallbackBrowserSpeech: true,
        error: String(err?.message || err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Transcribe a base64 audio clip via local host STT shim (:8195) or awvoice.
   */
  async function transcribeBase64(audioBase64, format = "webm") {
    const b64 = String(audioBase64 || "").trim();
    if (!b64) return { ok: false, error: "empty audio" };
    if (typeof fetchImpl !== "function") {
      return { ok: false, offline: true };
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const res = await fetchImpl(sttShimUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio_base64: b64, format: String(format || "webm") }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data && typeof data.text === "string") {
        return { ok: true, offline: false, text: data.text.trim() };
      }
      return { ok: false, offline: true };
    } catch (err) {
      return { ok: false, offline: true, error: String(err?.message || err) };
    } finally {
      clearTimeout(timer);
    }
  }

  return { status, speak, transcribeBase64 };
}

module.exports = {
  DEFAULT_AWVOICE_BASE,
  DEFAULT_STT_SHIM_URL,
  DEFAULT_VOICE,
  createVoiceBridge,
};
