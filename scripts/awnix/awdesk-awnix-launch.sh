#!/bin/sh
# awdesk-awnix-launch.sh -- run awdesk INSIDE the awnix fleet host, drawn on the
# Windows desktop by WSLg (each Electron window is a RAIL window: its own Windows
# taskbar button, alt-tab entry and Start-menu launcher).
#
# ExecStart of aither-awdesk.service. Also runnable by hand:
#   wsl -d awnix -u root sh /opt/aitheros/awdesk/scripts/awnix/awdesk-awnix-launch.sh
#
# Exit 0 on a clean app exit, 1 on a failed launch, 2 could-not-judge (no WSLg
# display, no install). systemd restarts on failure; a missing display is exit 2
# with the reason on stderr so `systemctl status` says WHY rather than looping on a
# segfault from an Electron with no display.
set -eu

APP_DIR="${AWDESK_APP_DIR:-/opt/aitheros/awdesk}"
ELECTRON="$APP_DIR/node_modules/electron/dist/electron"
WAIT_S="${AWDESK_DISPLAY_WAIT_S:-90}"

dead() { printf 'awdesk-awnix: CANNOT JUDGE - %s\n' "$*" >&2; exit 2; }

[ -x "$ELECTRON" ] || dead "no electron at $ELECTRON (run awdesk-awnix-sync.sh first)"
[ -f "$APP_DIR/dist/index.html" ] || dead "no renderer build at $APP_DIR/dist (run awdesk-awnix-sync.sh)"

# WSLg publishes its X socket under /mnt/wslg/.X11-unix and links /tmp/.X11-unix to
# it. awnix mounts a tmpfs on /tmp (systemd tmp.mount), which can land AFTER WSLg
# and hide the link: measured 2026-09-27 the socket was present, but the order is
# not guaranteed at boot, so re-expose it rather than failing.
i=0
while [ ! -S /mnt/wslg/.X11-unix/X0 ]; do
    i=$((i + 1))
    [ "$i" -ge "$WAIT_S" ] && dead "WSLg X socket /mnt/wslg/.X11-unix/X0 never appeared (${WAIT_S}s) -- is guiApplications=false in .wslconfig?"
    sleep 1
done
if [ ! -S /tmp/.X11-unix/X0 ]; then
    mkdir -p /tmp/.X11-unix
    mount --bind /mnt/wslg/.X11-unix /tmp/.X11-unix 2>/dev/null \
        || ln -sf /mnt/wslg/.X11-unix/X0 /tmp/.X11-unix/X0
fi

# Same HOME as the unit, so a hand/taskbar launch finds the running desk's
# SingletonLock and hands off instead of starting a second desk.
export HOME="${HOME:-/root}"
[ "$HOME" = / ] && export HOME=/root
export DISPLAY="${DISPLAY:-:0}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/mnt/wslg/runtime-dir}"
[ -d "$XDG_RUNTIME_DIR" ] || export XDG_RUNTIME_DIR=/mnt/wslg/runtime-dir
export PULSE_SERVER="${PULSE_SERVER:-unix:/mnt/wslg/PulseServer}"
# The desk is ON the fleet host: fleet verbs run here, never through wsl.exe.
export AWDESK_FLEET_LOCAL=1
export AWDESK_PYTHON="${AWDESK_PYTHON:-python3}"
# 47931 belongs to the Windows-side desk while it runs (WSL's localhost relay
# cannot forward a port Windows already listens on) and 48931 to the headless
# brain; the full desk takes 47951. Switch-over (stop the Windows desk, set 47931)
# is in the README.
export DESK_BRIDGE_PORT="${DESK_BRIDGE_PORT:-47951}"
export ELECTRON_DISABLE_SECURITY_WARNINGS=1

cd "$APP_DIR"
# --no-sandbox: root cannot use the Chromium setuid sandbox, and the unit runs as
#   root because the fleet verbs need rootful podman.
# --ozone-platform=x11: Xwayland under WSLg honours transparent + always-on-top for
#   RAIL windows; the native Wayland path drops always-on-top (no xdg protocol for it).
exec "$ELECTRON" --no-sandbox --ozone-platform=x11 \
    --enable-transparent-visuals --disable-gpu-sandbox \
    . "$@"
