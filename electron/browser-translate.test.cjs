"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("./browser-translate.cjs");

const GERMAN = "Die Stadt hat am Montag ein neues Museum eröffnet. Der Eintritt ist für Kinder frei, und die Ausstellung wird bis zum Ende des Jahres zu sehen sein. Viele Besucher sind aus der ganzen Region gekommen.";
const SPANISH = "El gobierno anunció hoy un nuevo plan para mejorar el transporte en la ciudad. Los vecinos dicen que es una buena noticia, pero que todavía hay mucho por hacer en los barrios del sur.";
const ENGLISH = "The city opened a new museum on Monday. Entry is free for children, and the exhibition will be on show until the end of the year. Many visitors have come from across the region.";
const FRENCH = "Le gouvernement a annoncé un nouveau plan pour les transports dans la ville. Les habitants disent que c'est une bonne nouvelle, mais qu'il reste beaucoup à faire dans les quartiers du sud.";

test("everyday words decide the language of Latin text", () => {
  assert.equal(T.detectLanguage(GERMAN).lang, "de");
  assert.equal(T.detectLanguage(SPANISH).lang, "es");
  assert.equal(T.detectLanguage(ENGLISH).lang, "en");
  assert.equal(T.detectLanguage(FRENCH).lang, "fr");
});

test("the script decides for text that is not Latin", () => {
  const cp = (...codes) => String.fromCharCode(...codes);
  const repeat = (s) => `${s} `.repeat(12);
  assert.equal(T.detectLanguage(repeat(cp(0x41f, 0x440, 0x438, 0x432, 0x435, 0x442, 0x20, 0x43c, 0x438, 0x440))).lang, "ru");
  assert.equal(T.detectLanguage(repeat(cp(0x3053, 0x3093, 0x306b, 0x3061, 0x306f, 0x4e16, 0x754c))).lang, "ja");
  assert.equal(T.detectLanguage(repeat(cp(0x4f60, 0x597d, 0x4e16, 0x754c))).lang, "zh");
  assert.equal(T.detectLanguage(repeat(cp(0xc548, 0xb155, 0xd558, 0xc138, 0xc694))).lang, "ko");
});

test("too little text, or a language it does not know, is not guessed", () => {
  assert.equal(T.detectLanguage("OK"), null);
  assert.equal(T.detectLanguage("Login 2026 v1.2 API SDK"), null);
  assert.equal(T.detectLanguage("lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt"), null);
});

test("the page's text outranks its lang attribute; the attribute is only the fallback", () => {
  assert.equal(T.pageLanguage({ htmlLang: "en", text: GERMAN }), "de", "a German page that says lang=en");
  assert.equal(T.pageLanguage({ htmlLang: "de-AT", text: ENGLISH }), "en");
  const finnish = "Kaupunki avasi maanantaina uuden museon. Lapset pääsevät sisään ilmaiseksi, ja näyttely on esillä vuoden loppuun asti. ".repeat(3);
  assert.equal(T.pageLanguage({ htmlLang: "fi", text: finnish }), "fi", "unknown to the detector: the attribute speaks");
  assert.equal(T.pageLanguage({ htmlLang: "fi", text: "Hei" }), "", "a near-empty page is not judged by its attribute");
  assert.equal(T.pageLanguage({ htmlLang: "", text: "" }), "");
});

test("the offer goes to the owner's own web tab only", () => {
  const owner = { by: "you", private: false, kind: "web" };
  assert.equal(T.shouldOffer({ pageLang: "de", appLang: "en-US", tab: owner, host: "zeit.test" }), true);
  assert.equal(T.shouldOffer({ pageLang: "en", appLang: "en-US", tab: owner }), false, "already the owner's language");
  assert.equal(T.shouldOffer({ pageLang: "de", appLang: "de-DE", tab: owner }), false);
  assert.equal(T.shouldOffer({ pageLang: "de", appLang: "en", tab: { ...owner, private: true } }), false, "never InPrivate");
  assert.equal(T.shouldOffer({ pageLang: "de", appLang: "en", tab: { ...owner, by: "agent" } }), false, "never an agent's tab");
  assert.equal(T.shouldOffer({ pageLang: "de", appLang: "en", tab: { ...owner, kind: "internal" } }), false);
  assert.equal(T.shouldOffer({ pageLang: "de", appLang: "en", tab: owner, host: "zeit.test", muted: new Set(["zeit.test"]) }), false, "Not now holds");
  assert.equal(T.shouldOffer({ pageLang: "de", appLang: "en", tab: owner, enabled: false }), false);
  assert.equal(T.shouldOffer({ pageLang: "", appLang: "en", tab: owner }), false);
  assert.equal(T.languageName("de-AT"), "German");
});

