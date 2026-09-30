#!/bin/sh
# aitherdesktop-awnix.sh -- AitherDesktop (the PyQt6 overlay, AitherOS/apps/AitherDesktop)
# on the awnix fleet host under WSLg.
#
#   sh aitherdesktop-awnix.sh --install    # venv at /opt/aitheros/aitherdesktop (python3.11) + deps
#   sh aitherdesktop-awnix.sh              # run it (xcb, so WSLg draws it as RAIL windows)
#   sh aitherdesktop-awnix.sh --smoke      # offscreen 20 s liveness check, no window
#
# Measured 2026-09-27: python3 on awnix is 3.9 (the package needs >=3.10) -> 3.11.
# pynput is NOT installed: it builds evdev from source on Linux, and a global hotkey
# (Win+A) cannot be grabbed from inside WSLg anyway -- keys reach a Linux window only
# while it has focus. The app registers pynput as OPTIONAL and runs without it.
# QtWebEngine as root needs QTWEBENGINE_DISABLE_SANDBOX=1 (Chromium refuses root).
#
# Exit 0 ok · 1 failed · 2 could not judge (no python3.11 / no source / no display).
set -eu
D="${AITHERDESKTOP_DIR:-/opt/aitheros/aitherdesktop}"
SRC="${AITHERDESKTOP_SRC:-/mnt/c/AitherOS-Fresh/AitherOS/apps/AitherDesktop}"
PY="$D/venv/bin/python"
dead() { printf 'aitherdesktop-awnix: CANNOT JUDGE - %s\n' "$*" >&2; exit 2; }

export QTWEBENGINE_DISABLE_SANDBOX=1

case "${1:-run}" in
--install)
    command -v python3.11 >/dev/null 2>&1 || dead "python3.11 missing (dnf install python3.11)"
    [ -f "$SRC/pyproject.toml" ] || dead "no AitherDesktop source at $SRC"
    mkdir -p "$D"
    rsync -a --delete --exclude web --exclude installer --exclude atomic "$SRC/" "$D/src-tree/"
    [ -x "$PY" ] || python3.11 -m venv "$D/venv"
    "$D/venv/bin/pip" install -q --upgrade pip
    "$D/venv/bin/pip" install -q "PyQt6>=6.5.0" "PyQt6-WebEngine>=6.5.0" "aiohttp>=3.8.0" \
        "watchdog>=3.0.0" "pyyaml>=6.0" "httpx>=0.25.0"
    "$D/venv/bin/pip" install -q --no-deps -e "$D/src-tree"
    "$PY" -c "import PyQt6.QtWebEngineWidgets, aither_desktop" || exit 1
    echo "installed: $D"
    ;;
--smoke)
    [ -x "$PY" ] || dead "not installed (run --install)"
    rc=0
    QT_QPA_PLATFORM=offscreen timeout 20 "$PY" -m aither_desktop >"$D/smoke.log" 2>&1 || rc=$?
    # 124 = still running when the timer fired = it came up and stayed up.
    [ "$rc" = 124 ] && { echo "smoke OK (alive at 20 s)"; exit 0; }
    tail -20 "$D/smoke.log" >&2; exit 1
    ;;
run)
    [ -x "$PY" ] || dead "not installed (run --install)"
    [ -S /mnt/wslg/.X11-unix/X0 ] || dead "no WSLg display"
    export DISPLAY="${DISPLAY:-:0}" QT_QPA_PLATFORM=xcb HOME="${HOME:-/root}"
    exec "$PY" -m aither_desktop
    ;;
*) echo "usage: $0 [--install|--smoke]" >&2; exit 1 ;;
esac
