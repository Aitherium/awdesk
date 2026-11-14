# Protected video and music in the Aither Browser (Widevine)

Netflix, Spotify, Disney+ and the like encrypt their streams with Google's Widevine DRM.
Stock Electron ships no Widevine, so those players stayed black and the browser sent the
owner to Edge. Aither now builds on castLabs' **Electron for Content Security** (ECS): the
same Electron, plus a component updater that installs the Widevine CDM into userData.

## What changed

| piece | where |
|---|---|
| Electron dependency | `package.json`: `git+https://github.com/castlabs/electron-releases.git#v39.8.10+wvcus` |
| Packaging download | `build.electronDownload.mirror`: electron-builder fetches the castLabs zip |
| CDM install | `electron/browser-widevine.cjs`: the only module that touches `components`; `main.cjs` starts it at app ready |
| Edge hand-off | still there, shown ONLY when Widevine is missing or failed (`drmNotice`) |
| Status | the more-menu line "Protected video and music: ..."; `state().widevine` |
| Permission | `browser-policy.cjs` grants `mediaKeySystem` to the owner's session only |
| macOS | `build/entitlements.mac.plist`: `disable-library-validation` (the CDM is Google's library) |
| VMP signing | `scripts/vmp-sign.cjs`, an electron-builder hook, off unless `AITHER_VMP_SIGN=1` |

On stock Electron (`components` is undefined) nothing throws: the state is `missing` and
the Edge notice is the fallback, exactly as before.

## Measured (2026-11-13, Windows 11, Electron 39.8.10, Chromium 142)

`requestMediaKeySystemAccess("com.widevine.alpha")` in a browser tab (partition
`persist:aither-browser`, sandbox on, no preload):

| build | result |
|---|---|
| stock Electron 39.8.10 | rejected: `NotSupportedError: Unsupported keySystem or supportedConfigurations` |
| castLabs 39.8.10+wvcus, before the CDM is installed | rejected, same error |
| castLabs, after `components.whenReady()` | granted, in the already-open tab, without a reload |

- `components.whenReady()` resolved in 0.7 to 1.6 s on a fresh profile (network needed once;
  later runs use the installed CDM and check for updates in the background).
- `components.status()` afterwards: Widevine Content Decryption Module `4.10.3112.0`
  `updated`; Google Widevine Windows CDM `1.0.2738.0` `updated`.
- A real encrypted stream (Shaka's public Widevine asset) decodes in the tab: clock
  advances, frames are drawn, `mediaKeys` is set. `npm run test:browser-widevine`.
- The `mediaKeySystem` permission did not change any of the above in these probes (deny
  and allow gave the same answers). It is granted to the owner's session because a service
  may ask for the protected-media identifier; the agent's session and InPrivate stay
  deny-all. The Widevine key system itself is process-wide: an agent tab can also decode.

## VMP: what plays unsigned, what needs signing

Widevine license servers can ask the CDM whether the platform is verified (VMP, Verified
Media Path). The answer depends on a signature over the Electron binary.

| build | VMP status (castLabs VMP Lab, UAT) | what plays |
|---|---|---|
| `npm run dev` / `npm start` (castLabs binary as shipped, development signature) | `PLATFORM_SECURE_STORAGE_SOFTWARE_VERIFIED` | license servers that accept development clients or do not check VMP. Production services that verify the platform refuse a development signature. |
| packaged, NOT EVS-signed (renamed to `Desk.exe`, fuses flipped: simulated) | `PLATFORM_TAMPERED` | servers that do not check VMP (the Shaka test stream still played). Netflix and other services that require VMP will refuse. |
| packaged and EVS-signed | expected `PLATFORM_SOFTWARE_VERIFIED` (not measured: needs an EVS account) | production services |
| Linux, any build | `PLATFORM_UNVERIFIED` by design (castLabs: Widevine on Linux has no VMP) | services that do not require VMP; a first-time CDM install needs one restart |

Not measured here: playback on netflix.com, spotify.com or disneyplus.com themselves. That
needs the owner's accounts and, for the services that check VMP, a production-signed build.

## Production signing (owner, once; then CI)

castLabs signs for free through EVS. It needs an EVS **account** (an e-mail address, a
name, an organization). Nobody but the owner creates it.

1. Once, on any machine:
   ```
   python -m pip install --upgrade castlabs-evs
   python -m castlabs_evs.account signup
   ```
   It asks for e-mail, name, organization, account name and password, then a confirmation
   code sent to that e-mail.
2. Local signed build (Windows shown; macOS is the same with `dist:mac`):
   ```
   set AITHER_VMP_SIGN=1
   set EVS_ACCOUNT_NAME=<account name>
   set EVS_PASSWD=<password>
   npm run dist:windows
   ```
   The hook runs `python -m castlabs_evs.vmp --no-ask sign-pkg --name-hint Desk release/win-unpacked`
   and the build fails if signing fails. Check a build afterwards:
   `node scripts/vmp-sign.cjs --verify release/win-unpacked Desk` (exit 0 valid, 1 invalid).
3. CI: add the repository secrets `EVS_ACCOUNT_NAME` and `EVS_PASSWD`. `release.yaml`
   turns signing on only when both exist. The monorepo's `build-awdesk.yml`, which publishes
   the `v*` releases, needs the same two secrets and `AITHER_VMP_SIGN=1`.

Order matters and the hook follows it: macOS signs BEFORE code-signing (in `afterPack`,
after flipping the fuses itself, because the fuses live in the signed binary); Windows
signs AFTER everything that edits `Desk.exe` (in `afterSign`, which runs with or without a
certificate). EVS asks for `streaming` signatures; that is the default the hook uses.

## Upgrading Electron

Pick the castLabs tag for the new version (`vX.Y.Z+wvcus`,
https://github.com/castlabs/electron-releases/releases), change the tag in `package.json`
and the `allowScripts` key, run `npm install --package-lock-only`, then
`npm run test:browser-widevine`. castLabs follows upstream releases, usually within days;
a security update waits on their tag.
