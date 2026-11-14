"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const e = require("./browser-everyday.cjs");

const key = (k, mods = {}) => ({ type: "keyDown", key: k, ...mods });

test("the standard Edge keys map to browser actions", () => {
  const cases = [
    [key("t", { control: true }), "new-tab"], [key("w", { control: true }), "close-tab"],
    [key("L", { control: true }), "focus-address"], [key("f", { control: true }), "find"],
    [key("p", { control: true }), "print"], [key("d", { control: true }), "bookmark"],
    [key("=", { control: true }), "zoom-in"], [key("+", { control: true, shift: true }), "zoom-in"],
    [key("-", { control: true }), "zoom-out"], [key("0", { control: true }), "zoom-reset"],
    [key("N", { control: true, shift: true }), "inprivate"], [key("T", { control: true, shift: true }), "reopen-closed"],
    [key("Tab", { control: true }), "next-tab"], [key("Tab", { control: true, shift: true }), "prev-tab"],
    [key("F5"), "reload"], [key("F3"), "find-next"], [key("F3", { shift: true }), "find-prev"],
    [key("ArrowLeft", { alt: true }), "back"], [key("ArrowRight", { alt: true }), "forward"],
  ];
  for (const [input, action] of cases) assert.equal((e.keyAction(input) || {}).action, action, JSON.stringify(input));
  assert.deepEqual(e.keyAction(key("3", { control: true })), { action: "tab-index", arg: 3 });
});

test("plain typing, key-up and the desk's own keys are not browser actions", () => {
  for (const input of [key("t"), key("f", { alt: true }), { type: "keyUp", key: "t", control: true },
    key("k", { control: true }), key("o", { alt: true }), key("`", { control: true }), null]) {
    assert.equal(e.keyAction(input), null, JSON.stringify(input));
  }
});

test("zoom walks Chromium's ladder and stops at its ends", () => {
  assert.equal(e.nextZoom(1, 1), 1.1);
  assert.equal(e.nextZoom(1, -1), 0.9);
  assert.equal(e.nextZoom(1.05, 1), 1.1);
  assert.equal(e.nextZoom(5, 1), 5);
  assert.equal(e.nextZoom(0.25, -1), 0.25);
  assert.equal(e.nextZoom(2, 0), 1);
});

test("the InPrivate partition is never persisted", () => {
  assert.ok(!e.INPRIVATE_PARTITION.startsWith("persist:"));
});

test("session restore keeps only the owner's web tabs and survives a restart", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-sess-")), "session.json");
  const store = e.createSessionStore({ file });
  const tabsNow = [
    { by: "you", kind: "web", url: "https://a.test/", title: "A", active: true },
    { by: "agent", kind: "web", url: "https://agent.test/" },
    { by: "you", kind: "web", url: "https://secret.test/", private: true },
    { by: "you", kind: "internal", url: "aither://settings/" },
    { by: "you", kind: "web", url: "https://b.test/x", title: "B" },
  ];
  assert.equal(store.flush(tabsNow), true);
  const again = e.createSessionStore({ file }).load();
  assert.deepEqual(again.map((t) => t.url), ["https://a.test/", "https://b.test/x"]);
  assert.equal(again[0].active, true);
  assert.ok(!fs.readFileSync(file, "utf8").includes("secret.test"));
});

test("a missing or broken session file restores nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-sess-"));
  assert.deepEqual(e.createSessionStore({ file: path.join(dir, "none.json") }).load(), []);
  fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
  assert.deepEqual(e.createSessionStore({ file: path.join(dir, "bad.json") }).load(), []);
});

test("recently closed keeps owner web tabs only, newest first", () => {
  const closed = e.createClosedTabs(2);
  assert.equal(closed.push({ by: "agent", url: "https://x.test/" }), false);
  assert.equal(closed.push({ by: "you", url: "https://p.test/", private: true }), false);
  closed.push({ by: "you", url: "https://1.test/" });
  closed.push({ by: "you", url: "https://2.test/" });
  closed.push({ by: "you", url: "https://3.test/" });
  assert.equal(closed.pop().url, "https://3.test/");
  assert.equal(closed.pop().url, "https://2.test/");
  assert.equal(closed.pop(), null);
});

