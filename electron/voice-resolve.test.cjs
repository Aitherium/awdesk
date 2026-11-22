"use strict";

/**
 * voice-resolve tests — the ONE audibility gate, against real cast.json
 * fixtures (cast-config.cjs and its own resolveActor precedence are already
 * proven in cast-config.test.cjs; this file proves the GATE built on top of
 * it: which origins get in, which get refused with which reason, and which
 * get noted as seen-but-silent).
 *
 * Every call here takes `file` directly (a per-test tmpdir fixture), same
 * reasoning as cast-config.test.cjs's own header: `node --test` runs test
 * FILES as parallel child processes, and DESK_CAST_FILE would otherwise be
 * one shared env var raced by every test() in this file.
 *
 *   node electron/voice-resolve.test.cjs
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { resolveSpeech } = require("./voice-resolve.cjs");
const cast = require("./cast-config.cjs");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "desk-voice-resolve-"));
}

function castFileIn(dir) {
  return path.join(dir, "cast.json");
}

function writeCast(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function readSeen(file) {
  return cast.readSeen({ file: cast.SEEN_FILE(file) });
}

// ─── unknown origins ─────────────────────────────────────────────────────────

test("resolveSpeech: an unconfigured relay channel is refused (channels default voiced:false) and recorded to cast-seen.json", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  // No cast.json at all -- the file has never been authored, which is the
  // real first-run state this arm exercises.
  const gate = resolveSpeech({ origin: "relay:#random", slotId: "slot1", text: "hello from #random", file });

  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /not voiced/);

  const seen = readSeen(file);
  assert.ok(seen["relay:#random"], "an unknown relay origin must land in cast-seen.json");
  assert.equal(seen["relay:#random"].count, 1);
  assert.equal(seen["relay:#random"].sample, "hello from #random");
});

test("resolveSpeech: noteSeen accumulates on repeat sightings of the same unknown origin", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  resolveSpeech({ origin: "relay:#random", text: "first", file });
  resolveSpeech({ origin: "relay:#random", text: "second", file });
  const seen = readSeen(file);
  assert.equal(seen["relay:#random"].count, 2);
  assert.equal(seen["relay:#random"].sample, "second", "the LATEST sample wins");
});

test("resolveSpeech: a room actor with no cast.json entry is allowed by default (defaults.presence=normal) and does NOT get muted like an unconfigured relay", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  const gate = resolveSpeech({ origin: "claude_code:7f3a", text: "hi", file });
  assert.equal(gate.allowed, true, JSON.stringify(gate));
});

test("resolveSpeech: a KNOWN origin (an authored actors[] row) is never re-noted as seen", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, actors: { "bridge:/speak": { voice: "echo" } } });
  resolveSpeech({ origin: "bridge:/speak", text: "hi", file });
  const seen = readSeen(file);
  assert.equal(seen["bridge:/speak"], undefined, "a configured origin is not \"seen but silent\"");
});

// ─── granted origins ─────────────────────────────────────────────────────────

test("resolveSpeech: a granted origin returns its authored voice/speed with provenance naming the actors[] row", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, actors: { "mcp:speak": { voice: "echo", speed: 1.8 } } });
  const gate = resolveSpeech({ origin: "mcp:speak", slotId: "slot0", text: "hi", file });

  assert.equal(gate.allowed, true);
  assert.equal(gate.voice, "echo");
  assert.equal(gate.speed, 1.8);
  assert.match(gate.provenance.voiceFrom, /^actors\[/);
  assert.match(gate.provenance.speedFrom, /^actors\[/);
  assert.equal(gate.provenance.slotId, "slot0");
});

test("resolveSpeech: a relay nick's own colon-bearing key round-trips through the actors[] row minted for it", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  // Same key shape room-stage mints via originOf({kind:"relay", channel, nick}).
  // A per-nick voice preference alone does not make a mirrored channel
  // audible (channels default voiced:false on purpose -- "mirroring grants
  // nothing"), so the channel is granted too; this arm's job is proving the
  // KEY round-trips to the actors["relay:#agents:bob"] row at all, which
  // originOf({key: origin}) alone would get wrong (see originFromKey's doc).
  writeCast(file, {
    version: 1,
    channels: { "#agents": { voiced: true } },
    actors: { "relay:#agents:bob": { voice: "shimmer" } },
  });
  const gate = resolveSpeech({ origin: "relay:#agents:bob", text: "hi", file });
  assert.equal(gate.allowed, true, JSON.stringify(gate));
  assert.equal(gate.voice, "shimmer");
  assert.match(gate.provenance.voiceFrom, /^actors\[/, "must match the exact nick row, not a mangled key");
});

test("resolveSpeech: an unvoiced channel refuses a relay nick even when the nick has its own voice preference", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, actors: { "relay:#agents:bob": { voice: "shimmer" } } });
  const gate = resolveSpeech({ origin: "relay:#agents:bob", text: "hi", file });
  assert.equal(gate.allowed, false, "mirroring grants nothing until the channel itself is voiced");
  assert.match(gate.reason, /not voiced/);
});

// ─── distinct refusals ───────────────────────────────────────────────────────

test("resolveSpeech: presence:\"quiet\" and speak:false both refuse, with DISTINCT reasons", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, {
    version: 1,
    actors: {
      "mcp:speak": { presence: "quiet" },
      "desk:drop": { speak: false },
    },
  });
  const quiet = resolveSpeech({ origin: "mcp:speak", text: "hi", file });
  const muted = resolveSpeech({ origin: "desk:drop", text: "hi", file });

  assert.equal(quiet.allowed, false);
  assert.match(quiet.reason, /presence=quiet/);
  assert.equal(muted.allowed, false);
  assert.match(muted.reason, /speak=false/);
  assert.notEqual(quiet.reason, muted.reason);
});

test("resolveSpeech: presence:\"off\" refuses with its own reason too", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, actors: { "bridge:/speak": { presence: "off" } } });
  const gate = resolveSpeech({ origin: "bridge:/speak", text: "hi", file });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /presence=off/);
});

// ─── malformed file ──────────────────────────────────────────────────────────

test("resolveSpeech: a malformed cast file falls to the LAST-GOOD snapshot, not a wider default", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, actors: { "mcp:speak": { speak: false } } });

  // Prime the cache AND cast-config's own last-good memo with the good file.
  const before = resolveSpeech({ origin: "mcp:speak", text: "hi", file });
  assert.equal(before.allowed, false);

  // Corrupt it -- bump mtime so this module's own cache re-reads instead of
  // serving a stale-but-still-good entry.
  fs.writeFileSync(file, "{ not json", "utf8");
  const after = resolveSpeech({ origin: "mcp:speak", text: "hi", file });

  // A malformed file must NOT read as "nothing configured" (which would
  // silently un-mute mcp:speak) -- it must keep yesterday's verdict.
  assert.equal(after.allowed, false, "a bad byte must not widen to the permissive default");
  assert.match(after.reason, /speak=false/);
});

// ─── fail-open on an internal error ─────────────────────────────────────────

/**
 * Run `fn` against a box with NO cast.json. The no-argument path reads the box's
 * real config, and an owner who muted voice there (2026-10-03: voice.muted on the
 * owner's desk) turned "fails open" into a failure on exactly the machine that
 * matters. A muted owner is a CHOICE, not the defect these tests guard.
 */
