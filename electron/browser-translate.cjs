"use strict";

/**
 * browser-translate.cjs -- which language a page is in, and who translates it.
 *
 * Edge offers "Translate this page?" when a page is not in your language and sends the
 * text to Microsoft. Here the text goes to a model this machine can reach, and the
 * owner is told which one answered. This module holds the parts that need no Electron:
 *
 *   - detectLanguage: the script (Cyrillic, Han, kana...) or, for Latin text, the
 *     language whose everyday words appear most. A page's own `lang` attribute is only
 *     the fallback: many sites leave it at "en" whatever they publish.
 *   - shouldOffer: an owner web tab, not InPrivate, a language that is not the app's,
 *     a site not muted. An agent's tab is never offered anything.
 *   - createTranslator: batches go to the first backend that answers. A backend that
 *     times out or answers nothing is dropped for the rest of the page and the next one
 *     takes the same batch, so one dead model does not cost a page its translation.
 *   - the backends: the fleet's MicroScheduler, the local node (adk daemon / awnode),
 *     the bundled local model (bonsai-local) and the desk's own agent. Each is a
 *     {id, label, ask(prompt)}; browser-window.cjs supplies the transports.
 *
 * Measured 2026-11-13 on the owner's machine: MicroScheduler answered a two-string
 * batch on bonsai2-27b-5090 in 2.4 s; the adk daemon took 48 s for the same batch (it
 * wraps every chat in a 4,200-token system prompt) and its first listed model did not
 * answer in 120 s. Hence the order, and a time limit on every ask.
 */

const { parseTranslation, translateBatches, translatePrompt } = require("./browser-everyday.cjs");

// ---------------------------------------------------------------- language detection

/** Everyday words that are common in one language and rare in the others listed. */
const STOPWORDS = Object.freeze({
  en: "the and of to in is that for it with as was on are this be by at from have not but they you which or had we his her were been their would there what about when your can said".split(" "),
  de: "der die das und ist nicht mit sich auf für von den dem ein eine einer auch als nach bei wird sind oder aus wie noch nur über haben werden zum zur durch diese dieser wir ich sie es im um wenn kann mehr".split(" "),
  es: "el la los las de que y en un una es por con para no se su al lo como más pero sus le ya fue este esta entre cuando muy sin sobre también hasta hay donde quien desde todo nos durante".split(" "),
  fr: "le la les de des du et en un une est que qui dans pour pas sur au aux avec ce cette ces son ses par plus ne se sont mais comme nous vous ils elle été être fait tout leur aussi où".split(" "),
  it: "il lo la gli le di che e è un una per non con del della dei delle nel nella sono come più anche ma si su al alla questo questa essere ha hanno tra fra molto quando dove loro suo sua".split(" "),
  pt: "o a os as de que e do da dos das em um uma para com não por mais como mas foi ao ele ela seu sua ou ser quando muito há nos já está também só pelo pela até isso entre são você".split(" "),
  nl: "de het een en van in is dat op te zijn met voor niet aan er ook als bij door maar om uit naar dan nog wel deze dit heeft worden wordt werd hij zij je ik wij hun meer geen over".split(" "),
  sv: "och att det som en på är av för med till den har inte om ett han men var jag sig från vi så kan när skulle hade också eller vad efter än här mot under mycket bara".split(" "),
  da: "og i at det en den til er som på de med han af for ikke der var mig sig men et har om vi min havde ham hun nu over da fra du ud sin dem os op man hans hvor eller hvad skal".split(" "),
  pl: "i w nie na z że do się jest to jak o po ale tak za od przez czy już tylko jego jej dla był była było być są oraz ten ta tym może który która które bardzo kiedy też".split(" "),
  tr: "ve bir bu da de için ile olarak çok daha gibi en ama kadar olan var ne o ben sen biz değil mi her şey sonra ya ki ise veya göre bütün diye hem içinde üzere".split(" "),
});

/** A character class for one Unicode block, built from code points (no raw glyphs in source). */
const block = (from, to) => new RegExp(`[${String.fromCharCode(from)}-${String.fromCharCode(to)}]`, "g");
const SCRIPTS = Object.freeze([
  { lang: "ja", re: block(0x3040, 0x30ff), weight: 3 }, // kana: Japanese even among kanji
  { lang: "ko", re: block(0xac00, 0xd7af), weight: 1 }, // Hangul
  { lang: "zh", re: block(0x4e00, 0x9fff), weight: 1 }, // Han
  { lang: "ru", re: block(0x0400, 0x04ff), weight: 1 }, // Cyrillic
  { lang: "ar", re: block(0x0600, 0x06ff), weight: 1 },
  { lang: "he", re: block(0x0590, 0x05ff), weight: 1 },
  { lang: "el", re: block(0x0370, 0x03ff), weight: 1 },
  { lang: "th", re: block(0x0e00, 0x0e7f), weight: 1 },
  { lang: "hi", re: block(0x0900, 0x097f), weight: 1 }, // Devanagari
]);

