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
| `not_after` | UTC, `YYYY-MM-DDTHH:MM:SSZ`. Checked on every decision, not only on load. **Keep it short** (days, not months): it is the bound on how long a desk that cannot reach the platform keeps enforcing an old policy. |
| `apps[].origin` | a bare `http(s)` origin. This is what "governed" means. |
| `apps[].private` | the app is not on the internet: `{host, port}` is where it answers on the mesh. An IP literal is preferred (nothing to resolve). Loopback, `localhost`, link-local (`169.254/16`, `fe80::/10`), the unspecified address, multicast and anything that looks like an address and is not one are refused, and the door checks the address it really connected to as well. |
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

**Private apps need the platform, in this launch.** The serial state is a file in userData:
whoever can delete it can put back an older signed policy, and the file cannot tell. So the
local file alone never opens a private app. `privateTarget()` answers only after the
platform has sent, since this launch started, a policy that verifies and whose serial is at
or above the one in force. Nothing on disk says "confirmed". A desk that has never reached
the platform, or is offline at start, enforces the local policy on public apps and has no
private access. (Because the route does not exist yet, that is every real desk today.)

**The tenant must be the account's.** One pinned key signs every workspace's policy, so a
policy applies only when its `tenant_id` equals the workspace id of the account signed in to
AitherOS Online (`/auth/me` `tenant_id`, compared without case). Signed out or not known:
the check is not applied, and the first-policy binding below still is.

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
| the policy is another tenant's than the one first bound, or than the signed-in account's | governed apps are refused |
| the clock is more than 5 minutes behind the latest time this browser has seen (persisted) | governed apps are refused; a good policy from the platform resets that time |
| the app was started with a remote-debugging switch, `DESK_CDP_PORT`, or a live Node inspector | governed apps are refused and the door is not started (see below) |
| a private app, and the platform has not confirmed the policy in this launch | that app is refused |
| any error inside `decide()` | deny |
| no policy ever existed | nothing is governed; ordinary browsing |

"Refused" means: the navigation is stopped, the tab shows the dark "did not open" page with
the reason, the toolbar says so, an audit row is written, the door stops mapping the
private hosts and open tunnels are cut. Origins no good policy ever named are never touched.

**Remote debugging.** The DevTools protocol reads every page, takes screenshots and runs
script in any tab, which undoes every rule here. `debugDoor()` looks for
`--remote-debugging-port/-pipe/-address`, `DESK_CDP_PORT` and a Node inspector. When one is
present and a policy exists, governed origins are refused with a page that names it, and
the mesh door is never started. A desk with no workspace policy keeps its CDP door exactly
as before (perf-gate, cdp-probe).

## What is enforced on a governed origin

Rules are keyed on the page's **origin**, in every tab, whoever opened it.

| `deny` | what is blocked |
|---|---|
| `copy` | Ctrl+C / Ctrl+X / Ctrl+Insert / Shift+Delete; the right-click Copy, Cut, Copy link, Copy image and "Search the web for"; the page's own Copy buttons (the clipboard-write grant); the document's `copy`, `cut` and `dragstart` events, stopped in the isolated world; the **selection** read for the side panel's notes, "remember" and read aloud |
| `paste` | Ctrl+V / Shift+Insert, the right-click Paste rows, the clipboard-read grant, the `paste` and `drop` events |
| `download` | every download (`will-download`), from the page or of a file on that origin; "Save image as" |
| `upload` | best effort: a click on a file input, a dropped or pasted file (see "Known gaps") |
| `print` | Ctrl+P, the menu's Print; a user style sheet blanks the page for `window.print()` |
| `capture` | "Save page as", Ctrl+S, every read of the page for someone else ("Ask about this page", an agent's read / snapshot / screenshot tools), translate, read aloud; the window is excluded from screen capture |
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
  An agent's tab is refused EVERY governed origin, public or private, whichever session it
  rides, in force or not; and a read or a screenshot of a governed page is refused for any
  caller when the app forbids capture.
- **Requests.** In every browser session the request hook cancels a request for a private
  app's host unless the page it belongs to is a governed app in force (or it is the page
  itself, which the gate judges). An ungoverned page that is in the work session -- a link
  out of the app -- can neither fetch nor frame a private app.
- **Watermark** (`browser-watermark.cjs`). A frameless, transparent, click-through window
  that main owns sits over the page with the signed-in user, the workspace and the date. It
  is not page content: the page cannot read, restyle or remove it. While it shows, the
  browser window is excluded from screen capture (`setContentProtection`).
- **Audit** (`browser-audit.cjs`). `browser-audit.jsonl` in userData, append-only, one JSON
  object per line: `ts, tenant, origin, action, verdict, tab`. The origin only: never a
  path, a query, a title, a file name, page text or a credential. 1 MB per file, three
  rotated files kept. Rows are queued and written together a quarter of a second later, not
  on the caller's path; the same kind of row is written at most 20 times in 10 seconds and
  the rest are counted, so one noisy source cannot rotate the others out.

## Private apps: the mesh door (no VPN)

`browser-mesh-door.cjs` is an HTTP proxy inside the main process.

- It listens on `127.0.0.1`, on a port the OS picks.
- It requires `Proxy-Authorization` with a credential made at random for each launch and
  held in memory. Another local process gets `407`; that is counted in memory and never
  written to the audit spool.
- It has a connection cap (128), five seconds for a client to send its request head, and a
  response is closed, not left hanging, when the mesh peer goes away mid-answer.
- It never dials loopback, link-local or the unspecified address, judged on the address the
  socket actually reached (so a name that resolves there is refused too).
- It accepts only a `host:port` the verified policy lists as private, asked again for every
  connection, and dials the mesh `host:port` the policy maps it to (`net.connect`). Any
  other target gets `403`, also with the credential.
- `CONNECT` (https, WebSocket) is a byte tunnel; an absolute-URI http request is forwarded
  with proxy and hop-by-hop headers removed.
- Every connection is audited (`mesh-connect`).

The work session gets a proxy script that sends the private hosts to the door **with no
DIRECT fallback** and everything else direct. The hosts are a list looked up by value, with
a trailing dot removed first. When the policy goes out of force the script is NOT replaced
by "direct": every host that is or last was a private app (remembered in the state file)
stays pointed at the door, which answers 403; with no door (remote debugging) it points at
a closed port. The credential is handed over in the `login` event, only when the request is
the door asking, only to the work session, and only while private apps may be reached (the
policy in force and confirmed). The owner's ordinary session, the agent's session and InPrivate
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
- **SSO hosts in the policy.** A work tab may still navigate to an origin the policy does
  not name (a sign-in redirect needs that). Such a page gets nothing from a private app
  (see "Requests"), but it does sit in the work session. Listing the allowed sign-in hosts
  in the policy and moving every other top-level navigation out to the ordinary session
  needs a schema change and is not done.

## Known gaps (not closed in this slice)

- **userData is the user's.** Someone who can write userData can delete the policy and
  state files. Private apps then stay closed (they need the platform's confirmation in this
  launch), but a *public* governed origin becomes an ordinary site, and with the state file
  gone an older signed policy with a weaker deny list is accepted for public apps until the
  platform answers. Closing that needs the server to refuse sessions that do not come from
  a managed browser (posture).
- **Offline is not private access.** By design: no platform answer in this launch, no
  private app. There is no grace period.
- **Tenant binding needs a sign-in.** Signed out, or when `/auth/me` does not answer, the
  account's workspace is not known and only the first-policy binding applies.
- **Remote debugging is read at launch.** A debugger attached to the process by other means
  (an OS debugger, an injected DLL) is outside what the browser can see.
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
