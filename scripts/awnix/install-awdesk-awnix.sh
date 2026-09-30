#!/bin/sh
# install-awdesk-awnix.sh -- stage awdesk on the awnix fleet host and run it under WSLg.
#
#   sh install-awdesk-awnix.sh              # sync + npm ci (if the lockfile moved) + build + unit (installed, NOT started)
#   sh install-awdesk-awnix.sh --enable     # ... and enable + start it (the switch-over; see README.md)
#   sh install-awdesk-awnix.sh --brain      # ... and enable + start the HEADLESS fleet brain (48931)
#   sh install-awdesk-awnix.sh --self-test  # prove the staged files are well-formed; changes nothing
#
# Source: the repo copy this script sits in (SRC, default: two dirs up). Target:
# /opt/aitheros/awdesk on the distro's OWN disk -- never under /mnt/c (9p is slow for
# node_modules and C: runs near full) and never /var/lib/aither (the fleet-data
# attach bind-mounts over it at boot and hides whatever was written underneath;
# measured 2026-09-27, an npm ci there vanished after the distro restarted).
#
# Assets that are NOT in git (VRM characters, public/assets animations) come from
# the live Windows desk (ASSET_SRC, default /mnt/d/desk): the roster is SHARED by
# path (DESK_ROSTER_DIR) so both desks see one roster; animations are copied once.
#
# Exit 0 installed · 1 failed · 2 could not judge (not awnix/Linux, no npm).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
SRC="${AWDESK_SRC:-$(cd "$HERE/../.." && pwd)}"
DEST="${AWDESK_APP_DIR:-/opt/aitheros/awdesk}"
ASSET_SRC="${AWDESK_ASSET_SRC:-/mnt/d/desk}"
# /etc/sysconfig, NOT /etc/aither: the fleet-data attach bind-mounts /etc/aither
# (AITHER_FLEET_BIND_DIRS) and hides anything written underneath it -- the same
# trap as /var/lib/aither (measured 2026-09-27 when the distro booted without the
# fleet disk and a config written then would have vanished at the next attach).
ENV_FILE=/etc/sysconfig/aither-awdesk
ENABLE=0
BRAIN=0
SELFTEST=0

die()  { printf 'install-awdesk-awnix: %s\n' "$*" >&2; exit 1; }
dead() { printf 'install-awdesk-awnix: CANNOT JUDGE - %s\n' "$*" >&2; exit 2; }
say()  { printf '  %s\n' "$*"; }

for a in "$@"; do
    case "$a" in
        --enable) ENABLE=1 ;;
        --brain) BRAIN=1 ;;
        --self-test) SELFTEST=1 ;;
        *) die "unknown argument: $a" ;;
    esac
done

if [ "$SELFTEST" = 1 ]; then
    fail=0
    for f in awdesk-awnix-launch.sh awdesk-awnix-open.sh install-awdesk-awnix.sh; do
        sh -n "$HERE/$f" || { echo "FAIL syntax $f"; fail=1; }
        grep -q "$(printf '\r')" "$HERE/$f" && { echo "FAIL CR byte in $f"; fail=1; }
    done
    grep -q '^ExecStart=/bin/sh /opt/aitheros/awdesk/scripts/awnix/awdesk-awnix-launch.sh' "$HERE/aither-awdesk.service" \
        || { echo "FAIL unit ExecStart does not point at the staged launcher"; fail=1; }
    grep -q '^Environment=HOME=/root' "$HERE/aither-awdesk.service"         || { echo "FAIL unit has no HOME: taskbar launches would start a second desk"; fail=1; }
    grep -q '^ExecStart=/opt/aitheros/awdesk/node_modules/electron/dist/electron /opt/aitheros/awdesk/electron/brain.cjs' "$HERE/aither-awdesk-brain.service"         || { echo "FAIL brain unit ExecStart drifted from electron/brain.cjs"; fail=1; }
    grep -q '^RestartPreventExitStatus=2' "$HERE/aither-awdesk.service" \
        || { echo "FAIL unit would crash-loop on a missing display (exit 2)"; fail=1; }
    grep -q '^Exec=/bin/sh /opt/aitheros/awdesk/scripts/awnix/awdesk-awnix-open.sh' "$HERE/aither-awdesk.desktop" \
        || { echo "FAIL .desktop Exec drifted from the open script"; fail=1; }
    [ "$fail" = 0 ] && echo "self-test OK" && exit 0
    exit 1
fi

[ "$(uname -s)" = Linux ] || dead "run inside the awnix distro (wsl -d awnix -u root sh $0)"
command -v npm >/dev/null 2>&1 || dead "npm not found (dnf install nodejs npm)"
command -v rsync >/dev/null 2>&1 || dead "rsync not found (dnf install rsync)"
[ -f "$SRC/package-lock.json" ] || dead "no awdesk source at $SRC"

