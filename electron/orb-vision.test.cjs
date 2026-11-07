"use strict";

// orb-vision.cjs under node --test: the two-door ladder. Every transport is
// injected, so these assert the RULES (gateway first, direct as the honest
// second opinion, both failures reported) without touching the fleet.
//
// Live behaviour measured on the owner's box is in the module header; the test
// that needs the real service is a probe, not this file.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vision = require("./orb-vision.cjs");

function tmpPng(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orb-vision-${tag}-`));
  const file = path.join(dir, "capture.png");
  // A 1x1 PNG is enough: the transports are fakes here.
  fs.writeFileSync(file, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  ));
  return file;
}

function okPost(payload) {
  return async () => ({ status: 200, body: JSON.stringify(payload) });
}

// ── the direct door ─────────────────────────────────────────────────────────

test("a 200 analysis is the answer, with the model that produced it", async () => {
  const file = tmpPng("ok");
  const r = await vision.askDirect(file, "what is this?", {
    post: okPost({ success: true, analysis: "A red circle.", provider: "vllm", model: "bonsai2-27b", duration_ms: 5721 }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.text, "A red circle.");
  assert.equal(r.model, "bonsai2-27b");
  assert.equal(r.durationMs, 5721);
});

test("a 503 detail is a loud error, not an empty answer", async () => {
  const file = tmpPng("503");
  const r = await vision.askDirect(file, "what is this?", {
    post: async () => ({ status: 503, body: JSON.stringify({ detail: "vision lane unavailable: model returned no analysis" }) }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /vision lane unavailable/);
});

test("a non-JSON body names what came back instead of pretending", async () => {
  const file = tmpPng("html");
  const r = await vision.askDirect(file, "what is this?", {
    post: async () => ({ status: 200, body: "<html>gateway timed out</html>" }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /non-JSON/);
  assert.match(r.error, /gateway timed out/);
});

test("an empty analysis is a failure, like the service's own rule", async () => {
  const file = tmpPng("empty");
  const r = await vision.askDirect(file, "what is this?", {
    post: okPost({ success: true, analysis: "   ", provider: "vllm" }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /no analysis/);
});

test("a transport throw (timeout, refused socket) becomes a verdict", async () => {
  const file = tmpPng("throw");
  const r = await vision.askDirect(file, "what is this?", {
    post: async () => { throw new Error("vision request timed out after 90 s"); },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
});

test("a missing capture is reported before a request is made", async () => {
  let called = false;
  const r = await vision.askDirect(path.join(os.tmpdir(), "orb-does-not-exist.png"), "q", {
    post: async () => { called = true; return { status: 200, body: "{}" }; },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot read the capture/);
  assert.equal(called, false);
});

test("the uploaded body carries analysis_type=question and the prompt verbatim", () => {
  const data = Buffer.from("PNGDATA");
  const { body, contentType } = vision.multipartBody(
    { analysis_type: "question", custom_prompt: 'What is "this"?' },
    { name: "shot.png", type: "image/png", data },
  );
  assert.match(contentType, /^multipart\/form-data; boundary=/);
  const text = body.toString("latin1");
  assert.match(text, /name="analysis_type"\r\n\r\nquestion/);
  assert.match(text, /name="custom_prompt"\r\n\r\nWhat is "this"\?/);
  assert.match(text, /name="file"; filename="shot.png"\r\nContent-Type: image\/png/);
  assert.match(text, /PNGDATA/);
});

test("mimeFor follows the capture extension", () => {
  assert.equal(vision.mimeFor("a.png"), "image/png");
  assert.equal(vision.mimeFor("a.JPG"), "image/jpeg");
  assert.equal(vision.mimeFor("a.webp"), "image/webp");
  assert.equal(vision.mimeFor("noext"), "image/png");
});

// ── the ladder ──────────────────────────────────────────────────────────────

test("the gateway answers first, and the direct door is never dialled", async () => {
  const file = tmpPng("ladder-ok");
  let directCalled = false;
  const r = await vision.askVision(file, "what is on my screen?", {
    skipScheduler: true,
    stage: false,
    ask: async () => ({ analysis: "You have a code editor open.", provider: "bonsai2-27b" }),
    post: async () => { directCalled = true; return { status: 200, body: "{}" }; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.via, "gateway");
  assert.equal(r.text, "You have a code editor open.");
  assert.equal(directCalled, false);
  assert.deepEqual(r.attempts, [{ via: "gateway", ok: true, error: null }]);
});

test("a gateway failure falls through to the direct service", async () => {
  const file = tmpPng("fallback");
  const r = await vision.askVision(file, "what is this?", {
    skipScheduler: true,
    stage: false,
    ask: async () => ({ note: "Error: Vision upload-analyze: Server disconnected without sending a response." }),
    post: okPost({ success: true, analysis: "A red circle.", provider: "vllm", model: "bonsai2-27b" }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.via, "direct");
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].ok, false);
  assert.match(r.attempts[0].error, /Server disconnected/);
});

test("both doors failing yields the loud card, keyed off the direct error", async () => {
  const file = tmpPng("both");
  const r = await vision.askVision(file, "what is this?", {
    skipScheduler: true,
    stage: false,
    ask: async () => ({ note: "Error: Vision upload-analyze: Server disconnected without sending a response." }),
    post: async () => ({ status: 503, body: JSON.stringify({ detail: "vision lane unavailable: model returned no analysis" }) }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no-provider");
  assert.ok(r.title);
  assert.match(r.remedy, /8084\/status/);
  assert.match(r.text, /vision lane unavailable/);
  assert.equal(r.attempts.length, 2);
});

test("skipGateway goes straight to the direct door", async () => {
  const file = tmpPng("skip");
  let asked = false;
  const r = await vision.askVision(file, "q", {
    skipScheduler: true,
    skipGateway: true,
    ask: async () => { asked = true; return { analysis: "nope" }; },
    post: okPost({ success: true, analysis: "Direct answer." }),
  });
  assert.equal(asked, false);
  assert.equal(r.ok, true);
  assert.deepEqual(r.attempts.map((a) => a.via), ["direct"]);
});

test("AWDESK_ORB_SKIP_GATEWAY=1 disables the first door", async () => {
  const file = tmpPng("env");
  const prev = process.env.AWDESK_ORB_SKIP_GATEWAY;
  process.env.AWDESK_ORB_SKIP_GATEWAY = "1";
  try {
    let asked = false;
    const r = await vision.askVision(file, "q", {
    skipScheduler: true,
      ask: async () => { asked = true; return { analysis: "nope" }; },
      post: okPost({ success: true, analysis: "Direct." }),
    });
    assert.equal(asked, false);
    assert.equal(r.via, "direct");
  } finally {
    if (prev === undefined) delete process.env.AWDESK_ORB_SKIP_GATEWAY;
    else process.env.AWDESK_ORB_SKIP_GATEWAY = prev;
  }
});

test("the base URL honours the override and drops trailing slashes", () => {
  const prev = process.env.AWDESK_ORB_VISION_URL;
  process.env.AWDESK_ORB_VISION_URL = "https://127.0.0.1:9999/";
  try {
    assert.equal(vision.baseUrl(), "https://127.0.0.1:9999");
  } finally {
    if (prev === undefined) delete process.env.AWDESK_ORB_VISION_URL;
    else process.env.AWDESK_ORB_VISION_URL = prev;
  }
  assert.equal(vision.baseUrl(), "https://127.0.0.1:8084");
});

test("door 0: MicroScheduler Bonsai at user priority answers first", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbvis-"));
  const file = path.join(dir, "s.png");
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const sent = [];
  const r = await vision.askVision(file, "what is on my screen?", {
    skipGateway: true,
    postJson: async (url, payload) => {
      sent.push({ url, payload });
      return { status: 200, body: JSON.stringify({ model: "bonsai2-27b-5090", choices: [{ message: { content: "A code editor." } }] }) };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.via, "scheduler");
  assert.equal(r.text, "A code editor.");
  assert.match(sent[0].url, /\/v1\/chat\/completions$/);
  assert.equal(sent[0].payload.priority, "user", "a desk ask must not queue behind background work");
  assert.deepEqual(sent.map((x) => x.payload.model).sort(), ["bonsai-27b-dgx", "bonsai2-27b-5090"], "both Bonsai lanes are raced");
  assert.match(sent[0].payload.messages[0].content[1].image_url.url, /^data:image\//);
});

test("door 0 failing falls through to the other doors, and says why", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbvis-"));
  const file = path.join(dir, "s.png");
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const m = await vision.askViaScheduler(file, "q", { postJson: async () => ({ status: 502, body: "" }) });
  assert.equal(m.ok, false);
  assert.match(m.error, /502/);
});

test("the first Bonsai lane to answer wins the race", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbvis-"));
  const file = path.join(dir, "s.png");
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const r = await vision.askViaScheduler(file, "q", {
    postJson: async (_url, payload) => {
      if (payload.model === "bonsai2-27b-5090") { await new Promise((res) => setTimeout(res, 200)); return { status: 502, body: "" }; }
      return { status: 200, body: JSON.stringify({ model: payload.model, choices: [{ message: { content: "dgx answer" } }] }) };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.text, "dgx answer");
});
