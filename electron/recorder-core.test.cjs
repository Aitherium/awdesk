"use strict";

// recorder-core.cjs under node --test: naming, the ffmpeg argv for MP4 and GIF,
// crop math under scaleFactor, finalising with and without ffmpeg, and the
// recordings' upload riding strata-sync's queue through a retry.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("./recorder-core.cjs");
const sync = require("./strata-sync.cjs");

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rec-test-${tag}-`));
}

// ── naming ──────────────────────────────────────────────────────────────────

test("recordingName is 'Recording YYYY-MM-DD HHMMSS.<ext>' in local time", () => {
  const d = new Date(2026, 10, 1, 9, 3, 7);
  assert.equal(core.recordingName(d), "Recording 2026-11-01 090307.mp4");
  assert.equal(core.recordingName(d, "gif"), "Recording 2026-11-01 090307.gif");
  assert.equal(core.recordingName(d, ".webm"), "Recording 2026-11-01 090307.webm");
});

test("recordingDir is <Videos>/Aither Recordings, ~/Videos when Electron gives none", () => {
  assert.equal(core.recordingDir({ videosDir: path.join("X", "Vids") }), path.join("X", "Vids", "Aither Recordings"));
  assert.equal(core.recordingDir({ homeDir: path.join("H") }), path.join("H", "Videos", "Aither Recordings"));
});

test("normalizeOptions defaults to region MP4 and strips audio from GIF", () => {
  assert.deepEqual(core.normalizeOptions({}), { mode: "region", format: "mp4", systemAudio: false, mic: false, fps: 30 });
  const gif = core.normalizeOptions({ mode: "screen", format: "GIF", systemAudio: true, mic: true });
  assert.equal(gif.mode, "screen");
  assert.equal(gif.format, "gif");
  assert.equal(gif.systemAudio, false);
  assert.equal(gif.mic, false);
  assert.equal(core.normalizeOptions({ format: "mp4", mic: true }).mic, true);
});

// ── ffmpeg ──────────────────────────────────────────────────────────────────

test("mp4Args encodes H.264 yuv420p with even edges, AAC audio and faststart", () => {
  const a = core.mp4Args("in.webm", "out.mp4");
  assert.equal(a[a.indexOf("-i") + 1], "in.webm");
  assert.equal(a[a.length - 1], "out.mp4");
  assert.equal(a[a.indexOf("-c:v") + 1], "libx264");
  assert.equal(a[a.indexOf("-pix_fmt") + 1], "yuv420p");
  assert.equal(a[a.indexOf("-vf") + 1], "scale=trunc(iw/2)*2:trunc(ih/2)*2");
  assert.equal(a[a.indexOf("-c:a") + 1], "aac");
  assert.equal(a[a.indexOf("-movflags") + 1], "+faststart");
  assert.equal(a[0], "-y");
  const silent = core.mp4Args("in.webm", "out.mp4", { audio: false, crf: 28 });
  assert.ok(silent.includes("-an"));
  assert.equal(silent[silent.indexOf("-crf") + 1], "28");
});

test("gifArgs runs palettegen + paletteuse in one filter graph, looping", () => {
  const a = core.gifArgs("in.webm", "out.gif");
  const graph = a[a.indexOf("-filter_complex") + 1];
  assert.match(graph, /^\[0:v\]fps=15,scale=w='min\(960,iw\)':h=-1:flags=lanczos,split\[a\]\[b\];/);
  assert.match(graph, /\[a\]palettegen=stats_mode=diff\[p\];\[b\]\[p\]paletteuse=/);
  assert.equal(a[a.indexOf("-loop") + 1], "0");
  assert.equal(a[a.length - 1], "out.gif");
  const small = core.gifArgs("i", "o", { fps: 10, maxWidth: 640 });
  assert.match(small[small.indexOf("-filter_complex") + 1], /fps=10,scale=w='min\(640,iw\)'/);
});

test("convertPlan keeps WebM and names the remedy when ffmpeg is missing", () => {
  const none = core.convertPlan({ format: "mp4", ffmpeg: null, input: "i", output: "o" });
  assert.equal(none.ext, "webm");
  assert.equal(none.args, null);
  assert.equal(none.note, "1 recording kept as WebM — install ffmpeg (winget install Gyan.FFmpeg) for MP4/GIF");
  const gif = core.convertPlan({ format: "gif", ffmpeg: "C:\\ff\\ffmpeg.exe", input: "i", output: "o" });
  assert.equal(gif.ext, "gif");
  assert.ok(gif.args.includes("-filter_complex"));
});

test("findFfmpeg walks PATH (win32 .exe), honours AWDESK_FFMPEG, answers null when absent", () => {
  const want = path.win32.join("C:\\tools\\ffmpeg\\bin", "ffmpeg.exe");
  const env = { PATH: "C:\\Windows;\"C:\\tools\\ffmpeg\\bin\";C:\\other", PATHEXT: ".COM;.EXE;.BAT" };
  assert.equal(core.findFfmpeg({ env, platform: "win32", exists: (p) => p === want }), want);
  assert.equal(core.findFfmpeg({ env: { AWDESK_FFMPEG: "D:\\ff.exe", PATH: "" }, platform: "win32", exists: (p) => p === "D:\\ff.exe" }), "D:\\ff.exe");
  assert.equal(core.findFfmpeg({ env: { PATH: "/usr/bin:/usr/local/bin" }, platform: "linux", exists: (p) => p === "/usr/local/bin/ffmpeg" }), "/usr/local/bin/ffmpeg");
  assert.equal(core.findFfmpeg({ env, platform: "win32", exists: () => false }), null);
});

// ── crop math ───────────────────────────────────────────────────────────────

test("cropForStream maps DIPs to stream pixels at 150% and lands on even edges", () => {
  const display = { bounds: { width: 1280, height: 800 }, scaleFactor: 1.5 };
  const crop = core.cropForStream({ x: 101, y: 51, width: 201, height: 101 }, display, { width: 1920, height: 1200 });
  // 101*1.5=151.5 -> 152; right edge 302*1.5=453 -> width 301 -> even 300.
  assert.deepEqual(crop, { x: 152, y: 77, width: 300, height: 150 });
});

test("cropForStream uses the stream's REAL size, not scaleFactor, and clamps to it", () => {
  const display = { bounds: { width: 1280, height: 800 }, scaleFactor: 1.5 };
  // The stream came back at 125% instead (capturer downscaled): ratio wins.
  const crop = core.cropForStream({ x: 0, y: 0, width: 640, height: 400 }, display, { width: 1600, height: 1000 });
  assert.deepEqual(crop, { x: 0, y: 0, width: 800, height: 500 });
  // A drag past the right/bottom edge stops at the frame edge.
  const edge = core.cropForStream({ x: 1200, y: 700, width: 500, height: 500 }, display, { width: 1920, height: 1200 });
  assert.deepEqual(edge, { x: 1800, y: 1050, width: 120, height: 150 });
  assert.equal(core.cropForStream(null, display, { width: 1920, height: 1200 }), null);
});

test("evenRect trims odd edges and refuses a sliver", () => {
  assert.deepEqual(core.evenRect({ x: 3, y: 5, width: 101, height: 77 }, { width: 1000, height: 1000 }), { x: 3, y: 5, width: 100, height: 76 });
  assert.equal(core.evenRect({ x: 0, y: 0, width: 1, height: 50 }, { width: 10, height: 100 }), null);
});

test("captureConstraints pins the display's device pixels and the source id", () => {
  const c = core.captureConstraints({ sourceId: "screen:1:0", display: { bounds: { width: 1280, height: 800 }, scaleFactor: 1.5 }, fps: 24 });
  assert.equal(c.audio, false);
  assert.equal(c.video.mandatory.chromeMediaSource, "desktop");
  assert.equal(c.video.mandatory.chromeMediaSourceId, "screen:1:0");
  assert.equal(c.video.mandatory.maxWidth, 1920);
  assert.equal(c.video.mandatory.minHeight, 1200);
  assert.equal(c.video.mandatory.maxFrameRate, 24);
  // minFrameRate too: without it the legacy desktop capturer gave ~1.6 fps (2026-11-01).
  assert.equal(c.video.mandatory.minFrameRate, 24);
  assert.equal(core.systemAudioConstraints().audio.mandatory.chromeMediaSource, "desktop");
});

test("the recorder asks for H.264 first (GPU encode), VP9/VP8 as fallbacks", () => {
  const html = require("node:fs").readFileSync(require("node:path").join(__dirname, "recorder.html"), "utf8");
  const video = /\["video\/webm;codecs=h264", "video\/webm;codecs=vp9", "video\/webm;codecs=vp8", "video\/webm"\]/;
  const withAudio = /\["video\/webm;codecs=h264,opus", "video\/webm;codecs=vp9,opus", "video\/webm;codecs=vp8,opus", "video\/webm"\]/;
  assert.match(html, video);
  assert.match(html, withAudio);
});

// ── timer + status lines ────────────────────────────────────────────────────

test("formatElapsed and elapsedMs exclude paused time", () => {
  assert.equal(core.formatElapsed(7_400), "0:07");
  assert.equal(core.formatElapsed(723_000), "12:03");
  assert.equal(core.formatElapsed(3_723_000), "1:02:03");
  assert.equal(core.elapsedMs([[0, 5_000], [9_000, null]], 12_000), 8_000);
});

test("syncLine caps names at five with the real '+N more' and names the remedy", () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ name: `Recording 2026-11-01 0900${i}0.mp4`, attempts: 2, lastReason: "not signed in -- sign in to Aither to sync" }));
  const line = core.syncLine(rows);
  assert.match(line, /^7 recordings waiting to sync — sign in to Aither \(/);
  assert.match(line, /, \+2 more\)$/);
  assert.equal(core.capList(rows).shown.length, 5);
  assert.equal(core.syncLine([{ name: "Recording x.mp4", attempts: 0 }]), "Syncing to AitherOS Online · Screenshots");
});

test("uploadItem targets screenshots with the right type and keeps >100 MB local", () => {
  const ok = core.uploadItem({ filePath: path.join("d", "Recording a.mp4"), size: 1024 });
  assert.deepEqual(ok.item, { folder: "screenshots", name: "Recording a.mp4", filePath: path.join("d", "Recording a.mp4"), contentType: "video/mp4" });
  const big = core.uploadItem({ filePath: "Recording b.mp4", size: 150 * 1024 * 1024 });
  assert.equal(big.ok, false);
  assert.match(big.reason, /^1 recording too large to sync \(150 MB > 100 MB\) — kept on this PC$/);
});

// ── finalise ────────────────────────────────────────────────────────────────

test("createChunkWriter appends every chunk in order", () => {
  const dir = tmpDir("chunks");
  const w = core.createChunkWriter(path.join(dir, "sub", "rec.webm"));
  assert.equal(w.write(Buffer.from("ab")).ok, true);
  assert.equal(w.write(new Uint8Array([99, 100])).bytes, 4);
  w.close();
  assert.equal(fs.readFileSync(w.path, "utf8"), "abcd");
});

/** The first 12 bytes of a real MP4: a size word, then "ftyp", then a brand. */
const FAKE_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.from("mp4-bytes")]);

test("finalizeRecording converts with ffmpeg, removes the temp file and queues the MP4 when sync is on", async () => {
  const dir = tmpDir("fin");
  const temp = path.join(dir, "temp.webm");
  fs.writeFileSync(temp, "webm-bytes");
  const calls = [];
  const queued = [];
  const v = await core.finalizeRecording({
    tempPath: temp, dir: path.join(dir, "out"), startedAt: new Date(2026, 10, 1, 9, 30, 0),
    format: "mp4", ffmpeg: "ffmpeg.exe", sync: true,
    run: async (bin, args) => { calls.push([bin, args]); fs.writeFileSync(args[args.length - 1], FAKE_MP4); return { ok: true }; },
    enqueue: (item) => { queued.push(item); return { ok: true, id: "job-1" }; },
  });
  assert.equal(v.ok, true);
  assert.equal(v.name, "Recording 2026-11-01 093000.mp4");
  assert.equal(v.format, "mp4");
  assert.equal(v.queued, true);
  assert.equal(v.queueId, "job-1");
  assert.equal(v.note, null);
  assert.equal(calls[0][0], "ffmpeg.exe");
  assert.ok(calls[0][1].includes("libx264"));
  assert.equal(fs.existsSync(temp), false);
  assert.deepEqual(fs.readFileSync(v.path), FAKE_MP4);
  assert.equal(queued[0].folder, "screenshots");
  assert.equal(queued[0].contentType, "video/mp4");
});

test("finalizeRecording without ffmpeg keeps the WebM and says so", async () => {
  const dir = tmpDir("noff");
  const temp = path.join(dir, "temp.webm");
  fs.writeFileSync(temp, "webm-bytes");
  const v = await core.finalizeRecording({
    tempPath: temp, dir: path.join(dir, "out"), startedAt: new Date(2026, 10, 1, 9, 30, 0),
    format: "gif", ffmpeg: null, run: async () => { throw new Error("must not run"); },
    enqueue: () => ({ ok: true }),
  });
  assert.equal(v.ok, true);
  assert.equal(v.name, "Recording 2026-11-01 093000.webm");
  assert.match(v.note, /^1 recording kept as WebM — install ffmpeg/);
  assert.equal(fs.readFileSync(v.path, "utf8"), "webm-bytes");
});

test("finalizeRecording falls back to WebM when the conversion fails", async () => {
  const dir = tmpDir("ffail");
  const temp = path.join(dir, "temp.webm");
  fs.writeFileSync(temp, "webm-bytes");
  const v = await core.finalizeRecording({
    tempPath: temp, dir: path.join(dir, "out"), format: "mp4", ffmpeg: "ffmpeg",
    run: async () => ({ ok: false, reason: "Unknown encoder 'libx264'" }), enqueue: () => ({ ok: true }),
  });
  assert.equal(v.ok, true);
  assert.equal(v.format, "webm");
  assert.match(v.note, /^1 conversion failed \(Unknown encoder 'libx264'\) — kept as WebM$/);
});

test("finalizeRecording reports an empty capture with its remedy", async () => {
  const dir = tmpDir("empty");
  const temp = path.join(dir, "temp.webm");
  fs.writeFileSync(temp, "");
  const v = await core.finalizeRecording({ tempPath: temp, dir, format: "mp4" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /^1 recording came back empty — /);
});

// ── upload queue retry (the real strata-sync queue, a recording item) ────────

test("a saved recording's upload retries after a 503 and lands on the next drain", async () => {
  const dir = tmpDir("queue");
  const file = path.join(dir, "Recording 2026-11-01 093000.mp4");
  fs.writeFileSync(file, "mp4-bytes");
  let clock = 1_000_000;
  const scheduled = [];
  const events = [];
  const seen = [];
  const answers = [
    { ok: false, status: 503, reason: "HTTP 503", permanent: false },
    { ok: true, status: 200, data: { success: true } },
  ];
  const q = sync.createUploadQueue({
    spoolDir: path.join(dir, "spool"),
    now: () => clock,
    schedule: (fn, ms) => { scheduled.push(ms); return { fn }; },
    cancel: () => {},
    baseMs: 5_000,
    upload: async (job, bytes) => { seen.push([job.folder, job.name, job.contentType, String(bytes)]); return answers.shift(); },
    onEvent: (e) => events.push(e.type),
  });
  const up = core.uploadItem({ filePath: file, size: fs.statSync(file).size });
  assert.equal(q.enqueue(up.item).ok, true);
  await q.drain();
  assert.deepEqual(events, ["retry"]);
  assert.equal(q.pending()[0].attempts, 1);
  assert.equal(q.pending()[0].lastReason, "HTTP 503");
  assert.ok(scheduled.includes(5_000));
  clock += 5_000;
  await q.drain();
  assert.deepEqual(events, ["retry", "uploaded"]);
  assert.equal(q.pending().length, 0);
  assert.deepEqual(seen[1], ["screenshots", "Recording 2026-11-01 093000.mp4", "video/mp4", "mp4-bytes"]);
});

// ── the argv against the REAL ffmpeg (skipped where none is on PATH) ─────────

const realFfmpeg = core.findFfmpeg();

test("mp4Args and gifArgs produce playable files with the real ffmpeg", { skip: realFfmpeg ? false : "ffmpeg not on PATH" }, async () => {
  const { execFileSync } = require("node:child_process");
  const dir = tmpDir("real");
  const src = path.join(dir, "src.webm");
  // A 1 s odd-sized (321x181) VP9 clip with a tone: the shape MediaRecorder emits.
  execFileSync(realFfmpeg, ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=321x181:rate=15:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libvpx-vp9", "-b:v", "200k", "-c:a", "libopus", "-shortest", src], { windowsHide: true, timeout: 60_000 });
  const mp4 = path.join(dir, "out.mp4");
  const gif = path.join(dir, "out.gif");
  execFileSync(realFfmpeg, core.mp4Args(src, mp4), { windowsHide: true, timeout: 60_000 });
  execFileSync(realFfmpeg, core.gifArgs(src, gif), { windowsHide: true, timeout: 60_000 });
  assert.equal(fs.readFileSync(mp4).subarray(4, 8).toString("latin1"), "ftyp");
  assert.equal(fs.readFileSync(gif).subarray(0, 6).toString("latin1"), "GIF89a");
  // Even edges: the scale filter trimmed 321x181 to 320x180 for yuv420p.
  const probe = (() => { try { return execFileSync(realFfmpeg, ["-hide_banner", "-i", mp4], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return String(e.stderr); } })();
  assert.match(String(probe), /h264.*320x180/);
});

// ── review findings 2026-11-01: each test failed before its fix ─────────────

// F1 (high): a fixed 30 s upload timeout retried a big recording forever.
test("F1 uploadTimeoutMs scales with size above strata-sync's 30 s floor", () => {
  assert.equal(core.uploadTimeoutMs(0), 30_000);
  assert.equal(core.uploadTimeoutMs(1024 * 1024), 30_000);
  // 100 MB at the 512 KB/s floor speed is 200 s, not 30 s.
  assert.equal(core.uploadTimeoutMs(100 * 1024 * 1024), 200_000);
});

test("F1 a recording upload passes the scaled timeout and is DROPPED after 3 timeouts in a row", async () => {
  const dir = tmpDir("timeout");
  const file = path.join(dir, "Recording 2026-11-01 100000.mp4");
  fs.writeFileSync(file, Buffer.alloc(40 * 1024 * 1024, 1)); // 40 MB: timed out at 30 s on 10 Mbit/s
  const timeouts = [];
  const uploader = core.createRecordingUploader({
    uploadOnce: async (args) => { timeouts.push(args.timeoutMs); return { ok: false, status: 0, reason: "upload timed out", permanent: false }; },
    origin: () => "https://app.example", token: () => "t",
  });
  let clock = 1_000;
  const events = [];
  const q = sync.createUploadQueue({
    spoolDir: path.join(dir, "spool"), now: () => clock,
    schedule: () => ({}), cancel: () => {}, baseMs: 1, maxMs: 1,
    upload: uploader, onEvent: (e) => events.push([e.type, e.verdict && e.verdict.reason]),
  });
  assert.equal(q.enqueue(core.uploadItem({ filePath: file, size: fs.statSync(file).size }).item).ok, true);
  for (let i = 0; i < 3; i += 1) { await q.drain(); clock += 10; }
  assert.deepEqual(timeouts, [80_000, 80_000, 80_000]);
  assert.deepEqual(events.map((e) => e[0]), ["retry", "retry", "dropped"]);
  assert.equal(events[2][1], "upload timed out 3 times (40 MB) — kept on this PC");
  assert.equal(q.pending().length, 0);
  // The spooled 40 MB copy is gone with the job, so the spool stops growing.
  assert.deepEqual(fs.readdirSync(path.join(dir, "spool")), []);
  assert.match(core.syncLine([{ name: "Recording a.mp4", attempts: 1, lastReason: "upload timed out" }]),
    /^1 recording waiting to sync — slow upload, retrying \(gives up after 3 timeouts\)/);
});

// F2: a failed chunk write was ignored and later chunks appended past the hole.
test("F2 the chunk writer refuses every append after the first failure", () => {
  const dir = tmpDir("sticky");
  let calls = 0;
  const flaky = {
    ...fs,
    writeSync: (fd, b) => {
      calls += 1;
      if (calls === 2) { const e = new Error("ENOSPC: no space left on device"); e.code = "ENOSPC"; throw e; }
      return fs.writeSync(fd, b);
    },
  };
  const w = core.createChunkWriter(path.join(dir, "rec.webm"), flaky);
  assert.equal(w.write(Buffer.from("ab")).ok, true);
  const bad = w.write(Buffer.from("cd"));
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /^could not write the recording: ENOSPC/);
  const after = w.write(Buffer.from("ef"));
  assert.equal(after.ok, false);
  assert.equal(after.refused, true);
  assert.equal(calls, 2);
  w.close();
  assert.equal(fs.readFileSync(w.path, "utf8"), "ab");
  assert.match(w.failed, /ENOSPC/);
});

test("F2 finalizeRecording names a truncated recording in the toast note", async () => {
  const dir = tmpDir("trunc");
  const temp = path.join(dir, "temp.webm");
  fs.writeFileSync(temp, "webm-bytes");
  const v = await core.finalizeRecording({
    tempPath: temp, dir: path.join(dir, "out"), format: "webm", truncated: "could not write the recording: ENOSPC",
  });
  assert.equal(v.ok, true);
  assert.equal(v.note, "1 recording truncated — could not write the recording: ENOSPC; what came before is saved");
});

// F3 + F4: the window's IPC table, driven without Electron.
function fakeBar(id) {
  const sent = [];
  return { sent, isDestroyed: () => false, destroy() {}, webContents: { id, send: (ch, cmd) => sent.push([ch, cmd]) } };
}

test("F3 recorder:region-cancel from the bar during a live recording is refused and keeps the session", () => {
  const win = require("./recorder-window.cjs");
  const bar = fakeBar(41);
  const writer = core.createChunkWriter(path.join(tmpDir("cancel"), "rec.webm"));
  win.__setStateForTest({
    session: { state: "recording", options: core.normalizeOptions({}), segments: [[1, null]], bar, writer },
    overlays: new Map(),
  });
  const r = win.handlers()["recorder:region-cancel"]({ sender: { id: 41 } });
  assert.deepEqual(r, { ok: false, reason: "no recording selection in progress" });
  assert.equal(win.__setStateForTest({}).session.state, "recording");
  // A chunk from the bar still lands: the session was not orphaned.
  assert.equal(win.handlers()["recorder:chunk"]({ sender: { id: 41 } }, new Uint8Array([1, 2])).ok, true);
  writer.close();
  win.__setStateForTest({ session: null });
});

test("F3 recorder:region-cancel from an overlay while selecting does cancel", () => {
  const win = require("./recorder-window.cjs");
  const overlay = { win: { isDestroyed: () => true, destroy() {} } };
  win.__setStateForTest({
    session: { state: "selecting", options: core.normalizeOptions({}), segments: [] },
    overlays: new Map([[7, overlay]]),
  });
  assert.deepEqual(win.handlers()["recorder:region-cancel"]({ sender: { id: 7 } }), { ok: true });
  assert.equal(win.__setStateForTest({}).session, null);
});

test("F4 stop during 'starting' is held, then delivered when the bar reports recording", () => {
  const win = require("./recorder-window.cjs");
  const bar = fakeBar(52);
  win.__setStateForTest({ session: { state: "starting", options: core.normalizeOptions({}), segments: [], bar }, overlays: new Map() });
  assert.deepEqual(win.stopRecording(), { ok: true, pending: true });
  assert.deepEqual(bar.sent, []);
  const r = win.handlers()["recorder:state"]({ sender: { id: 52 } }, "recording");
  assert.equal(r.ok, true);
  assert.deepEqual(bar.sent, [["recorder:command", "stop"]]);
  assert.equal(win.__setStateForTest({}).session.pendingCommand, null);
  // Once recording, a stop goes straight to the bar.
  assert.deepEqual(win.stopRecording(), { ok: true });
  assert.deepEqual(bar.sent[1], ["recorder:command", "stop"]);
  win.__setStateForTest({ session: null });
});

test("F4 pause during 'starting' toggles a held pause; a held stop wins", () => {
  const win = require("./recorder-window.cjs");
  const bar = fakeBar(53);
  win.__setStateForTest({ session: { state: "starting", options: core.normalizeOptions({}), segments: [], bar }, overlays: new Map() });
  assert.deepEqual(win.togglePause(), { ok: true, pending: true });
  assert.equal(win.__setStateForTest({}).session.pendingCommand, "pause");
  win.stopRecording();
  win.togglePause();
  assert.equal(win.__setStateForTest({}).session.pendingCommand, "stop");
  win.__setStateForTest({ session: null });
});

// F5: a failed move lost the path; temp leftovers were never recovered.
test("F5 a move refused by a held file reports where the WebM was left, and keeps it", async () => {
  const dir = tmpDir("held");
  const temp = path.join(dir, "rec-1.webm");
  fs.writeFileSync(temp, "webm-bytes");
  const busy = (code) => () => { const e = new Error(`${code}: resource busy or locked`); e.code = code; throw e; };
  const held = { ...fs, renameSync: busy("EBUSY"), copyFileSync: busy("EPERM") };
  const v = await core.finalizeRecording({
    tempPath: temp, dir: path.join(dir, "out"), format: "webm", fsImpl: held, moveOpts: { wait: () => {} },
  });
  assert.equal(v.ok, false);
  assert.equal(v.keptAt, temp);
  assert.ok(v.reason.startsWith(`1 recording left in ${temp} — move it manually (EPERM`), v.reason);
  assert.equal(fs.readFileSync(temp, "utf8"), "webm-bytes");
});

test("F5 moveFile retries a busy rename before copying", () => {
  const dir = tmpDir("retry");
  const from = path.join(dir, "a.webm");
  const to = path.join(dir, "b.webm");
  fs.writeFileSync(from, "x");
  let tries = 0;
  const waits = [];
  const fsImpl = {
    ...fs,
    renameSync: (a, b) => {
      tries += 1;
      if (tries < 3) { const e = new Error("EBUSY"); e.code = "EBUSY"; throw e; }
      fs.renameSync(a, b);
    },
    copyFileSync: () => { throw new Error("must not copy"); },
  };
  assert.deepEqual(core.moveFile(from, to, fsImpl, { wait: (ms) => waits.push(ms) }), { ok: true });
  assert.equal(tries, 3);
  assert.deepEqual(waits, [200, 400]);
  assert.equal(fs.readFileSync(to, "utf8"), "x");
});

test("F5 recoverStaleRecordings moves old temp WebMs into the recordings folder and removes empty ones", () => {
  const dir = tmpDir("recover");
  const temp = path.join(dir, "tmp");
  const out = path.join(dir, "out");
  fs.mkdirSync(temp);
  const old = new Date(2026, 10, 1, 8, 0, 0);
  for (const [name, body] of [["rec-1.webm", "kept"], ["rec-2.webm", ""], ["rec-3.webm", "fresh"], ["other.txt", "x"]]) {
    fs.writeFileSync(path.join(temp, name), body);
    if (name !== "rec-3.webm") fs.utimesSync(path.join(temp, name), old, old);
  }
  const r = core.recoverStaleRecordings({ tempDirPath: temp, dir: out, now: Date.now() });
  assert.deepEqual(r.recovered, ["Recording 2026-11-01 080000 (recovered).webm"]);
  assert.equal(r.removed, 1);
  assert.equal(fs.readFileSync(path.join(out, r.recovered[0]), "utf8"), "kept");
  assert.deepEqual(fs.readdirSync(temp).sort(), ["other.txt", "rec-3.webm"]);
  assert.equal(core.recoveredLine(r),
    "1 unsaved recording recovered — in Videos · Aither Recordings (Recording 2026-11-01 080000 (recovered).webm)");
});

// F6: ffmpeg exiting 0 with an empty/torn output deleted the only good copy.
test("F6 an ffmpeg 'success' with an empty output keeps the WebM", async () => {
  const dir = tmpDir("empty-out");
  const temp = path.join(dir, "temp.webm");
  fs.writeFileSync(temp, "webm-bytes");
  const v = await core.finalizeRecording({
    tempPath: temp, dir: path.join(dir, "out"), format: "mp4", ffmpeg: "ffmpeg",
    run: async (_bin, args) => { fs.writeFileSync(args[args.length - 1], ""); return { ok: true }; },
  });
  assert.equal(v.ok, true);
  assert.equal(v.format, "webm");
  assert.equal(v.note, "1 conversion failed (ffmpeg wrote an empty file) — kept as WebM");
  assert.equal(fs.readFileSync(v.path, "utf8"), "webm-bytes");
  assert.deepEqual(fs.readdirSync(path.join(dir, "out")), [v.name]);
});

test("F6 verifyOutput checks the MP4 'ftyp' and GIF 'GIF8' magic bytes", () => {
  const dir = tmpDir("magic");
  const mp4 = path.join(dir, "a.mp4");
  const gif = path.join(dir, "a.gif");
  const torn = path.join(dir, "b.mp4");
  fs.writeFileSync(mp4, FAKE_MP4);
  fs.writeFileSync(gif, "GIF89a....");
  fs.writeFileSync(torn, "garbage-not-an-mp4");
  assert.equal(core.verifyOutput(mp4, "mp4").ok, true);
  assert.equal(core.verifyOutput(gif, "gif").ok, true);
  assert.deepEqual(core.verifyOutput(torn, "mp4"), { ok: false, reason: "a file that is not MP4" });
});

// F7: every recording, mic audio included, was uploaded with no opt-in.
test("F7 finalizeRecording does NOT queue an upload unless sync is on, and says it can be synced", async () => {
  const dir = tmpDir("optin");
  const temp = path.join(dir, "temp.webm");
  fs.writeFileSync(temp, "webm-bytes");
  const queued = [];
  const v = await core.finalizeRecording({
    tempPath: temp, dir: path.join(dir, "out"), format: "webm",
    enqueue: (item) => { queued.push(item); return { ok: true, id: "x" }; },
  });
  assert.equal(v.ok, true);
  assert.equal(v.queued, false);
  assert.equal(v.syncable, true);
  assert.equal(v.syncNote, null);
  assert.deepEqual(queued, []);
});

test("F7 the window's auto-sync is off unless opted in, and the toast offers Sync", () => {
  const win = require("./recorder-window.cjs");
  win.configureRecorder({ syncEnabled: () => false });
  assert.equal(win.autoSyncEnabled(), false);
  win.configureRecorder({ syncEnabled: () => true });
  assert.equal(win.autoSyncEnabled(), true);
  win.configureRecorder({ syncEnabled: null });
  win.__setStateForTest({ toastInfo: { ok: true, name: "Recording a.webm", format: "webm", queued: false, syncable: true, syncNote: null } });
  const t = win.publicToast();
  assert.equal(t.canSync, true);
  assert.equal(t.canCancelSync, false);
  assert.equal(t.sync, "Kept on this PC — press Sync to upload it to AitherOS Online");
  win.__setStateForTest({ toastInfo: null });
});

test("F7 a cancelled recording upload: its spool goes and the queue never sends it", async () => {
  const dir = tmpDir("cancel-sync");
  const spoolDir = path.join(dir, "spool");
  const file = path.join(dir, "Recording 2026-11-01 110000.webm");
  fs.writeFileSync(file, "webm-bytes");
  const sent = [];
  const events = [];
  const cancelled = new Set();
  let clock = 1;
  const q = sync.createUploadQueue({
    spoolDir, now: () => clock, schedule: () => ({}), cancel: () => {}, baseMs: 1, maxMs: 1,
    upload: core.createRecordingUploader({
      uploadOnce: async (a) => {
        sent.push(a.name);
        return sent.length === 1 ? { ok: false, status: 0, reason: "not signed in -- sign in to Aither to sync", permanent: false } : { ok: true };
      },
      origin: () => "https://x", token: () => "t", isCancelled: (id) => cancelled.has(id),
    }),
    onEvent: (e) => events.push([e.type, e.verdict && e.verdict.reason]),
  });
  // Waiting on a retry (signed out) is when the owner sees the toast and cancels.
  const id = q.enqueue(core.uploadItem({ filePath: file, size: 10 }).item).id;
  await q.drain();
  assert.deepEqual(events.map((e) => e[0]), ["retry"]);
  cancelled.add(id);
  assert.deepEqual(core.cancelSpooledJob({ spoolDir, id }), { ok: true, removed: 2 });
  clock += 10;
  await q.drain();
  assert.equal(sent.length, 1);
  assert.equal(q.pending().length, 0);
  assert.equal(events[1][0], "dropped");
  // A restart does not resurrect it: the spool is empty.
  assert.deepEqual(fs.readdirSync(spoolDir), []);
  assert.deepEqual(core.cancelSpooledJob({ spoolDir, id }), { ok: false, reason: "1 sync already finished — nothing to cancel" });
});

// 2026-11-02: the 4K screen on the RTX 5090 is invisible to desktopCapturer while the
// desk is pinned to the iGPU; those displays record through ffmpeg gdigrab.
test("nativeGrabArgs grabs the physical rect with even sizes", () => {
  const args = core.nativeGrabArgs({ rect: { x: -10, y: 0, width: 3841, height: 2161 }, fps: 20, output: "o.mkv" });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at("-f"), "gdigrab");
  assert.equal(at("-offset_x"), "-10");
  assert.equal(at("-video_size"), "3840x2160");
  assert.equal(at("-framerate"), "20");
  assert.equal(args[args.length - 1], "o.mkv");
  assert.equal(core.nativeGrabArgs({ rect: { x: 0, y: 0, width: 1, height: 9 }, output: "o.mkv" }), null);
});

test("nativeConcatList quotes paths for the concat demuxer", () => {
  const bs = String.fromCharCode(92);
  const list = core.nativeConcatList([`C:${bs}t${bs}a.mkv`, `C:${bs}x'y${bs}b.mkv`]);
  assert.equal(list, `file 'C:/t/a.mkv'\nfile 'C:/x'${bs}''y/b.mkv'\n`);
});

test("nativeMuxArgs joins the bar's sound onto the native video without re-encoding", () => {
  const args = core.nativeMuxArgs({ video: "v.mkv", audio: "a.webm", output: "av.mkv" });
  assert.deepEqual(args.slice(args.indexOf("-map")), ["-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-shortest", "-y", "av.mkv"]);
});
