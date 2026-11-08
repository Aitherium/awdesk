"use strict";

// pin-item.cjs: the one card model (canvas boards, desktop pins, AitherOne scenes).

const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("./pin-item.cjs");

const fromUrl = (url) => P.pinItemFromUrl(url, { id: "p1" });

test("pinItemFromUrl: YouTube watch / shorts / live / youtu.be / embed -> the privacy embed", () => {
  for (const url of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42", "https://youtube.com/shorts/dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ?si=abc",
    "https://www.youtube.com/live/dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ"]) {
    const pin = fromUrl(url);
    assert.equal(pin.kind, "youtube", url);
    assert.equal(pin.src, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", url);
  }
  assert.equal(fromUrl("https://www.youtube.com/channel/UCabc").kind, "url", "a channel page is not a video");
});

test("pinItemFromUrl: .gif, Tenor and Giphy -> gif", () => {
  assert.equal(fromUrl("https://example.com/cat.gif").kind, "gif");
  assert.equal(fromUrl("https://media.tenor.com/abc/tenor.mp4").kind, "gif");
  assert.equal(fromUrl("https://media1.giphy.com/media/xyz/giphy.webp").kind, "gif");
  assert.equal(fromUrl("https://tenor.com/view/happy-123").kind, "gif");
});

test("pinItemFromUrl: image extensions and data:image -> image", () => {
  for (const url of ["https://x.test/a.png", "https://x.test/a.JPG", "https://x.test/a.jpeg?w=2", "https://x.test/a.webp",
    "https://x.test/a.svg", "data:image/png;base64,iVBORw0KGgo="]) {
    assert.equal(fromUrl(url).kind, "image", url);
  }
});

test("pinItemFromUrl: aither:// -> app (never the canvas itself); http(s) -> url; the rest refused", () => {
  assert.equal(fromUrl("aither://fleet/").kind, "app");
  assert.equal(fromUrl("aither://canvas/"), null, "a canvas never holds itself");
  assert.equal(fromUrl("https://example.com/page").kind, "url");
  for (const bad of ["file:///C:/x", "javascript:alert(1)", "data:text/html,x", "not a url", ""]) {
    assert.equal(fromUrl(bad), null, bad);
  }
});

test("normalizePinItem: exact shape, defaults, clamps; junk refused", () => {
  const pin = P.normalizePinItem({ id: "a", kind: "url", src: "https://x.test", title: "X", bounds: { x: 1.4, y: 2, width: 1, height: 99999 },
    locked: "yes", opacity: 7, z: 3 });
  assert.deepEqual(pin, { id: "a", kind: "url", src: "https://x.test", title: "X",
    bounds: { x: 1, y: 2, width: P.LIMITS.minW, height: P.LIMITS.maxH }, locked: false, opacity: 1, z: 3 });
  assert.equal(P.normalizePinItem({ id: "a", kind: "widget", src: "" }), null, "a widget names one");
  assert.equal(P.normalizePinItem({ id: "a", kind: "widget", widget: "clock" }).widget, "clock");
  assert.equal(P.normalizePinItem({ id: "a", kind: "note", src: "hello\u0000" }).src, "hello ");
  assert.equal(P.normalizePinItem({ id: "a", kind: "youtube", src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }), null,
    "a youtube pin holds the embed, not the watch page");
  assert.equal(P.normalizePinItem({ id: "bad id!", kind: "url", src: "https://x.test" }), null);
  assert.equal(P.normalizePinItem({ id: "a", kind: "pdf", src: "https://x.test" }), null);
});

