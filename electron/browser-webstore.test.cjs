"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const ws = require("./browser-webstore.cjs");

const ID = "ddkjiahejlhfcafbddmgiahcphecmpfh";

/** Build a ZIP by hand: local headers, central directory, end record. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data = Buffer.alloc(0), store = false } of entries) {
    const raw = Buffer.from(data);
    const comp = store ? raw : zlib.deflateRawSync(raw);
    const method = store ? 0 : 8;
    const crc = zlib.crc32(raw) >>> 0;
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function crx3(zip) {
  const header = Buffer.from("fake-protobuf-header");
  const pre = Buffer.alloc(12);
  pre.write("Cr24", 0, "latin1");
  pre.writeUInt32LE(3, 4);
  pre.writeUInt32LE(header.length, 8);
  return Buffer.concat([pre, header, zip]);
}

function crx2(zip) {
  const pre = Buffer.alloc(16);
  pre.write("Cr24", 0, "latin1");
  pre.writeUInt32LE(2, 4);
  pre.writeUInt32LE(5, 8);
  pre.writeUInt32LE(3, 12);
  return Buffer.concat([pre, Buffer.alloc(8), zip]);
}

function extZip(version, extra = {}) {
  const manifest = {
    manifest_version: 3,
    name: "__MSG_extName__",
    default_locale: "en",
    version,
    permissions: ["storage", "declarativeNetRequest", "sidePanel"],
    ...extra,
  };
  return makeZip([
    { name: "manifest.json", data: JSON.stringify(manifest) },
    { name: "_locales/en/messages.json", data: JSON.stringify({ extName: { message: "Test Ext" } }) },
    { name: "js/", store: true },
    { name: "js/bg.js", data: "console.log('hi');".repeat(50) },
    { name: "icon.txt", data: "stored", store: true },
    { name: "_metadata/verified_contents.json", data: "[]" },
  ]);
}

function fakeFetch(body, calls = []) {
  return async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(body.length) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    };
  };
}

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "aw-webstore-test-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test("parseExtensionId accepts a raw id and every store URL shape", () => {
  assert.deepEqual(ws.parseExtensionId(ID), { ok: true, id: ID, store: "chrome" });
  assert.deepEqual(ws.parseExtensionId(`  ${ID}\n`), { ok: true, id: ID, store: "chrome" });
  assert.deepEqual(
    ws.parseExtensionId(`https://chromewebstore.google.com/detail/ublock-origin-lite/${ID}?hl=en`),
    { ok: true, id: ID, store: "chrome" },
  );
  assert.deepEqual(ws.parseExtensionId(`chromewebstore.google.com/detail/${ID}`), { ok: true, id: ID, store: "chrome" });
  assert.deepEqual(
    ws.parseExtensionId(`https://chrome.google.com/webstore/detail/ublock-origin-lite/${ID}`),
    { ok: true, id: ID, store: "chrome" },
  );
  assert.deepEqual(
    ws.parseExtensionId(`https://microsoftedge.microsoft.com/addons/detail/ublock-origin-lite/${ID}`),
    { ok: true, id: ID, store: "edge" },
  );
});

test("parseExtensionId rejects junk", () => {
  for (const bad of ["", null, "abc", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", `https://evil.example/detail/x/${ID}`,
    "https://chromewebstore.google.com/detail/no-id-here", `file:///detail/${ID}/x`]) {
    const r = ws.parseExtensionId(bad);
    assert.equal(r.ok, false, String(bad));
    assert.ok(r.error);
  }
});

test("crxUrl builds the Chrome and Edge endpoints", () => {
  assert.equal(ws.crxUrl(ID, "chrome"),
    `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=142.0.0.0&acceptformat=crx2,crx3&x=id%3D${ID}%26uc`);
  assert.match(ws.crxUrl(ID, "chrome", { prodversion: "139.0.1.2" }), /prodversion=139\.0\.1\.2&/);
  assert.equal(ws.crxUrl(ID, "edge"),
    `https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&x=id%3D${ID}%26installsource%3Dondemand%26uc`);
  assert.throws(() => ws.crxUrl("nope"), /bad extension id/);
});

test("crxToZip strips CRX3 and CRX2 headers and rejects bad magic", () => {
  const zip = makeZip([{ name: "a.txt", data: "a" }]);
  assert.deepEqual(ws.crxToZip(crx3(zip)), zip);
  assert.deepEqual(ws.crxToZip(crx2(zip)), zip);
  assert.throws(() => ws.crxToZip(Buffer.concat([Buffer.from("PK\x03\x04xxxxxxxxxxxx"), zip])), /bad magic/);
  const v9 = crx3(zip); v9.writeUInt32LE(9, 4);
  assert.throws(() => ws.crxToZip(v9), /unsupported CRX version/);
  const long = crx3(zip); long.writeUInt32LE(1e9, 8);
  assert.throws(() => ws.crxToZip(long), /past the end/);
});

test("unzipTo extracts stored and deflated entries", (t) => {
  const d = tmp(t);
  const out = path.join(d, "x");
  const r = ws.unzipTo(makeZip([
    { name: "dir/", store: true },
    { name: "dir/deep/f.txt", data: "deflated ".repeat(100) },
    { name: "s.bin", data: Buffer.from([0, 1, 2, 255]), store: true },
  ]), out);
  assert.deepEqual(r, { files: 2, bytes: 904 });
  assert.equal(fs.readFileSync(path.join(out, "dir/deep/f.txt"), "utf8"), "deflated ".repeat(100));
  assert.deepEqual(fs.readFileSync(path.join(out, "s.bin")), Buffer.from([0, 1, 2, 255]));
});

test("unzipTo rejects zip-slip entries before writing anything", (t) => {
  const d = tmp(t);
  for (const evil of ["../evil.txt", "a/../../evil.txt", "/abs.txt", "C:/win.txt", "c:evil.txt", "..\\evil.txt", "a\\..\\..\\evil.txt"]) {
    const out = path.join(d, "out");
    assert.throws(() => ws.unzipTo(makeZip([{ name: "ok.txt", data: "ok" }, { name: evil, data: "x" }]), out), /zip-slip/, evil);
    assert.equal(fs.existsSync(path.join(out, "ok.txt")), false, `${evil} wrote a file before rejecting`);
  }
  assert.equal(fs.existsSync(path.join(d, "evil.txt")), false);
});

test("unzipTo enforces the size and entry caps and checks CRC", (t) => {
  const d = tmp(t);
  const big = makeZip([{ name: "big", data: Buffer.alloc(5000) }]);
  assert.throws(() => ws.unzipTo(big, path.join(d, "a"), { maxBytes: 1000 }), /expands past/);
  const many = makeZip([{ name: "1", data: "1" }, { name: "2", data: "2" }, { name: "3", data: "3" }]);
  assert.throws(() => ws.unzipTo(many, path.join(d, "b"), { maxEntries: 2 }), /too many entries/);
  assert.throws(() => ws.unzipTo(Buffer.from("not a zip at all, definitely not"), path.join(d, "c")), /not a ZIP/);
  const corrupt = makeZip([{ name: "s", data: "hello", store: true }]);
  corrupt[30 + 1] = "J".charCodeAt(0); // flip the first data byte of the stored entry
  assert.throws(() => ws.unzipTo(corrupt, path.join(d, "e")), /CRC mismatch/);
});

test("installFromStore downloads, unpacks, strips _metadata and warns", async (t) => {
  const d = tmp(t);
  const calls = [];
  const r = await ws.installFromStore(`https://chromewebstore.google.com/detail/x/${ID}`, { dir: d, fetchImpl: fakeFetch(crx3(extZip("1.2.3")), calls) });
  assert.equal(r.ok, true, r.error);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ws.crxUrl(ID, "chrome"));
  assert.equal(calls[0].opts.redirect, "follow");
  assert.equal(r.id, ID);
  assert.equal(r.name, "Test Ext");
  assert.equal(r.version, "1.2.3");
  assert.equal(r.manifestVersion, 3);
  assert.equal(r.path, path.join(d, ID, "1.2.3"));
  assert.ok(fs.existsSync(path.join(r.path, "manifest.json")));
  assert.ok(fs.existsSync(path.join(r.path, "js", "bg.js")));
  assert.equal(fs.existsSync(path.join(r.path, "_metadata")), false);
  assert.equal(r.warnings.length, 2);
  assert.ok(r.warnings.some((w) => /declarativeNetRequest/.test(w)));
  assert.ok(r.warnings.some((w) => /sidePanel/.test(w)));
  assert.deepEqual(fs.readdirSync(path.join(d, ID)).sort(), [".aither-install.json", "1.2.3"]);
});

test("installFromStore replaces the older version it installed and leaves others alone", async (t) => {
  const d = tmp(t);
  const r1 = await ws.installFromStore(ID, { dir: d, fetchImpl: fakeFetch(crx3(extZip("1.0.0"))) });
  assert.equal(r1.ok, true, r1.error);
  fs.mkdirSync(path.join(d, ID, "owner-notes"));
  const r2 = await ws.installFromStore(ID, { dir: d, fetchImpl: fakeFetch(crx2(extZip("1.1.0", { permissions: [] }))) });
  assert.equal(r2.ok, true, r2.error);
  assert.deepEqual(r2.warnings, []);
  assert.deepEqual(fs.readdirSync(path.join(d, ID)).sort(), [".aither-install.json", "1.1.0", "owner-notes"]);
  const again = await ws.installFromStore(ID, { dir: d, fetchImpl: fakeFetch(crx3(extZip("1.1.0"))) });
  assert.equal(again.ok, true, again.error);
  assert.deepEqual(fs.readdirSync(path.join(d, ID)).sort(), [".aither-install.json", "1.1.0", "owner-notes"]);
});

test("installFromStore refuses a version folder it did not create", async (t) => {
  const d = tmp(t);
  fs.mkdirSync(path.join(d, ID, "2.0.0"), { recursive: true });
  fs.writeFileSync(path.join(d, ID, "2.0.0", "keep.txt"), "mine");
  const r = await ws.installFromStore(ID, { dir: d, fetchImpl: fakeFetch(crx3(extZip("2.0.0"))) });
  assert.equal(r.ok, false);
  assert.match(r.error, /not installed here/);
  assert.equal(fs.readFileSync(path.join(d, ID, "2.0.0", "keep.txt"), "utf8"), "mine");
  assert.deepEqual(fs.readdirSync(path.join(d, ID)), ["2.0.0"]);
});

test("installFromStore reports bad input, HTTP errors, bad CRX and bad manifests", async (t) => {
  const d = tmp(t);
  assert.equal((await ws.installFromStore("nope", { dir: d })).ok, false);
  assert.match((await ws.installFromStore(ID, { dir: "relative" })).error, /absolute/);
  const http404 = async () => ({ ok: false, status: 404 });
  assert.match((await ws.installFromStore(ID, { dir: d, fetchImpl: http404 })).error, /HTTP 404/);
  assert.match((await ws.installFromStore(ID, { dir: d, fetchImpl: fakeFetch(Buffer.from("<html>no</html>xxxxxx")) })).error, /bad magic/);
  const noManifest = crx3(makeZip([{ name: "x.js", data: "1" }]));
  assert.match((await ws.installFromStore(ID, { dir: d, fetchImpl: fakeFetch(noManifest) })).error, /manifest\.json/);
  const mv1 = crx3(makeZip([{ name: "manifest.json", data: JSON.stringify({ manifest_version: 1, version: "1", name: "x" }) }]));
  assert.match((await ws.installFromStore(ID, { dir: d, fetchImpl: fakeFetch(mv1) })).error, /manifest_version/);
  const slip = crx3(makeZip([{ name: "../../escape.txt", data: "x" }]));
  assert.match((await ws.installFromStore(ID, { dir: d, fetchImpl: fakeFetch(slip) })).error, /zip-slip/);
  assert.equal(fs.existsSync(path.join(d, "escape.txt")), false);
  assert.deepEqual(fs.existsSync(path.join(d, ID)) ? fs.readdirSync(path.join(d, ID)) : [], []);
});