function withNoCastFile(fn) {
  const before = process.env.DESK_CAST_FILE;
  process.env.DESK_CAST_FILE = path.join(os.tmpdir(), `awdesk-no-cast-${process.pid}-${Date.now()}.json`);
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.DESK_CAST_FILE;
    else process.env.DESK_CAST_FILE = before;
  }
}

test("resolveSpeech: never throws -- a garbage ctx still returns an allowed verdict", () => {
  withNoCastFile(() => {
    assert.doesNotThrow(() => {
      const gate = resolveSpeech(undefined);
      assert.equal(gate.allowed, true);
    });
    assert.doesNotThrow(() => {
      const gate = resolveSpeech({ origin: 12345, slotId: {}, text: null });
      assert.equal(typeof gate.allowed, "boolean");
    });
  });
});

// ─── loudness travels through the gate as ONE number ────────────────────────

test("resolveSpeech: an allowed verdict carries master x actor as `volume`, with provenance", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, {
    version: 1,
    voice: { volume: 0.5 },
    actors: { "mcp:speak": { volume: 0.6 } },
  });
  const gate = resolveSpeech({ origin: "mcp:speak", text: "hi", file });
  assert.equal(gate.allowed, true);
  assert.equal(gate.volume, 0.3);
  assert.equal(gate.provenance.masterVolumeFrom, "voice.volume");
  assert.equal(gate.provenance.volumeFrom, 'actors["mcp:speak"].volume');
});

test("resolveSpeech: voice.muted refuses every door, so silence never reaches the TTS call", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, voice: { muted: true } });
  for (const origin of ["mcp:speak", "bridge:/speak", "desk:drop", "service:awdesk"]) {
    const gate = resolveSpeech({ origin, text: "hi", file });
    assert.equal(gate.allowed, false, `${origin} must be refused while muted`);
    assert.match(gate.reason, /voice\.muted/);
  }
});