/* A scene as Veil writes it (types.ts SceneItem; one of each kind a pin maps). */
const SCENE_ITEMS = [
  { id: "link_1", kind: "link", x: 10, y: 20, w: 300, h: 96, z: 1, url: "https://example.com/", title: "Example", favicon: "https://example.com/f.ico" },
  { id: "embed_1", kind: "embed", x: 0, y: 0, w: 480, h: 300, z: 2, url: "https://youtu.be/dQw4w9WgXcQ",
    embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", provider: "youtube", title: "Song" },
  { id: "embed_2", kind: "embed", x: 5, y: 5, w: 480, h: 300, z: 3, url: "https://vimeo.com/123456",
    embedUrl: "https://player.vimeo.com/video/123456", provider: "vimeo" },
  { id: "image_1", kind: "image", x: 1, y: 2, w: 320, h: 240, z: 4, src: "https://x.test/cat.gif", alt: "cat" },
  { id: "image_2", kind: "image", x: 1, y: 2, w: 320, h: 240, z: 5, src: "https://x.test/dog.png" },
  { id: "sticky_1", kind: "sticky", x: 3, y: 4, w: 200, h: 160, z: 6, text: "buy milk", fill: "#fde68a" },
  { id: "text_1", kind: "text", x: 3, y: 4, w: 240, h: 60, z: 7, text: "Heading", fontSize: 24, color: "#fff" },
  // The kinds veil-canvas-forge adds (SYNC.md): native app / gif / widget, a web embed,
  // and the native locked / opacity / rev fields.
  { id: "app_1", kind: "app", x: 0, y: 0, w: 480, h: 320, z: 8, src: "aither://fleet/", title: "Fleet", rev: 3 },
  { id: "gif_1", kind: "gif", x: 0, y: 0, w: 320, h: 240, z: 9, src: "https://media.tenor.com/x/tenor.gif", locked: true },
  { id: "widget_1", kind: "widget", x: 0, y: 0, w: 224, h: 128, z: 10, widget: "inbox", config: { compact: true }, opacity: 0.6 },
  { id: "web_1", kind: "embed", x: 0, y: 0, w: 480, h: 320, z: 11, provider: "web", url: "https://example.com/", embedUrl: "https://example.com/" },
];

test("AitherOne -> desk -> AitherOne is lossless for every scene item a pin can hold", () => {
  for (const item of SCENE_ITEMS) {
    const pin = P.fromSceneItem(item);
    assert.ok(pin, item.id);
    assert.deepEqual(P.toSceneItem(pin), item, item.id);
  }
  assert.deepEqual(SCENE_ITEMS.map((i) => P.fromSceneItem(i).kind),
    ["url", "youtube", "url", "gif", "image", "note", "note", "app", "gif", "widget", "url"]);
  assert.equal(P.fromSceneItem(SCENE_ITEMS[8]).locked, true, "native locked");
  assert.equal(P.fromSceneItem(SCENE_ITEMS[9]).opacity, 0.6, "native opacity");
});

test("desk -> AitherOne -> desk is lossless for every pin kind, in the agreed SceneItem kinds", () => {
  const pins = [
    { id: "a1", kind: "app", src: "aither://fleet/", title: "Fleet", bounds: { x: 0, y: 0, width: 480, height: 320 }, locked: true, opacity: 0.8, z: 1 },
    { id: "u1", kind: "url", src: "https://example.com/", title: "", bounds: { x: 5, y: 6, width: 400, height: 300 }, locked: false, opacity: 1, z: 2 },
    P.pinItemFromUrl("https://youtu.be/dQw4w9WgXcQ", { id: "y1", title: "Song" }),
    P.pinItemFromUrl("https://media.tenor.com/x/tenor.gif", { id: "g1" }),
    P.pinItemFromUrl("https://x.test/a.png", { id: "i1", title: "A" }),
    { id: "w1", kind: "widget", src: "", widget: "inbox", title: "Inbox", bounds: { x: 0, y: 0, width: 224, height: 128 }, locked: false, opacity: 0.5, z: 9 },
    { id: "n1", kind: "note", src: "line one\nline two", title: "", bounds: { x: 0, y: 0, width: 220, height: 180 }, locked: false, opacity: 1, z: 0 },
  ].map(P.normalizePinItem);
  for (const pin of pins) {
    const scene = P.toSceneItem(pin);
    const want = { app: "app", url: "embed", youtube: "embed", gif: "gif", image: "image", widget: "widget", note: "sticky" };
    assert.equal(scene.kind, want[pin.kind], pin.kind);
    if (pin.kind === "url") assert.equal(scene.provider, "web");
    if (pin.kind === "widget") assert.equal(scene.widget, pin.widget);
    assert.deepEqual([scene.w, scene.h], [pin.bounds.width, pin.bounds.height]);
    assert.equal(scene.locked === true, pin.locked);
    assert.equal(scene.aw.kind, pin.kind);
    assert.deepEqual(P.fromSceneItem(JSON.parse(JSON.stringify(scene))), { ...pin, extra: { scene: JSON.parse(JSON.stringify(scene)) } }, pin.id);
    // ...and from there back to AitherOne is a fixed point.
    assert.deepEqual(P.toSceneItem(P.fromSceneItem(scene)), scene, pin.id);
  }
});

test("an edited pin goes back with its edit, and keeps the AitherOne fields it did not touch", () => {
  const pin = P.fromSceneItem(SCENE_ITEMS[0]);
  pin.bounds.x = 500;
  pin.locked = true;
  const back = P.toSceneItem(pin);
  assert.equal(back.x, 500);
  assert.equal(back.favicon, "https://example.com/f.ico");
  assert.equal(back.locked, true, "locked is a native SceneItem field");
  assert.equal(back.kind, "link", "a Veil link card stays a link");
});

test("scene items that are not pins are left to the caller", () => {
  assert.equal(P.fromSceneItem({ id: "s", kind: "shape", shape: "rect", x: 0, y: 0, w: 1, h: 1, z: 0 }), null);
  assert.equal(P.fromSceneItem({ id: "f", kind: "file", node: "/a.pdf", x: 0, y: 0, w: 1, h: 1, z: 0 }), null);
  assert.equal(P.fromSceneItem(null), null);
});

test("ForgeIDE pins as an app: exact origin, /ide /graph /login only, never '..' (SYNC.md, shared with desk-pins-ink)", () => {
  for (const url of ["https://forge.aitherium.com/ide", "https://forge.aitherium.com/ide/proj?file=a.py",
    "https://forge.aitherium.com/graph", "https://forge.aitherium.com/login"]) {
    assert.equal(P.kindOfUrl(url), "app", url);
    assert.equal(P.normalizePinItem({ id: "f", kind: "app", src: url }).src, url);
  }
  for (const url of ["https://forge.aitherium.com/admin", "https://forge.aitherium.com/ide/../admin",
    "http://forge.aitherium.com/ide", "https://forge.aitherium.com.evil.test/ide", "https://evil.test/ide"]) {
    assert.equal(P.isForgeIde(url), false, url);
    assert.equal(P.normalizePinItem({ id: "f", kind: "app", src: url }), null, `${url} is not an app pin`);
  }
  // A dev ForgeIDE: an https or localhost override, never a plain-http remote host.
  assert.equal(P.isForgeIde("http://localhost:3100/ide", { AWDESK_FORGEIDE_URL: "http://localhost:3100" }), true);
  assert.equal(P.isForgeIde("https://forge.aitherium.com/ide", { AWDESK_FORGEIDE_URL: "http://localhost:3100" }), false);
  assert.equal(P.isForgeIde("http://dev.test/ide", { AWDESK_FORGEIDE_URL: "http://dev.test" }), false,
    "a plain-http remote override is ignored (falls back to the real ForgeIDE)");
});