/**
 * The language of `text`: {lang, confidence 0..1} or null when it cannot tell (too
 * short, or a language this small detector does not know).
 */
function detectLanguage(text) {
  const s = String(text || "").slice(0, 6000);
  const letters = (s.match(/\p{L}/gu) || []).length;
  if (letters < 20) return null;
  let best = null;
  for (const script of SCRIPTS) {
    const n = (s.match(script.re) || []).length * script.weight;
    if (n / letters >= 0.25 && (!best || n > best.n)) best = { lang: script.lang, n };
  }
  if (best) {
    // Ukrainian letters that Russian does not have.
    if (best.lang === "ru" && (s.match(/[іїєґ]/gi) || []).length >= 3) return { lang: "uk", confidence: 0.8 };
    return { lang: best.lang, confidence: Math.min(1, best.n / letters + 0.3) };
  }
  const words = s.toLowerCase().match(/\p{L}+/gu) || [];
  if (words.length < 8) return null;
  const counts = new Map();
  for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
  const scores = [];
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    let hits = 0;
    for (const w of list) hits += counts.get(w) || 0;
    scores.push({ lang, hits });
  }
  scores.sort((a, b) => b.hits - a.hits);
  const [first, second] = scores;
  if (first.hits < 4 || first.hits / words.length < 0.08) return null;
  if (second.hits && first.hits < second.hits * 1.3) return null; // too close to call
  return { lang: first.lang, confidence: Math.min(1, (first.hits - second.hits) / Math.max(1, first.hits) + 0.2) };
}

/** The primary subtag of a language tag ("de-AT" -> "de"), or "" when it is not one. */
function primaryLang(tag) {
  const m = /^([a-z]{2,3})(?:[-_]|$)/i.exec(String(tag || "").trim());
  return m ? m[1].toLowerCase() : "";
}

/**
 * The language of a page from what the isolated world read: its text decides; the
 * `lang` attribute is used only when the text is long enough to be a page and the
 * detector does not know its language.
 */
function pageLanguage({ htmlLang = "", text = "" } = {}) {
  const found = detectLanguage(text);
  if (found) return found.lang;
  if (String(text || "").replace(/\s+/g, " ").length < 200) return "";
  return primaryLang(htmlLang);
}

/** "German" for "de" (in English: the notice is English, like the rest of the toolbar). */
function languageName(code, displayLocale = "en") {
  const c = primaryLang(code);
  if (!c) return "";
  try { return new Intl.DisplayNames([displayLocale], { type: "language" }).of(c) || c; } catch { return c; }
}

/**
 * Offer "This page is in <language>. Translate?" Only on the owner's own web tab, never
 * InPrivate (a private page's text is not sent to a model unasked: the owner uses the
 * menu), never on an agent's tab, never twice on a site the owner said "not now" to.
 */
function shouldOffer({ pageLang, appLang, tab = {}, host = "", muted = null, enabled = true } = {}) {
  if (!enabled || !pageLang) return false;
  if (!tab || tab.by !== "you" || tab.private || (tab.kind && tab.kind !== "web")) return false;
  if (primaryLang(pageLang) === (primaryLang(appLang) || "en")) return false;
  if (muted && host && muted.has(String(host).toLowerCase())) return false;
  return true;
}

/** Isolated-world script: the page's `lang` and the first stretch of its visible text. */
const LANGUAGE_SAMPLE_SCRIPT = `(() => {
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEXTAREA", "SVG", "MATH"]);
  let text = "";
  const root = document.body;
  if (root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        return !p || skip.has(p.tagName) || !n.nodeValue.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n && text.length < 3000; n = walker.nextNode()) text += n.nodeValue.trim() + " ";
  }
  return { lang: document.documentElement.lang || "", text: text.slice(0, 3000) };
})()`;

// ---------------------------------------------------------------- the pipeline

function withTimeout(promise, ms) {
  let timer = null;
  const limit = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); });
  return Promise.race([Promise.resolve(promise).then((v) => ({ value: v }), (e) => ({ error: e })), limit])
    .finally(() => clearTimeout(timer));
}

/**
 * Translate `texts` with the first backend that answers.
 * @param {{backends: Array<{id: string, label: string, ask: (prompt: string) => Promise<string>, timeoutMs?: number}>,
 *   timeoutMs?: number, batch?: {maxChars?: number, maxItems?: number}}} opts
 */