test("resolveSpeech: an origin configured with ONLY a volume is configured, not 'seen but silent'", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, actors: { "mcp:speak": { volume: 0.4 } } });
  resolveSpeech({ origin: "mcp:speak", text: "hi", file });
  const seen = readSeen(file);
  const keys = Array.isArray(seen) ? seen.map((row) => row.key) : Object.keys(seen.origins || seen || {});
  assert.ok(!keys.includes("mcp:speak"), `a volume-only record must not be noted as unseen: ${JSON.stringify(seen)}`);
});

test("resolveSpeech: the fail-open verdict is FULL volume, never silence", () => {
  // Against an EMPTY cast dir, so this asserts the fail-open default and not whatever volume
  // the person running the suite happens to have set. It used to call resolveSpeech(undefined),
  // which resolves CAST_FILE() -- the real %APPDATA%\Desk\cast.json -- and went red on a box
  // whose owner had chosen "volume": 0.35, while resolveSpeech was doing exactly its job.
  const dir = tmpDir();
  const file = castFileIn(dir);   // no cast file written: nothing is configured
  const gate = resolveSpeech({ origin: "mcp:speak", text: "hi", file });
  assert.equal(gate.allowed, true, "an unconfigured speaker is allowed, never muted by default");
  assert.equal(gate.volume, 1, "and at FULL volume — the fail-open default is not a quiet one");
});

test("resolveSpeech: with no context at all it still fails OPEN with no config", () => {
  // The no-argument path with nothing configured: it must neither throw nor silence --
  // an agent that never speaks is the failure this guards. (An owner who MUTES voice in
  // cast.json is obeyed; that is why this runs against a box with no cast.json.)
  withNoCastFile(() => {
    const gate = resolveSpeech(undefined);
    assert.equal(gate.allowed, true, "no context must never resolve to muted");
    assert.ok(typeof gate.volume === "number" && gate.volume > 0, `a positive volume: ${gate.volume}`);
  });
});

// ─── the caption verdict rides the same gate ────────────────────────────────

test("resolveSpeech: a REFUSED speaker still carries caption:true, so muting never hides the words", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, voice: { muted: true } });
  const gate = resolveSpeech({ origin: "mcp:speak", text: "the build is green", file });
  assert.equal(gate.allowed, false);
  assert.equal(gate.caption, true);
});

test("resolveSpeech: presence=off refuses the sound AND the caption", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, actors: { "mcp:speak": { presence: "off" } } });
  const gate = resolveSpeech({ origin: "mcp:speak", text: "hi", file });
  assert.equal(gate.allowed, false);
  assert.equal(gate.caption, false);
});

test("resolveSpeech: the fail-open verdict shows the words", () => {
  assert.equal(resolveSpeech(undefined).caption, true);
});

// ─── effectiveVoice: authored beats caller, hash does not ────────────────────

test("effectiveVoice: an authored voice beats the caller's; a hash-derived one yields to an explicit caller voice", () => {
  const { effectiveVoice } = require("./voice-resolve.cjs");
  const authored = { voice: "en-US-AnaNeural", provenance: { voiceFrom: 'actors["bridge:/speak"]' } };
  const hashed = { voice: "fable", provenance: { voiceFrom: "hash" } };
  assert.equal(effectiveVoice("nova", authored), "en-US-AnaNeural", "the owner's cast wins over the caller");
  assert.equal(effectiveVoice(undefined, authored), "en-US-AnaNeural");
  assert.equal(effectiveVoice("nova", hashed), "nova", "a bare hash must not overrule a voice asked for by name");
  assert.equal(effectiveVoice("", hashed), "fable", "no caller preference: the hash stands");
  assert.equal(effectiveVoice(undefined, null), "nova", "no gate at all: built-in");
  assert.equal(effectiveVoice("shimmer", null), "shimmer");
});

test("cache: two writes in ONE mtime tick still re-read (size is in the stamp)", () => {
  // Measured 2026-09-22 on a Windows CI runner: the second write of a test
  // shared the first's mtime and the resolver served the stale snapshot.
  // Pin the mtime to force that tick deterministically.
  const dir = tmpDir();
  const file = castFileIn(dir);
  const tick = 1700000000; // one whole second, so mtimeMs is exactly equal
  writeCast(file, { version: 1 });
  fs.utimesSync(file, tick, tick);
  const first = resolveSpeech({ origin: "bridge:/speak", slotId: "slot0", text: "hi", file });
  assert.equal(first.provenance.voiceFrom, "hash");
  writeCast(file, { version: 1, actors: { "bridge:/speak": { voice: "en-US-AnaNeural" } } });
  fs.utimesSync(file, tick, tick);
  const second = resolveSpeech({ origin: "bridge:/speak", slotId: "slot0", text: "hi", file });
  assert.equal(second.voice, "en-US-AnaNeural", "a same-tick edit was served from the stale cache");
});

