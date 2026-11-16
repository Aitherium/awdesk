"use strict";

/** assist-tools: known install dirs only (never PATH), then an Authenticode gate before any exec. */

const test = require("node:test");
const assert = require("node:assert/strict");
const tools = require("./assist-tools.cjs");

const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", SystemRoot: "C:\\Windows", PATH: "C:\\Evil;C:\\Users\\me\\bin" };
const MS = { status: "Valid", subject: "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" };

function rig(files, readSignature, extra = {}) {
  const set = new Set(files);
  const reads = [];
  const stat = extra.stat || (() => ({ size: 10, mtimeMs: 1000 }));
  const t = tools.createTools({
    env: extra.env || env, platform: extra.platform || "win32", existsSync: (p) => set.has(String(p)),
    readdirSync: (d) => (String(d) === "C:\\Program Files" ? ["ImageMagick-7.1.1-Q16-HDRI", "Windows NT"] : []),
    statSync: stat, readSignature: async (f) => { reads.push(f); return readSignature(f); },
  });
  return { t, reads };
}

test("PATH is never searched: a planted tool in a PATH dir is not found, in any family", () => {
  const planted = ["C:\\Evil\\pslist64.exe", "C:\\Evil\\ffmpeg.exe", "C:\\Evil\\PowerToys.exe", "C:\\Users\\me\\bin\\pandoc.exe", "pslist64.exe", ".\\ffmpeg.exe"];
  const { t } = rig(planted, async () => MS);
  assert.equal(t.locate(["pslist64.exe"], "sysinternals"), null);
  assert.equal(t.locate(["ffmpeg.exe"], "converter"), null);
  assert.equal(t.locate(["PowerToys.exe"], "powertoys"), null);
  assert.equal(t.locate(["pandoc.exe"], "converter"), null);
  for (const family of tools.FAMILIES) assert.ok(!t.dirs(family).some((d) => /Evil|Users.me.bin$/.test(d)), family);
  assert.ok(!tools.sysinternalsDirs({ ...env, AWDESK_SYSINTERNALS_DIR: "C:\\Evil" }).some((d) => /Evil/.test(d)), "no env override either");
});

test("known locations are found: Program Files, per-user Programs, WinGet Links, Sysinternals, versioned ImageMagick", () => {
  const files = [
    "C:\\Program Files\\PowerToys\\WinUI3Apps\\PowerToys.ImageResizerCLI.exe",
    "C:\\Users\\me\\AppData\\Local\\Programs\\PowerToys\\PowerToys.exe",
    "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\pslist64.exe",
    "C:\\Sysinternals\\handle64.exe",
    "C:\\Program Files\\ImageMagick-7.1.1-Q16-HDRI\\magick.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Users\\me\\AppData\\Local\\Pandoc\\pandoc.exe",
  ];
  const { t } = rig(files, async () => MS);
  assert.equal(t.locate(["PowerToys.ImageResizerCLI.exe"], "powertoys"), files[0]);
  assert.equal(t.locate(["PowerToys.exe"], "powertoys"), files[1]);
  assert.equal(t.locate(["pslist64.exe"], "sysinternals"), files[2]);
  assert.equal(t.locate(["handle64.exe"], "sysinternals"), files[3]);
  assert.equal(t.locate(["magick.exe"], "converter"), files[4]);
  assert.equal(t.locate(["ffmpeg.exe"], "converter"), files[5]);
  assert.equal(t.locate(["pandoc.exe"], "converter"), files[6]);
  assert.equal(rig(files, async () => MS, { platform: "linux" }).t.locate(["ffmpeg.exe"], "converter"), null, "Windows only");
});

test("policy: PowerToys and Sysinternals must be Valid AND signed by Microsoft Corporation", () => {
  for (const family of ["powertoys", "sysinternals"]) {
    assert.equal(tools.judge(family, MS).ok, true);
    assert.equal(tools.judge(family, { status: "NotSigned", subject: "" }).ok, false);
    assert.equal(tools.judge(family, { status: "HashMismatch", subject: MS.subject }).ok, false);
    assert.equal(tools.judge(family, { status: "NotTrusted", subject: MS.subject }).ok, false);
    assert.equal(tools.judge(family, { status: "Valid", subject: "CN=Microsoft Corporation Impostor Ltd, O=x" }).ok, false, "a lookalike CN is not Microsoft");
    assert.equal(tools.judge(family, { status: "Valid", subject: "CN=Evil, O=Microsoft Corporation" }).ok, false, "the organisation field is not the signer");
    assert.equal(tools.judge(family, undefined).ok, false);
  }
  assert.equal(tools.commonName('CN="Microsoft Corporation", O=x'), "Microsoft Corporation");
});

test("policy: converters pass when Valid or NotSigned (the location is the trust); a broken signature is refused", () => {
  assert.deepEqual(tools.judge("converter", { status: "NotSigned", subject: "" }), { ok: true, signed: false });
  assert.equal(tools.judge("converter", { status: "Valid", subject: "CN=Some Vendor" }).signed, true);
  for (const status of ["HashMismatch", "NotTrusted", "UnknownError", "NotSupportedFileFormat", "Incompatible"]) assert.equal(tools.judge("converter", { status, subject: "CN=x" }).ok, false, status);
});

