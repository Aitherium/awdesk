# Desk integrations

Desk accepts small state and level messages from local voice experiences.
The character renderer never needs raw audio, transcripts, prompts, credentials,
or host-application internals.

The bundled Codex and ChatGPT integration uses native process-scoped output
listeners because those applications do not currently expose a supported
cross-process realtime voice event stream. If an official event stream becomes
available, it can map to the same contract without changing Desk's window or
animation system.

## Codex MCP server

Desk serves a Streamable HTTP MCP endpoint while the app is running. Add it
to Codex once:

```bash
codex mcp add desk --url http://127.0.0.1:47931/mcp
```

Start a new Codex session after registering the server. You can inspect the
saved connection with:

```bash
codex mcp get desk
```

Desk exposes these tools:

| Tool | Input | Effect |
| --- | --- | --- |
| `play_animation` | `animation`: `idle`, `greeting`, `talk`, `happy`, `finger-gun`, or `dance` | Shows Desk and plays an installed animation once |
| `control_window` | `action`: `show`, `hide`, or `toggle` | Controls the Desk window without quitting the app |
| `get_status` | None | Reads window visibility, voice state, and listener status |
| `list_animations` | None | Lists the clips `play_animation` accepts, including installed `FILE:<name>.vrma` motion packs |
| `list_characters` | None | Lists the installed character roster |
| `set_character` | `name`: a roster character from `list_characters` | Switches the Desk character and reloads the avatar |
| `spawn_avatar` | `slot_id`, `name` | Adds another avatar in a new slot without replacing the current one |
| `remove_avatar` | `slot_id` | Removes a spawned avatar slot (the default slot cannot be removed) |
| `set_agent` | `agent`: an agent name such as `aither` | Shows the character assigned to that agent |
| `list_agent_avatars` | None | Reads which character each agent is assigned to |
| `cast_describe` | None | Read-only view of the room cast configuration, its provenance and problems |
| `party_export` | None | Writes `party.json` from the cast and roster; content-gated characters are excluded |
| `export_to_aithershell` | None | Renders the current character into AitherShell |
| `speak` | `text`; optional `voice`, `speed` | Says a line aloud through AitherVoice with lip sync |
| `ask_owner` | `question`; optional `timeout_s` | Asks the owner aloud and waits for the spoken answer |
| `desktop_open` | `surface`: `overlay`, `app`, or `status` | Opens an AitherOS desktop surface |
| `fleet_status` | optional `fresh` | Reads the AitherOS fleet status (cached unless `fresh`) |
| `fleet_control` | `action`: `down`, `up`, `gaming`, `resume`, `adopt`, `open_panel`, `arc-status`, `arc-start`, `arc-now`, `arc-stop` | Runs a fleet action; the same implementation as the Fleet window |
| `desk_command` | `text` | Runs a command in the Aither Command window |

The roster, avatar, fleet, command and voice tools register only when the running Desk provides the matching
capability (roster, fleet control, voice, and so on).

The animation names are a stable product contract rather than file paths.
Future character packs can replace the media behind those names without
changing the MCP configuration or granting filesystem access.

An MCP-triggered animation temporarily takes priority over voice-driven body
motion. Lip sync continues while the clip plays. A newer MCP animation replaces
the current one; when the one-shot clip finishes, Desk returns to the current
idle, listening, or speaking state.

The MCP endpoint uses the same port as the local HTTP API. If
`DESK_BRIDGE_PORT` changes it, update the URL registered with Codex to match.

## Automatic listeners

### Linux

Desk polls the PipeWire graph for a Codex or ChatGPT playback node. It
attaches `pw-record` to that one stream, calculates RMS amplitude in memory, and
discards every sample after calculation. The stream remains connected to its
normal output device.

### Windows

The native helper uses WASAPI application loopback with
`PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`. Audio from other
applications is excluded. Desk supports Windows 10 build 20348 and newer.

### macOS

The native helper creates a private, unmuted Core Audio process tap and private
aggregate device for the selected voice process. Desk supports macOS 14.2
and newer and declares why it requests System Audio Recording permission.

Set `DESK_TARGET_PROCESS_PATTERN` to a case-insensitive regular expression
to target another desktop voice application:

```bash
DESK_TARGET_PROCESS_PATTERN='my-voice-app' desk
```

## URL protocol

Installed packages register `desk://`.

| URL | Effect |
| --- | --- |
| `desk://show` | Show and focus Desk |
| `desk://hide` | Hide Desk without quitting |
| `desk://toggle` | Toggle visibility |
| `desk://listening` | Begin a listening state |
| `desk://thinking` | Settle the character while a response is prepared |
| `desk://speaking?level=0.3` | Begin speaking and optionally set a level |
| `desk://inactive` | End the voice state without hiding Desk |
| `desk://greeting` | Preview the greeting motion |
| `desk://happy` | Preview the happy motion |
| `desk://finger-gun` | Preview the finger-gun motion |
| `desk://dance` | Preview a dance motion |

Open these URLs with `xdg-open` on Linux, `open` on macOS, or `start` on
Windows.

## Loopback HTTP API

Desk listens on `127.0.0.1:47931` by default. Override the port with
`DESK_BRIDGE_PORT`. Native clients may omit `Origin`; browser clients are
restricted to trusted local and supported app origins. Requests with a
non-loopback `Host` are rejected.

Voice state:

```json
{
  "type": "state",
  "state": {
    "phase": "active",
    "activity": "speaking",
    "microphoneMuted": false,
    "outputMuted": false
  }
}
```

Allowed phases are `inactive`, `starting`, `active`, and `stopping`. Allowed
activities are `idle`, `listening`, and `speaking`.

Normalized level:

```json
{
  "type": "audio-level",
  "level": 0.31
}
```

Animation preview:

```json
{
  "type": "animation",
  "animation": "DANCE"
}
```

Allowed animations are `IDLE`, `GREETING`, `TALK`, `HAPPY`, `FINGER_GUN`, and
`DANCE`.

Send events:

```bash
curl -H 'Content-Type: application/json' \
  --data '{"type":"state","state":{"phase":"active","activity":"speaking","microphoneMuted":false,"outputMuted":false}}' \
  http://127.0.0.1:47931/events
```

`GET /health` reports whether Desk is running and returns the last state. It
does not expose user content.