test("effectiveVoice: end to end -- an unconfigured origin no longer re-voices an explicit POST /speak voice", () => {
  const { effectiveVoice } = require("./voice-resolve.cjs");
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1 });
  const gate = resolveSpeech({ origin: "bridge:/speak", slotId: "slot0", text: "hi", file });
  assert.equal(gate.provenance.voiceFrom, "hash");
  assert.equal(effectiveVoice("en-US-JennyNeural", gate), "en-US-JennyNeural");
  writeCast(file, { version: 1, actors: { "bridge:/speak": { voice: "en-US-AnaNeural" } } });
  const gate2 = resolveSpeech({ origin: "bridge:/speak", slotId: "slot0", text: "hi", file });
  assert.equal(effectiveVoice("en-US-JennyNeural", gate2), "en-US-AnaNeural");
});

// ─── the roster tier reaches the TTS gate ────────────────────────────────────

const { effectiveVoice, speechCtx } = require("./voice-resolve.cjs");

function rosterFileIn(dir) {
  const file = path.join(dir, "agent-roster.generated.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: ["aither", "atlas"],
      presence: {
        aither: { voice: "en-US-AnaNeural", character: "mermaid" },
        atlas: { voice: "en-US-MichelleNeural", character: "charlie" },
      },
    }),
    "utf8",
  );
  return file;
}

/** A canonical-map fixture: the platform's engine ids, which are NOT the roster's
 *  Microsoft edge names. */
function voicesFileIn(dir, agents = { atlas: { engine: "kokoro", voice: "kokoro:am_michael" }, aither: { engine: "piper", voice: "local:piper" } }) {
  const file = path.join(dir, "agent-voices.generated.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, agents }), "utf8");
  return file;
}

// The owner's real cast.json sets BOTH file-wide voices; before the gate read
// the roster these replaced every agent's declared voice at TTS time.
const FILE_WIDE = {
  version: 1,
  defaults: { voice: "en-US-JennyNeural" },
  voice: { defaultVoice: "en-US-JennyNeural" },
};

// ─── canonical > roster ──────────────────────────────────────────────────────

test("resolveSpeech: a stage speaker gets the CANONICAL engine voice, ahead of the roster mirror's *Neural name", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, FILE_WIDE);
  const agentRosterFile = rosterFileIn(dir);
  const agentVoicesFile = voicesFileIn(dir);
  const ctx = speechCtx({
    text: "hi",
    slotId: "room-atlas",
    origin: "adk_agent:a1",
    speaker: { origin: "adk_agent:a1", author: "atlas", agent: "atlas", seat: 0 },
    slotAgent: "atlas",
  });
  const gate = resolveSpeech({ ...ctx, file, agentRosterFile, agentVoicesFile });
  assert.equal(gate.allowed, true);
  assert.equal(gate.voice, "kokoro:am_michael", "the canonical map wins over roster.atlas (en-US-MichelleNeural)");
  assert.equal(gate.provenance.voiceFrom, "canonical.atlas.voice");
  // What main.cjs then synthesises with: the canonical id, not the roster's Edge name.
  assert.equal(effectiveVoice("en-US-MichelleNeural", gate), "kokoro:am_michael", "a caller's roster voice cannot re-voice an agent the map names");
});

test("resolveSpeech: the roster is still the fallback for an agent the canonical map does NOT name", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, FILE_WIDE);
  const agentRosterFile = rosterFileIn(dir);
  const agentVoicesFile = voicesFileIn(dir, { demiurge: { engine: "kokoro", voice: "kokoro:am_fenrir" } });
  const speaker = { origin: "adk_agent:a1", author: "atlas", agent: "atlas", seat: 0 };
  const gate = resolveSpeech({
    ...speechCtx({ text: "hi", slotId: "room-atlas", origin: speaker.origin, speaker }),
    file,
    agentRosterFile,
    agentVoicesFile,
  });
  assert.equal(gate.voice, "en-US-MichelleNeural");
  assert.equal(gate.provenance.voiceFrom, "roster.atlas.voice");
});

