# awdesk and AitherDesktop on the awnix fleet host (WSLg)

The fleet host `awnix` (WSL2, systemd PID 1) has WSLg: a Linux GUI window becomes a
native Windows window with its own taskbar button. These files run the desk FROM the
fleet host and keep the Windows-native desk (`D:\desk`) as the primary until you switch.

| file | what it is |
|---|---|
| `install-awdesk-awnix.sh` | stage to `/opt/aitheros/awdesk`, `npm ci` when the lockfile moves, build, install unit + `.desktop`. `--enable` switches over; `--self-test` checks the files |
| `awdesk-awnix-launch.sh` | `ExecStart`: waits for the WSLg X socket, sets the display/audio env, `AWDESK_FLEET_LOCAL=1`, runs Electron (`--no-sandbox --ozone-platform=x11`) |
| `aither-awdesk-brain.service` | **the fleet brain (ENABLED)**: headless `electron/brain.cjs` under `ELECTRON_RUN_AS_NODE=1`. It runs the bridge and MCP on **48931** and executes fleet verbs on the host. No window, display, cards or WSLg. Env file: `/etc/sysconfig/aither-awdesk-brain` |
| `aither-awdesk.service` | the full desk under WSLg (installed, NOT enabled); `HOME=/root`, bridge on 47951, `Conflicts=` the brain, `RestartPreventExitStatus=2`, capped at 4 GB / CPUWeight 50 |
| `awdesk-awnix-open.sh` | what the launcher runs: starts the unit, hands a surface (`--fleet` by default) to the running desk |
| `aither-awdesk.desktop` | WSLg mirrors it into Start > `awnix` > "AitherOS Desk (awnix)" by itself |
| `Install-AwdeskAwnixShortcut.ps1` | the explicit Start-menu `.lnk` (targets `wslg.exe`, so no console) you pin to the taskbar |
| `Publish-DesktopState.ps1` | Windows half of the desktop sync: window list, focus, taskbar set to `%USERPROFILE%\.aither\desktop-state.json` (awnix reads `/mnt/c/...`) |
| `aitherdesktop-awnix.sh` | AitherDesktop (PyQt6) in a python3.11 venv at `/opt/aitheros/aitherdesktop`; `--install`, `--smoke`, run |

```sh
wsl -d awnix -u root sh /mnt/c/AitherOS-Fresh/.DEPLOYMENT/awdesk/scripts/awnix/install-awdesk-awnix.sh --brain
pwsh -File .DEPLOYMENT/awdesk/scripts/awnix/Install-AwdeskAwnixShortcut.ps1
```

## Measured 2026-09-27

- **Works:** Electron 39 starts under WSLg as a unit. The Windows side reaches the
  bridge through WSL localhost forwarding (`/health` on its bridge port -> 200).
  `xwininfo` lists the `Desk` and `Aither Fleet` windows. A second launch hands off to
  the running desk through the single-instance lock. The Fleet verbs run in-host with
  no `wsl.exe` hop.
- **Does not work well:** as soon as the desk's transparent, always-on-top windows
  mapped, the WSLg RDP client (`msrdc.exe`) exited and was relaunched about 30 times
  in 3 minutes, and weston took a SIGSEGV once. The Windows-native desk never saw this.
  EL9 mesa ships no `d3d12` driver, so WebGL falls back to software (SwiftShader). The
  3D avatar costs roughly 0.2 to 0.6 of a core that the fleet needs.
- **Not possible through WSLg:** the RAIL protocol has no click-through input shape and
  no per-pixel alpha for a Windows-desktop overlay, and it does not carry
  always-on-top. Global hotkeys (`Win+A`) never reach a Linux client.

**Chosen split (the fleet brain):** the Living Desktop overlay, the avatar and the
decision cards stay on the Windows-native desk (`D:\desk`, bridge 47931). The fleet
brain moves to awnix. The Windows desk's `FleetControl` sends every fleet verb
(`GET /fleet/status`, `POST /fleet/<verb>` with the harness bearer) to
`http://127.0.0.1:48931` first, and the verdict comes back tagged `via: "brain"`. The
Windows desk still adds the Windows-only VRAM holders and surface probes to that
verdict. If the brain cannot be reached (connection refused, or a config refusal such
as 401/404/503-without-verdict), the verb runs through the old `wsl.exe` hop and is
tagged `via: "local", brain_error: ...`.

- A mutating verb that reached the brain and then timed out is never re-run locally,
  because it may still be running on awnix.
- `awmodels` verbs stay on the host.
- `AWDESK_FLEET_BRAIN_URL=off` disables the brain route. Any other URL overrides the
  default.
- The brain reads the Windows profile's `harness_token` through
  `AWDESK_BRIDGE_TOKEN_FILE`. It lives in `/etc/sysconfig`, not `/etc/aither`, because
  the fleet-data attach bind-mounts over `/etc/aither` and `/var/lib/aither`.

Port 48931, not 4794x: `game_bridge serve` scans 47940 to 47949 and took 47941 on the
Windows side, which the WSL relay then could not forward.

Measured 2026-09-27:

- Windows desk `/fleet/status` and MCP `fleet_status` both came back `via=brain`
  (146 containers).
- With the brain stopped, they came back `via=local` with
  `brain_error=ECONNREFUSED ...`, and with the brain restarted, `via=brain` again.
- Without a bearer, `POST /fleet/adopt` on the brain returns 401.

## Switch-over (only when you want the awnix desk to be THE desk)

1. Quit the Windows desk (tray > Quit), which frees 47931.
2. Put `DESK_BRIDGE_PORT=47931` in `/etc/sysconfig/aither-awdesk`.
3. `systemctl disable --now aither-awdesk-brain` (the full desk conflicts with it), then
   `sh install-awdesk-awnix.sh --enable`. The Claude `desk` MCP bridge
   (`--upstream http://127.0.0.1:47931/mcp`) then reaches awnix through localhost
   forwarding without any change.

To switch back, run `systemctl disable --now aither-awdesk` and start `D:\desk\desk-start.cmd`.