test("DRM sites are recognised by host and by path", () => {
  for (const url of ["https://www.netflix.com/browse", "https://open.spotify.com/track/1", "https://www.amazon.com/gp/video/detail/x",
    "https://apps.disneyplus.com/"]) assert.equal(e.needsDrm(url), true, url);
  for (const url of ["https://www.amazon.com/dp/123", "https://notnetflix.com/", "https://youtube.com/watch?v=1", "aither://x", "nonsense"]) {
    assert.equal(e.needsDrm(url), false, url);
  }
});

test("Edge is found in Program Files, or reported missing", () => {
  const env = { "ProgramFiles(x86)": "C:\\PF86", ProgramFiles: "C:\\PF" };
  const want = path.join("C:\\PF86", "Microsoft", "Edge", "Application", "msedge.exe");
  assert.equal(e.edgeExecutable({ env, exists: (p) => p === want }), want);
  assert.equal(e.edgeExecutable({ env, exists: () => false }), null);
});

test("translation batches keep order and respect both caps", () => {
  const texts = Array.from({ length: 130 }, (_, i) => `text ${i}`);
  const batches = e.translateBatches(texts, { maxItems: 60, maxChars: 100000 });
  assert.deepEqual(batches.map((b) => [b.start, b.texts.length]), [[0, 60], [60, 60], [120, 10]]);
  const big = e.translateBatches(["a".repeat(3000), "b".repeat(3000)], { maxChars: 3500 });
  assert.equal(big.length, 2);
});

test("a translation reply is accepted only as an array of the same length", () => {
  assert.deepEqual(e.parseTranslation('Sure:\n["Hello", "World"]', 2), ["Hello", "World"]);
  assert.equal(e.parseTranslation('["Hello"]', 2), null);
  assert.equal(e.parseTranslation("no json here", 1), null);
  assert.match(e.translatePrompt(["Hallo"], "English"), /\["Hallo"\]/);
});

test("the page scripts parse and escape what they carry", () => {
  assert.doesNotThrow(() => new Function(e.TRANSLATE_COLLECT_SCRIPT));
  const apply = e.translateApplyScript(4, ["a\"b", "</script>\\"]);
  assert.doesNotThrow(() => new Function(apply));
  assert.ok(apply.includes(JSON.stringify(["a\"b", "</script>\\"])));
});

test("right-click: a link, an image, a typo, a selection and the bare page each get their menu", () => {
  const ids = (spec) => spec.filter((i) => i.id).map((i) => i.id);
  const link = e.contextMenuSpec({ linkURL: "https://a.test/x" });
  assert.deepEqual(ids(link).slice(0, 3), ["link-new-tab", "link-inprivate", "copy-text"]);
  assert.ok(!ids(e.contextMenuSpec({ linkURL: "https://a.test/x" }, { private: true })).includes("link-inprivate"));
  assert.ok(!ids(e.contextMenuSpec({ linkURL: "javascript:alert(1)" })).includes("link-new-tab"));
  const img = e.contextMenuSpec({ mediaType: "image", srcURL: "https://a.test/i.png" });
  assert.ok(ids(img).includes("image-save") && ids(img).includes("image-copy"));
  const typo = e.contextMenuSpec({ isEditable: true, misspelledWord: "teh", dictionarySuggestions: ["the", "tea"], editFlags: { canPaste: true } });
  assert.deepEqual(typo.slice(0, 3).map((i) => i.arg), ["the", "tea", "teh"]);
  assert.ok(ids(typo).includes("paste"));
  const sel = e.contextMenuSpec({ selectionText: "hello world" });
  assert.equal(sel.find((i) => i.id === "search").arg, "hello world");
  const bare = e.contextMenuSpec({}, { canGoBack: true });
  assert.equal(bare.find((i) => i.id === "back").enabled, true);
  assert.equal(bare.find((i) => i.id === "forward").enabled, false);
  assert.ok(ids(bare).includes("print") && ids(bare).includes("translate"));
  for (const spec of [link, img, typo, sel, bare]) {
    assert.notEqual(spec[0].type, "separator");
    spec.forEach((x, i) => assert.ok(!(x.type === "separator" && spec[i + 1] && spec[i + 1].type === "separator")));
  }
});