test("verify: a good Microsoft tool runs, a forged or tampered one does not, and the error names why", async () => {
  const f = "C:\\Program Files\\PowerToys\\PowerToys.exe";
  const good = rig([f], async () => MS);
  assert.deepEqual(await good.t.verify(f, "powertoys"), { ok: true, path: f, signed: true, signer: "Microsoft Corporation" });
  const forged = rig([f], async () => ({ status: "Valid", subject: "CN=Mallory" }));
  const bad = await forged.t.verify(f, "powertoys");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /PowerToys\.exe failed the signature check/);
  assert.match(bad.error, /Mallory/);
  assert.equal((await rig([f], async () => ({ status: "HashMismatch", subject: MS.subject })).t.verify(f, "powertoys")).ok, false);
  assert.equal((await good.t.verify("\\\\evil\\share\\x.exe", "powertoys")).ok, false, "UNC paths are refused outright");
  assert.equal((await good.t.verify("relative.exe", "powertoys")).ok, false);
  assert.equal((await good.t.verify(f, "nonsense")).ok, false);
  assert.equal((await rig([f], async () => MS, { stat: () => { throw new Error("gone"); } }).t.verify(f, "powertoys")).ok, false, "an unreadable file is not run");
});

test("verify caches a success per (path, size, mtime): a replaced file is judged again, a failure is never cached", async () => {
  const f = "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe";
  let stamp = 1000;
  let verdict = { status: "NotSigned", subject: "" };
  const r = rig([f], async () => verdict, { stat: () => ({ size: 10, mtimeMs: stamp }) });
  assert.equal((await r.t.verify(f, "converter")).ok, true);
  assert.equal((await r.t.verify(f, "converter")).ok, true);
  assert.equal(r.reads.length, 1, "second call came from the cache");
  stamp = 2000;
  verdict = { status: "HashMismatch", subject: "CN=x" };
  assert.equal((await r.t.verify(f, "converter")).ok, false, "the file changed on disk, so it was read again and now fails");
  assert.equal(r.reads.length, 2);
  assert.equal((await r.t.verify(f, "converter")).ok, false);
  assert.equal(r.reads.length, 3, "failures are re-read every time");
});

test("resolve: null when not installed, an error when installed but untrusted, a path when fine", async () => {
  const f = "C:\\Sysinternals\\pslist64.exe";
  assert.equal(await rig([], async () => MS).t.resolve(["pslist64.exe"], "sysinternals"), null);
  assert.equal((await rig([f], async () => ({ status: "NotSigned", subject: "" })).t.resolve(["pslist64.exe"], "sysinternals")).ok, false);
  assert.equal((await rig([f], async () => MS).t.resolve(["pslist64.exe"], "sysinternals")).path, f);
});

test("the signature reader uses the absolute System32 powershell and passes the file in the environment, not the command", async () => {
  const calls = [];
  const exec = (exe, args, opts, cb) => { calls.push({ exe, args, opts }); cb(null, JSON.stringify({ status: "Valid", subject: "CN=Microsoft Corporation, O=x" })); };
  const read = tools.psSignatureReader({ execFile: exec, env });
  const file = "C:\\Program Files\\Evil'; calc; '\\x.exe";
  assert.deepEqual(await read(file), { status: "Valid", subject: "CN=Microsoft Corporation, O=x" });
  assert.equal(calls[0].exe, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(calls[0].opts.env.AWDESK_TOOL_FILE, file);
  assert.equal(calls[0].opts.shell, false);
  assert.ok(!calls[0].args.join(" ").includes("calc"), "the path never appears in the command text");
  assert.match(tools.SIG_SCRIPT, /-LiteralPath \$env:AWDESK_TOOL_FILE/);
  const broken = tools.psSignatureReader({ execFile: (e, a, o, cb) => cb(new Error("boom")), env });
  assert.equal((await broken(file)).status, "UnknownError", "a reader that fails is a failed check");
  const garbage = tools.psSignatureReader({ execFile: (e, a, o, cb) => cb(null, "not json"), env });
  assert.equal((await garbage(file)).status, "UnknownError");
});

test("Windows only: the real Get-AuthenticodeSignature reads a Microsoft-signed system binary", { skip: process.platform !== "win32" }, async () => {
  const exe = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\notepad.exe`;
  const real = tools.createTools({ env: process.env });
  const out = await real.verify(exe, "sysinternals");
  // notepad.exe is catalog-signed on some builds (Get-AuthenticodeSignature reports NotSigned for
  // catalog-only files), so accept either a Microsoft pass or a refusal: never a crash.
  assert.equal(typeof out.ok, "boolean");
  if (out.ok) assert.equal(out.signer, "Microsoft Corporation");
  const unsigned = await real.verify(process.execPath, "powertoys");
  assert.equal(unsigned.ok, false, "node.exe is not a Microsoft PowerToys binary");
});