function createTranslator({ backends = [], timeoutMs = 60000, batch = { maxChars: 2000, maxItems: 40 } } = {}) {
  /**
   * @param {{texts: string[], target: string, apply: (start: number, out: string[]) => Promise<number>|number,
   *   onProgress?: (p: {done: number, total: number, backend: string|null}) => void, stillWanted?: () => boolean}} job
   * @returns {Promise<{ok: boolean, changed: number, batches: number, backend: {id, label}|null,
   *   tried: Array<{id: string, label: string, ok: boolean, error?: string}>}>}
   */
  async function translate({ texts, target = "English", apply, onProgress = null, stillWanted = () => true }) {
    const live = backends.filter((b) => b && typeof b.ask === "function").map((b) => ({ ...b, answered: 0, error: "" }));
    const dead = [];
    const queue = translateBatches(texts, batch);
    let changed = 0;
    let done = 0;
    let used = null;

    /** One batch on one backend: the translated strings, or {error}. */
    async function ask(backend, part) {
      const r = await withTimeout(backend.ask(translatePrompt(part.texts, target)), backend.timeoutMs || timeoutMs);
      if (r.timedOut) return { error: `no answer in ${Math.round((backend.timeoutMs || timeoutMs) / 1000)} s`, dead: true };
      if (r.error) return { error: String((r.error && r.error.message) || r.error), dead: true };
      const reply = typeof r.value === "string" ? r.value : "";
      if (!reply.trim()) return { error: "no text came back", dead: true };
      const out = parseTranslation(reply, part.texts.length);
      return out ? { out } : { error: "the answer was not the list that was asked for" };
    }

    /** A batch the model garbled is asked again in two halves, once. */
    async function askSplit(backend, part) {
      const first = await ask(backend, part);
      if (first.out || first.dead || part.texts.length < 2) return first;
      const mid = Math.ceil(part.texts.length / 2);
      const a = await ask(backend, { start: part.start, texts: part.texts.slice(0, mid) });
      if (!a.out) return a;
      const b = await ask(backend, { start: part.start + mid, texts: part.texts.slice(mid) });
      // Half a batch is still worth writing: the rest stays in the original language.
      return { out: b.out ? [...a.out, ...b.out] : [...a.out, ...part.texts.slice(mid).map(() => "")] };
    }

    for (const part of queue) {
      if (!stillWanted()) break;
      if (typeof onProgress === "function") onProgress({ done, total: queue.length, backend: used ? used.label : null });
      while (live.length) {
        const backend = live[0];
        const r = await askSplit(backend, part);
        if (r.out) {
          backend.answered += 1;
          used = backend;
          if (stillWanted()) changed += Number(await apply(part.start, r.out)) || 0;
          break;
        }
        backend.error = r.error;
        // Dead (timeout, nothing back) or never once right: the next backend takes over.
        // One that has been answering keeps the page; this batch stays untranslated.
        if (r.dead || !backend.answered) { dead.push(live.shift()); continue; }
        break;
      }
      done += 1;
      if (!live.length) break;
    }
    const tried = [...dead, ...live.filter((b) => b.answered || b.error)]
      .map((b) => ({ id: b.id, label: b.label, ok: b.answered > 0, ...(b.error ? { error: b.error } : {}) }));
    return { ok: changed > 0, changed, batches: queue.length, backend: used ? { id: used.id, label: used.label } : null, tried };
  }
  return { translate };
}

/** "MicroScheduler: no answer in 60 s; local node: no model" for the failure notice. */
function describeTried(tried) {
  return (tried || []).filter((t) => !t.ok).map((t) => `${t.label}: ${t.error || "no answer"}`).join("; ");
}

// ---------------------------------------------------------------- backends

/**
 * A tiny JSON client over node's http(s) for the MicroScheduler. `tls` is spread into
 * the https options (the internal CA from internal-ca.cjs); certificates are verified.
 */