/** A fake model: upper-cases every string, the way a translator returns a same-length list. */
function fakeModel({ label = "fake", fail = null, garbleFirst = 0, delayMs = 0 } = {}) {
  const calls = [];
  let garble = garbleFirst;
  return {
    id: label, label, calls, timeoutMs: 200,
    async ask(prompt) {
      calls.push(prompt);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fail === "throw") throw new Error("connection refused");
      if (fail === "empty") return "";
      const list = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
      if (garble > 0) { garble -= 1; return "Sure! Here you go: [\"only one\"]"; }
      return `Here is the translation:\n${JSON.stringify(list.map((s) => s.toUpperCase()))}`;
    },
  };
}

function page(texts) {
  const dom = texts.slice();
  return { dom, apply: (start, out) => { let n = 0; out.forEach((t, i) => { if (t) { dom[start + i] = t; n += 1; } }); return n; } };
}

test("the pipeline: batches go to the model and come back onto the page in order", async () => {
  const texts = Array.from({ length: 95 }, (_, i) => `satz nummer ${i}`);
  const p = page(texts);
  const model = fakeModel();
  const progress = [];
  const r = await T.createTranslator({ backends: [model], batch: { maxItems: 40, maxChars: 5000 } })
    .translate({ texts, target: "English", apply: p.apply, onProgress: (x) => progress.push(x) });
  assert.equal(r.ok, true);
  assert.equal(r.changed, 95);
  assert.equal(r.batches, 3);
  assert.equal(model.calls.length, 3);
  assert.match(model.calls[0], /into English/);
  assert.deepEqual(p.dom, texts.map((t) => t.toUpperCase()));
  assert.deepEqual(r.backend, { id: "fake", label: "fake" });
  assert.deepEqual(progress.map((x) => x.done), [0, 1, 2]);
  assert.equal(progress[0].backend, null, "nobody has answered yet");
  assert.equal(progress[1].backend, "fake");
});

test("a dead backend is dropped once; the next takes the same batch and the rest of the page", async () => {
  const texts = Array.from({ length: 50 }, (_, i) => `texto ${i}`);
  const p = page(texts);
  const refused = fakeModel({ label: "MicroScheduler", fail: "throw" });
  const silent = fakeModel({ label: "the local node", fail: "empty" });
  const slow = fakeModel({ label: "slow", delayMs: 400 });
  const good = fakeModel({ label: "Local AI (bonsai-local)" });
  const r = await T.createTranslator({ backends: [refused, silent, slow, good], batch: { maxItems: 25, maxChars: 5000 } })
    .translate({ texts, target: "English", apply: p.apply });
  assert.equal(r.ok, true);
  assert.equal(r.changed, 50);
  assert.equal(refused.calls.length, 1, "asked once, never again");
  assert.equal(silent.calls.length, 1);
  assert.equal(slow.calls.length, 1);
  assert.equal(good.calls.length, 2);
  assert.equal(r.backend.label, "Local AI (bonsai-local)");
  assert.deepEqual(r.tried.map((t) => [t.label, t.ok]), [["MicroScheduler", false], ["the local node", false], ["slow", false], ["Local AI (bonsai-local)", true]]);
  assert.match(T.describeTried(r.tried), /MicroScheduler: connection refused; the local node: no text came back; slow: no answer in 0 s/);
});

test("a garbled answer is asked again in halves before the batch is given up", async () => {
  const texts = ["eins", "zwei", "drei", "vier"];
  const p = page(texts);
  const model = fakeModel({ garbleFirst: 1 });
  const r = await T.createTranslator({ backends: [model] }).translate({ texts, target: "English", apply: p.apply });
  assert.equal(r.ok, true);
  assert.deepEqual(p.dom, ["EINS", "ZWEI", "DREI", "VIER"]);
  assert.equal(model.calls.length, 3, "the batch, then its two halves");
});

test("no backend, or none that answers, reports who was tried and changes nothing", async () => {
  const p = page(["hallo welt"]);
  const none = await T.createTranslator({ backends: [] }).translate({ texts: p.dom, target: "English", apply: p.apply });
  assert.deepEqual([none.ok, none.changed, none.backend, none.tried], [false, 0, null, []]);
  const dead = await T.createTranslator({ backends: [fakeModel({ label: "a", fail: "throw" }), fakeModel({ label: "b", fail: "empty" })] })
    .translate({ texts: p.dom, target: "English", apply: p.apply });
  assert.equal(dead.ok, false);
  assert.deepEqual(p.dom, ["hallo welt"]);
  assert.equal(dead.tried.length, 2);
});

test("leaving the page stops the work", async () => {
  const texts = Array.from({ length: 90 }, (_, i) => `satz ${i}`);
  const p = page(texts);
  const model = fakeModel();
  let wanted = true;
  const r = await T.createTranslator({ backends: [model], batch: { maxItems: 30, maxChars: 5000 } }).translate({
    texts, target: "English", apply: (s, o) => { wanted = false; return p.apply(s, o); }, stillWanted: () => wanted,
  });
  assert.equal(model.calls.length, 1);
  assert.equal(r.changed, 30);
});