test("resolveSpeech: authors.<agent> still beats the CANONICAL map at the gate (owner override first)", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { ...FILE_WIDE, authors: { atlas: { voice: "en-US-EmmaNeural" } } });
  const agentRosterFile = rosterFileIn(dir);
  const agentVoicesFile = voicesFileIn(dir);
  const speaker = { origin: "adk_agent:a1", author: "atlas", agent: "atlas", seat: 0 };
  const gate = resolveSpeech({
    ...speechCtx({ text: "hi", slotId: "room-atlas", origin: speaker.origin, speaker }),
    file,
    agentRosterFile,
    agentVoicesFile,
  });
  assert.equal(gate.voice, "en-US-EmmaNeural");
  assert.equal(gate.provenance.voiceFrom, "authors.atlas.voice");
});

test("resolveSpeech: a caller that hands no author (a fairy / slot0 utterance) never consults authors, "
  + "so the canonical map governs that agent's voice", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  // The owner HAS an authors.atlas row; a swarm speak() only ever sends {agent}.
  writeCast(file, { ...FILE_WIDE, authors: { atlas: { voice: "custom:my-atlas" } } });
  const agentVoicesFile = voicesFileIn(dir);
  const gate = resolveSpeech({
    ...speechCtx({ text: "hi", slotId: "slot1", origin: "service:awdesk-swarm", speaker: { agent: "atlas" } }),
    file,
    agentVoicesFile,
  });
  assert.equal(gate.voice, "kokoro:am_michael");
  assert.equal(gate.provenance.voiceFrom, "canonical.atlas.voice");
});

test("resolveSpeech: the resident (slot0 = aither) gets its canonical voice over voice.defaultVoice, "
  + "and an actors[\"service:awdesk\"] voice still wins", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, voice: { defaultVoice: "en-US-JennyNeural" } });
  const agentRosterFile = rosterFileIn(dir);
  const agentVoicesFile = voicesFileIn(dir);
  const ctx = speechCtx({ text: "hi", slotId: "slot0", origin: "service:awdesk", slotAgent: "aither" });
  const plain = resolveSpeech({ ...ctx, file, agentRosterFile, agentVoicesFile });
  assert.equal(plain.voice, "local:piper");
  assert.equal(plain.provenance.voiceFrom, "canonical.aither.voice");

  writeCast(file, {
    version: 1,
    voice: { defaultVoice: "en-US-JennyNeural" },
    actors: { "service:awdesk": { voice: "custom:aither" } },
  });
  const owned = resolveSpeech({ ...ctx, file, agentRosterFile, agentVoicesFile });
  assert.equal(owned.voice, "custom:aither");
  assert.match(owned.provenance.voiceFrom, /^actors\[/);
});

test("resolveSpeech: end to end on the SHIPPED canonical map -- no agent resolves to a stock *Neural voice", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  // Two file-wide Edge defaults, i.e. exactly the drift the map has to beat.
  writeCast(file, FILE_WIDE);
  const shipped = require("./agent-voices.generated.json");
  assert.ok(shipped.agents && Object.keys(shipped.agents).length >= 8, "the shipped map must name the roster agents");
  for (const [agent, record] of Object.entries(shipped.agents)) {
    const gate = resolveSpeech({
      ...speechCtx({ text: "hi", slotId: "slot0", origin: "service:awdesk", slotAgent: agent }),
      file,
      agentRoster: { [agent]: { voice: "en-US-MichelleNeural" } },
      agentRosterFile: path.join(dir, "absent-roster.json"),
    });
    assert.equal(gate.voice, record.voice, `${agent} must resolve to its canonical voice`);
    assert.equal(gate.provenance.voiceFrom, `canonical.${agent}.voice`);
    assert.doesNotMatch(gate.voice, /Neural$/i, `${agent} still speaks a stock Edge voice (${gate.voice})`);
    assert.match(gate.voice, /^(kokoro:|local:piper|custom:)/, `${agent}'s voice is not an id AitherVoice understands: ${gate.voice}`);
  }
});

test("speechCtx: an HTTP/MCP door (no speaker) never names an author; the slot's agent keys the roster", () => {
  const ctx = speechCtx({ text: "x", slotId: "slot0", origin: "bridge:/speak", speaker: null, slotAgent: "aither" });
  assert.deepEqual(ctx, {
    origin: "bridge:/speak", slotId: "slot0", text: "x", agent: "aither", author: null, seat: null,
  });
  const staged = speechCtx({
    text: "x", slotId: "room-atlas", origin: "adk_agent:a1",
    speaker: { author: "atlas", agent: "atlas", seat: 2 }, slotAgent: "ignored",
  });
  assert.equal(staged.agent, "atlas");
  assert.equal(staged.author, "atlas");
  assert.equal(staged.seat, 2);
});