say "sync $SRC -> $DEST"
mkdir -p "$DEST"
rsync -a --delete \
    --exclude node_modules --exclude dist --exclude release --exclude 'native/bin' \
    --exclude characters --exclude 'public/assets' --exclude '.active-character' \
    --exclude '.recent-characters' \
    "$SRC/" "$DEST/"
find "$DEST/scripts/awnix" -type f -exec sed -i 's/\r$//' {} +

cd "$DEST"
LOCK_SUM=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ ! -x node_modules/electron/dist/electron ] || [ "$(cat node_modules/.awnix-lock 2>/dev/null)" != "$LOCK_SUM" ]; then
    say "npm ci (lockfile changed or first install)"
    npm ci --no-audit --no-fund --loglevel=error
    echo "$LOCK_SUM" > node_modules/.awnix-lock
fi
say "renderer build"
npm run build >/dev/null
[ -f dist/index.html ] || die "vite build produced no dist/index.html"

if [ -d "$ASSET_SRC/public/assets" ]; then
    say "animations $ASSET_SRC/public/assets -> $DEST/public/assets"
    mkdir -p public/assets
    rsync -a "$ASSET_SRC/public/assets/" public/assets/
fi
mkdir -p /etc/sysconfig
if [ ! -f "$ENV_FILE" ]; then
    {
        echo "# aither-awdesk.service overrides (written by install-awdesk-awnix.sh)"
        [ -d "$ASSET_SRC/characters" ] && echo "DESK_ROSTER_DIR=$ASSET_SRC/characters"
        echo "#DESK_BRIDGE_PORT=47931   # after the switch-over from the Windows desk"
    } > "$ENV_FILE"
fi
[ -f "$ASSET_SRC/.active-character" ] && cp "$ASSET_SRC/.active-character" "$DEST/.active-character"

say "unit + launcher"
install -m 0644 scripts/awnix/aither-awdesk.service /etc/systemd/system/aither-awdesk.service
install -m 0644 scripts/awnix/aither-awdesk-brain.service /etc/systemd/system/aither-awdesk-brain.service
install -m 0644 scripts/awnix/aither-awdesk.desktop /usr/share/applications/aither-awdesk.desktop
systemctl daemon-reload
# Installed, not enabled, unless asked: while the Windows desk (D:\desk) runs, a
# second desk here would poll the same decision queue and pop every card twice, and
# its windows ride WSLg RAIL, which measured unstable on 2026-09-27 (msrdc exited
# 30x in 3 min and weston took SIGSEGV once the desk's windows mapped).
if [ "$ENABLE" = 1 ]; then
    [ -d /mnt/wslg ] || dead "--enable asked on a host with no /mnt/wslg (headless)"
    systemctl enable aither-awdesk.service >/dev/null 2>&1
    systemctl restart aither-awdesk.service
    sleep 8
    systemctl is-active --quiet aither-awdesk.service || { journalctl -u aither-awdesk -n 30 --no-pager; die "unit did not stay up"; }
    say "aither-awdesk.service enabled + active"
else
    say "unit installed, not enabled (pass --enable to switch over)"
fi

if [ "$BRAIN" = 1 ]; then
    # The bearer the Windows desk sends lives in the WINDOWS profile; point the
    # brain at it (exactly one profile with a token, or none -> reads only).
    if [ ! -f /etc/sysconfig/aither-awdesk-brain ]; then
        # shellcheck disable=SC2012
        n=$(ls /mnt/c/Users/*/.aither/harness_token 2>/dev/null | wc -l)
        if [ "$n" = 1 ]; then
            echo "AWDESK_BRIDGE_TOKEN_FILE=$(ls /mnt/c/Users/*/.aither/harness_token)" > /etc/sysconfig/aither-awdesk-brain
        else
            echo "# no unique Windows harness_token found ($n); mutations answer 503" > /etc/sysconfig/aither-awdesk-brain
        fi
    fi
    systemctl enable aither-awdesk-brain.service >/dev/null 2>&1
    systemctl restart aither-awdesk-brain.service
    i=0
    until curl -fsS -m 3 http://127.0.0.1:48931/health >/dev/null 2>&1; do
        i=$((i + 1))
        [ "$i" -ge 30 ] && { journalctl -u aither-awdesk-brain -n 30 --no-pager; die "brain did not answer /health on 48931"; }
        sleep 1
    done
    say "aither-awdesk-brain.service enabled + answering on 127.0.0.1:48931"
fi
