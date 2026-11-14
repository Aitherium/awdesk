# Workspace policy: the managed browser (slice 1, desk side)

A workspace can name the web apps its people work in. For those origins, and only those,
the Aither Browser enforces a policy the workspace **signed**: what may leave the page
(copy, download, print, capture), whether the page carries a watermark, and whether a
private app that lives on the mesh may be opened at all. Everything else the owner browses
is untouched.

Status: **desk side built, default inert.** No signing key is pinned in the app yet (see
"Not yet"), so on a real desk no policy verifies and nothing is governed. The live proof
(`npm run test:browser-parity`, the `workspace:` checks) runs the whole path with a key pair
made for that run.

## The policy document

```json
{
  "v": 1,
  "tenant_id": "acme",
  "serial": 12,
  "not_after": "2027-01-01T00:00:00Z",
  "apps": [
    {
      "origin": "https://wiki.corp.example",
      "private": { "host": "100.64.0.7", "port": 8443 },
      "deny": ["copy", "download", "print", "capture", "devtools"],
      "watermark": true,
      "audit": true
    },
    { "origin": "https://crm.example.com", "deny": ["download"] }
  ],
  "sig": "<base64 Ed25519 signature>"
}
```

| field | meaning |
|---|---|
| `v` | schema version, `1`. Any other value is refused. |
| `tenant_id` | the workspace. The first good policy binds it; another tenant's policy is refused afterwards. It names the work session: `persist:aither-work-<tenant_id>`. |
| `serial` | a positive integer that only goes up. |
| `not_after` | UTC, `YYYY-MM-DDTHH:MM:SSZ`. Checked on every decision, not only on load. |
| `apps[].origin` | a bare `http(s)` origin. This is what "governed" means. |
| `apps[].private` | the app is not on the internet: `{host, port}` is where it answers on the mesh. |
| `apps[].deny` | any of `copy`, `paste`, `download`, `upload`, `print`, `capture`, `devtools`. Per app. |
| `apps[].watermark` | show the overlay and keep the window out of screen captures. |
| `apps[].audit` | also record each time the app is opened (blocks are always recorded). |

The schema is strict: an unknown field or an unknown `deny` word makes the whole policy
invalid. A newer policy that this browser cannot fully enforce must not be half-enforced.

## Signing

- The signature is Ed25519 over the bytes `aither-browser-policy/1\n` + the canonical form
  of the policy without `sig`.
- Canonical form: JSON with object keys sorted, no white space, arrays in order; only
  strings, integers, booleans and null (`canonical()` in `electron/browser-workspace-policy.cjs`).
- The browser verifies against **pinned** public keys (`PINNED_KEYS`, raw 32-byte keys in
  base64). `node:crypto` only; no new dependency.
- `signPolicy()` in the same file is the reference signer. Tests and the smoke use it with
  a throwaway key. **No private key is in this repository, and none may be added.**

## Where the policy comes from

1. A local signed file, `browser-workspace-policy.json` in userData.
2. `GET <platform>/v1/workspace/browser-policy` with the Online bearer. **The server route
   does not exist yet.** The client is implemented and treats `404` as "no policy"; any
   other failure keeps what the browser already has. A policy that arrives this way is
   verified exactly like the file and then written to the file for the next start. The
   bearer is only ever sent to the platform origin over https.

The valid candidate with the highest serial wins. The browser asks at start and every 15 minutes.

## What fails closed

`browser-workspace-policy-state.json` (userData) remembers the tenant, the highest serial
seen with the digest of the policy that carried it, and the origins that policy governed.

| what happened | result |
|---|---|
| the signature does not match a pinned key, or the file is not a policy | governed apps are refused |
| the serial is lower than one already seen (a rollback) | governed apps are refused |
| the same serial with different content | governed apps are refused |
| `not_after` has passed (checked live; a timer closes open tabs at that moment) | governed apps are refused |
| the policy file is gone while origins are governed | governed apps are refused |
| the policy is another tenant's | governed apps are refused |
| any error inside `decide()` | deny |
| no policy ever existed | nothing is governed; ordinary browsing |

"Refused" means: the navigation is stopped, the tab shows the dark "did not open" page with
the reason, the toolbar says so, an audit row is written, the door stops mapping the
private hosts and open tunnels are cut. Origins no good policy ever named are never touched.

## What is enforced on a governed origin

Rules are keyed on the page's **origin**, in every tab, whoever opened it.

| `deny` | what is blocked |
|---|---|
| `copy` | Ctrl+C / Ctrl+X / Ctrl+Insert / Shift+Delete; the right-click Copy, Cut, Copy link, Copy image and "Search the web for"; the page's own Copy buttons (the clipboard-write grant); the document's `copy`, `cut` and `dragstart` events, stopped in the isolated world |
| `paste` | Ctrl+V / Shift+Insert, the right-click Paste rows, the clipboard-read grant, the `paste` and `drop` events |
| `download` | every download (`will-download`), from the page or of a file on that origin; "Save image as" |
| `upload` | best effort: a click on a file input, a dropped or pasted file (see "Known gaps") |
| `print` | Ctrl+P, the menu's Print; a user style sheet blanks the page for `window.print()` |
| `capture` | "Save page as", Ctrl+S, "Ask about this page", translate, read aloud; the window is excluded from screen capture |
| `devtools` | F12 / Ctrl+Shift+I/J/C, Inspect; developer tools opened any other way are closed again |