function createJsonHttp({ tls = {} } = {}) {
  function request(method, url, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const secure = target.protocol === "https:";
      const payload = body == null ? null : Buffer.from(JSON.stringify(body));
      const req = require(secure ? "node:https" : "node:http").request(target, {
        method, timeout: timeoutMs, ...(secure ? tls : {}),
        headers: payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {},
      }, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
          resolve({ status: res.statusCode || 0, json });
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`)));
      if (payload) req.write(payload);
      req.end();
    });
  }
  return {
    getJson: (url, timeoutMs = 5000) => request("GET", url, null, timeoutMs),
    postJson: (url, body, timeoutMs = 60000) => request("POST", url, body, timeoutMs),
  };
}

/** The text of an OpenAI-style chat completion body, or "". */
function completionText(doc) {
  const msg = doc && Array.isArray(doc.choices) && doc.choices[0] && doc.choices[0].message;
  const content = msg && msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("");
  return "";
}

/**
 * Which of a `/v1/models` list to translate with: a lane on this machine or its fleet
 * that reports itself available, Bonsai first. Never a hosted API lane (`*_api`): page
 * text must not leave for a cloud model. `prefer` is an exact id the owner set.
 */
function pickTranslateModel(models, prefer = "") {
  const list = (Array.isArray(models) ? models : []).filter((m) => m && typeof m.id === "string"
    && m.aither && m.aither.available === true
    && !/_api$/i.test(String(m.owned_by || "")) && !/embed|rerank|whisper|tts/i.test(m.id));
  if (prefer) {
    const exact = list.find((m) => m.id === prefer);
    if (exact) return exact.id;
  }
  const idle = list.filter((m) => !m.aither.busy);
  const pool = idle.length ? idle : list;
  const pick = pool.find((m) => /^bonsai2/i.test(m.id)) || pool.find((m) => /bonsai/i.test(m.id)) || pool[0];
  return pick ? pick.id : null;
}

/**
 * The fleet's MicroScheduler (every model call on an AitherOS machine goes through it).
 * `http` = {getJson(url), postJson(url, body, timeoutMs)} -> {status, json}; browser-window
 * supplies one that trusts the internal CA.
 */
function schedulerBackend({ base, http, prefer = "", timeoutMs = 60000 }) {
  let model = null;
  return {
    id: "scheduler", label: "MicroScheduler", timeoutMs,
    get model() { return model; },
    async ask(prompt) {
      if (!model) {
        const r = await http.getJson(`${base}/v1/models`, 5000);
        model = r && r.status === 200 ? pickTranslateModel(r.json && r.json.data, prefer) : null;
        if (!model) throw new Error(r && r.status === 200 ? "no local model lane is up" : "not reachable");
        this.label = `MicroScheduler (${model})`;
      }
      const r = await http.postJson(`${base}/v1/chat/completions`, {
        model, max_tokens: 2048, temperature: 0.1, priority: "user", source: "chat:desk-browser-translate",
        messages: [{ role: "user", content: prompt }],
      }, timeoutMs);
      if (!r || r.status !== 200) throw new Error(`answered ${r ? r.status : "nothing"}`);
      return completionText(r.json);
    },
  };
}

/**
 * The local node, through the overlay's daemon-call (adk daemon with the owner's local
 * token, then awnode): the same probe order and the same allowlist as AitherOS Online.
 */
function nodeBackend({ answer, prefer = "", timeoutMs = 90000 }) {
  let model = null;
  return {
    id: "node", label: "the local node", timeoutMs,
    async ask(prompt) {
      if (!model) {
        const r = await answer({ type: "daemon-call", method: "GET", path: "/v1/models" });
        model = r && r.ok ? pickTranslateModel(r.data && r.data.data, prefer) : null;
        if (!model) throw new Error(r && r.ok ? "it lists no available local model" : String((r && r.error) || "not reachable"));
        this.label = `the local node (${model})`;
      }
      const r = await answer({ type: "daemon-call", method: "POST", path: "/v1/chat/completions", body: {
        model, max_tokens: 2048, temperature: 0.1, messages: [{ role: "user", content: prompt }],
      } });
      if (!r || !r.ok) throw new Error(String((r && r.error) || `answered ${r && r.status}`));
      return completionText(r.data);
    },
  };
}

/** The bundled local model (local-ai.cjs, `adk bonsai-local` on 127.0.0.1). */
function bonsaiLocalBackend({ chat, timeoutMs = 90000 }) {
  return {
    id: "bonsai-local", label: "Local AI (bonsai-local)", timeoutMs,
    async ask(prompt) {
      const r = await chat([{ role: "user", content: prompt }]);
      if (!r || !r.ok) throw new Error(String((r && r.error) || "not running"));
      return String(r.text || "");
    },
  };
}

/** The desk's own agent (whatever the owner's desk session talks to). Last: it may be remote. */
function agentBackend({ askAgent, timeoutMs = 90000 }) {
  return {
    id: "agent", label: "the desk agent", timeoutMs,
    async ask(prompt) {
      const r = await askAgent(prompt);
      if (!r || r.ok === false) throw new Error(String((r && r.reply) || "did not answer"));
      return String(r.reply || "");
    },
  };
}

module.exports = {
  LANGUAGE_SAMPLE_SCRIPT, STOPWORDS,
  agentBackend, bonsaiLocalBackend, completionText, createJsonHttp, createTranslator, describeTried, detectLanguage,
  languageName, nodeBackend, pageLanguage, pickTranslateModel, primaryLang, schedulerBackend, shouldOffer,
};