test("only a local, available lane is picked: Bonsai first, never a hosted API or an embedder", () => {
  const m = (id, owned_by, available, busy = false) => ({ id, owned_by, aither: { available, busy } });
  const models = [m("aither-orchestrator", "vllm", false), m("deepseek-pool", "llamacpp_pool", true),
    m("aither-code-embed-0.6b", "llamacpp_local", true), m("bonsai2-27b-5090", "llamacpp_local", true),
    m("deepseek-chat", "deepseek_api", true), m("or-claude-sonnet", "openrouter_api", true)];
  assert.equal(T.pickTranslateModel(models), "bonsai2-27b-5090");
  assert.equal(T.pickTranslateModel(models, "deepseek-pool"), "deepseek-pool", "the owner's choice, when it is up and local");
  assert.equal(T.pickTranslateModel(models, "deepseek-chat"), "bonsai2-27b-5090", "a hosted lane is never honoured");
  assert.equal(T.pickTranslateModel([m("deepseek-chat", "deepseek_api", true), m("x", "vllm", false)]), null);
  assert.equal(T.pickTranslateModel([m("bonsai2-a", "llamacpp_local", true, true), m("pool", "llamacpp_pool", true)]), "pool", "idle before busy");
  assert.equal(T.pickTranslateModel([{ id: "bonsai-local" }]), null, "a list without health is not trusted");
  assert.equal(T.pickTranslateModel(null), null);
});

test("the MicroScheduler backend picks a model once, asks at user priority, and says which model", async () => {
  const seen = [];
  const http = {
    getJson: async (url) => { seen.push(["GET", url]); return { status: 200, json: { data: [{ id: "bonsai2-27b-5090", owned_by: "llamacpp_local", aither: { available: true } }] } }; },
    postJson: async (url, body) => { seen.push(["POST", url, body]); return { status: 200, json: { choices: [{ message: { content: "[\"Good morning\"]" } }] } }; },
  };
  const b = T.schedulerBackend({ base: "https://127.0.0.1:8150", http });
  assert.equal(await b.ask("p1"), "[\"Good morning\"]");
  assert.equal(await b.ask("p2"), "[\"Good morning\"]");
  assert.equal(seen.filter((s) => s[0] === "GET").length, 1);
  assert.equal(seen[1][1], "https://127.0.0.1:8150/v1/chat/completions");
  assert.equal(seen[1][2].model, "bonsai2-27b-5090");
  assert.equal(seen[1][2].priority, "user");
  assert.equal(b.label, "MicroScheduler (bonsai2-27b-5090)");
  const down = T.schedulerBackend({ base: "https://127.0.0.1:8150", http: { getJson: async () => { throw new Error("ECONNREFUSED"); } } });
  await assert.rejects(down.ask("p"), /ECONNREFUSED/);
  const none = T.schedulerBackend({ base: "x", http: { getJson: async () => ({ status: 200, json: { data: [] } }) } });
  await assert.rejects(none.ask("p"), /no local model lane is up/);
});

test("the local node, bonsai-local and desk agent backends speak their own transports", async () => {
  const calls = [];
  const answer = async (msg) => {
    calls.push(msg);
    if (msg.method === "GET") return { ok: true, data: { data: [{ id: "bonsai2-fast", owned_by: "llamacpp_local", aither: { available: true } }] } };
    return { ok: true, data: { choices: [{ message: { content: "[\"hi\"]" } }] } };
  };
  const node = T.nodeBackend({ answer });
  assert.equal(await node.ask("p"), "[\"hi\"]");
  assert.deepEqual([calls[0].type, calls[0].path, calls[1].path, calls[1].body.model], ["daemon-call", "/v1/models", "/v1/chat/completions", "bonsai2-fast"]);
  assert.equal(node.label, "the local node (bonsai2-fast)");
  await assert.rejects(T.nodeBackend({ answer: async () => ({ ok: false, error: "no local node answered" }) }).ask("p"), /no local node answered/);

  assert.equal(await T.bonsaiLocalBackend({ chat: async (m) => ({ ok: true, text: `got ${m[0].content}` }) }).ask("p"), "got p");
  await assert.rejects(T.bonsaiLocalBackend({ chat: async () => ({ ok: false, error: "The local AI is not running." }) }).ask("p"), /not running/);
  assert.equal(await T.agentBackend({ askAgent: async () => ({ ok: true, reply: "[\"x\"]" }) }).ask("p"), "[\"x\"]");
  await assert.rejects(T.agentBackend({ askAgent: async () => ({ ok: false, reply: "offline" }) }).ask("p"), /offline/);
});