Each block shows one short notice in the toolbar naming the workspace policy, and writes
one audit row. The desk's own commands (the palette, the tray's Browser menu, Alt+Space:
`browserCommand`) go through the same gate: `print` and `translate` answer with the reason
instead of `ok`, and "Open in Edge" is refused for every governed origin, because the app
would leave the managed browser.

Also, for every governed origin:

- **The work partition.** The owner's tab for a governed origin is built in
  `persist:aither-work-<tenant_id>`: its own cookies and storage, hardened like every other
  session, with no extension loaded. An ordinary tab that heads for a governed origin is
  stopped and a work tab opens instead.
- **Agents.** A governed tab cannot be shared with an agent or popped out of the window.
  An agent's own tab is refused a private app outright; on a public governed origin it is
  on the agent's session and has none of the work session's sign-ins.
- **Watermark** (`browser-watermark.cjs`). A frameless, transparent, click-through window
  that main owns sits over the page with the signed-in user, the workspace and the date. It
  is not page content: the page cannot read, restyle or remove it. While it shows, the
  browser window is excluded from screen capture (`setContentProtection`).
- **Audit** (`browser-audit.cjs`). `browser-audit.jsonl` in userData, append-only, one JSON
  object per line: `ts, tenant, origin, action, verdict, tab`. The origin only: never a
  path, a query, a title, a file name, page text or a credential. 1 MB per file, three
  rotated files kept.

## Private apps: the mesh door (no VPN)

`browser-mesh-door.cjs` is an HTTP proxy inside the main process.

- It listens on `127.0.0.1`, on a port the OS picks.
- It requires `Proxy-Authorization` with a credential made at random for each launch and
  held in memory. Another local process gets `407`.
- It accepts only a `host:port` the verified policy lists as private, asked again for every
  connection, and dials the mesh `host:port` the policy maps it to (`net.connect`). Any
  other target gets `403`, also with the credential.
- `CONNECT` (https, WebSocket) is a byte tunnel; an absolute-URI http request is forwarded
  with proxy and hop-by-hop headers removed.
- Every connection is audited (`mesh-connect`).

The work session gets a proxy script that sends the private hosts to the door **with no
DIRECT fallback** and everything else direct. The credential is handed over in the `login`
event, only when the request is the door asking, only to the work session, and only while
the policy is in force. The owner's ordinary session, the agent's session and InPrivate
never get the proxy script or the credential, so the private host does not exist for them.

## Not yet

- **Key custody.** Who holds the signing key, where (HSM, the platform vault), how it is
  rotated and how a key is revoked is undecided. Until then `PINNED_KEYS` is empty and the
  feature is inert on real desks. Pinning a key is a one-line change plus this decision.
- **The server route** `GET /v1/workspace/browser-policy` and a signer.
- **Device posture.** Nothing checks the device (disk encryption, OS version, the enrolled
  device key in `device-identity.cjs`) before a private app opens.
- **Step-up.** No re-authentication (passkey) before opening an app or lifting a block.
- **Audit upload.** `upload()` is a seam that sends nothing; rows stay on this computer.
- **An embedded mesh dialler.** The door dials with the operating system's network stack,
  so the mesh must already be reachable from this computer.
- **Binding the policy to the signed-in account.** The tenant is bound by the first good
  policy, not checked against who is signed in to AitherOS Online.

## Known gaps (not closed in this slice)

- **userData is the user's.** Someone who can write userData can delete the policy and
  state files. Private apps then become unreachable (the door needs a verified policy), but
  a *public* governed origin becomes an ordinary site. Closing that needs the server to
  refuse sessions that do not come from a managed browser (posture).
- **Another browser.** A public governed origin opens in any other browser, and in an
  InPrivate tab, without the work session's sign-in but also outside this policy's reach
  in the other browser. Same remedy as above.
- **Upload is best effort.** `showOpenFilePicker()`, `input.showPicker()` and a form built by
  script are not stopped.
- **Sub-frames.** The copy/paste guard runs in the main frame's isolated world. A
  cross-origin frame inside a governed page has no guard of its own (keyboard, menu and
  the clipboard grant are still blocked for the whole tab). `window.print()` called inside a
  frame prints that frame.
- **Screenshots by other means.** Content protection stops screen capture on Windows and
  macOS; it does nothing on Linux, and nothing stops a phone camera (the watermark is for that).
- **A popup of a governed app** opens in the work session but, on an ungoverned origin, is
  not governed; a page already popped out that later navigates to a governed origin is
  judged by origin for the deny list but has no watermark.
- **The page title and the address itself** (history, sync of open tabs, the tab strip)
  are not treated as page content.
- **Service workers and other requests with no page behind them** in the work session get
  no door credential.
- **The overlay's first moments.** The overlay window is built when a policy with a
  watermarked app comes into force and is kept ready; an app opened in the second or two
  before its document has loaded shows without it (the capture guard is already on).
- **The 1 px edge.** On a scaled display the overlay can sit one pixel off the page's edge.

## Files

| file | what |
|---|---|
| `electron/browser-workspace-policy.cjs` | the document, canonical form, verify, serial, expiry, `decide()`, `gate()`, the fetch seam |
| `electron/browser-workspace.cjs` | the electron half: the work session, the hooks `browser-window.cjs` calls, the overlay window |
| `electron/browser-mesh-door.cjs` | the loopback door and the proxy script |
| `electron/browser-watermark.cjs` | the overlay's text, document and rectangle |
| `electron/browser-audit.cjs` | the spool |
| `electron/browser-parity-workspace.cjs` | the live proof, called by `browser-parity-smoke.cjs` |
