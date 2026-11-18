#!/usr/bin/env bash
# Invoked in a disposable CI HOME and private D-Bus session. No production settings.
set -euxo pipefail
mode=$1
out=$2
rendering=$3
export IME_SESSION="$mode"
mkdir -p "$out"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do
    for _ in {1..20}; do kill -0 "$pid" 2>/dev/null || break; sleep .1; done
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT
export DISPLAY=:99
Xvfb "$DISPLAY" -screen 0 1280x900x24 >"$out/xvfb.log" 2>&1 & pids+=("$!")
for _ in {1..50}; do xdpyinfo >/dev/null 2>&1 && break; sleep .2; done
export XDG_RUNTIME_DIR="$HOME/runtime"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
export LIBGL_ALWAYS_SOFTWARE=1
# GNOME owns IBus source selection; register actual engines before Shell starts.
gsettings set org.gnome.desktop.input-sources sources "[('ibus', 'libpinyin')]"
# These engines initially use Latin mode; use their actual CJK modes in this HOME.
gsettings set org.freedesktop.ibus.engine.anthy.common input-mode 0
gsettings set org.freedesktop.ibus.engine.hangul initial-input-mode hangul
# Use one explicitly addressed bus for Shell, GTK, the XIM bridge and the CLI.
# `ibus list-engine` only lists installed engines; it does not prove a live bus.
export IBUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/ibus"
ibus-daemon --address="$IBUS_ADDRESS" --xim --panel disable >"$out/ibus.log" 2>&1 & pids+=("$!")
for _ in {1..100}; do
  if python3 -c 'import gi; gi.require_version("IBus", "1.0"); from gi.repository import IBus; raise SystemExit(0 if IBus.Bus.new().is_connected() else 1)'; then break; fi
  sleep .2
done
python3 -c 'import gi; gi.require_version("IBus", "1.0"); from gi.repository import IBus; assert IBus.Bus.new().is_connected()'
if [ "$mode" = wayland ]; then
  # A real GNOME compositor nested in Xvfb; screenshots sample its host surface.
  gnome-shell --nested --wayland >"$out/gnome.log" 2>&1 & gnome_pid=$!; pids+=("$gnome_pid")
  export WAYLAND_DISPLAY=wayland-0 GDK_BACKEND=wayland
  for _ in {1..100}; do [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && break; sleep .2; done
  test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
elif [ "$mode" = x11 ]; then
  gnome-shell --x11 >"$out/gnome.log" 2>&1 & gnome_pid=$!; pids+=("$gnome_pid")
fi
if [ "$mode" != wayland ]; then export GDK_BACKEND=x11; fi
if [ "$mode" != bare ]; then
  for _ in {1..100}; do
    grep -q 'GNOME Shell started' "$out/gnome.log" && break
    kill -0 "$gnome_pid"
    sleep .2
  done
  grep -q 'GNOME Shell started' "$out/gnome.log"
  kill -0 "$gnome_pid"
  # Close the initial overview before any engine-backed application gets focus.
  xdotool key Escape Escape
fi
case "$rendering" in
  disabled) export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 ;;
  compositing-off) export WEBKIT_DISABLE_COMPOSITING_MODE=1 ;;
  dmabuf-off) export WEBKIT_DISABLE_DMABUF_RENDERER=1 ;;
esac
{ env | sort | grep -E '^(LANG|LC_|DISPLAY|WAYLAND|GDK_|GTK_|XMODIFIERS|WEBKIT_|LIBGL_)' || true; glxinfo -B; } >"$out/rendering.txt" 2>&1
ibus list-engine >"$out/engines.txt"
ibus address >"$out/ibus-address.txt"
export XMODIFIERS=@im=ibus
for language in zh ja ko; do
  case "$language" in
    zh) locale=zh_CN.UTF-8; engine=libpinyin; keys='nihao ' ;;
    ja) locale=ja_JP.UTF-8; engine=anthy; keys='nihongo ' ;;
    ko) locale=ko_KR.UTF-8; engine=hangul; keys='gksrmf ' ;;
  esac
  gsettings set org.gnome.desktop.input-sources sources "[('ibus', '$engine')]"
  sleep 2
  for module in ibus xim gtk-im-context-simple native-early native-late; do
    if [[ "$module" = native-* ]] && { [ "$language" != zh ] || [ "$mode" = wayland ]; }; then continue; fi
    gtk_module=$module
    force_native=none
    if [[ "$module" = native-* ]]; then gtk_module=gtk-im-context-simple; force_native=${module#native-}; fi
    name="$language-$module"
    LANG="$locale" LC_ALL="$locale" GTK_IM_MODULE="$gtk_module" IME_FORCE_NATIVE="$force_native" python3 test/desktop-linux/ime/probe.py >"$out/$name.jsonl" 2>"$out/$name.log" &
    page=$!; pids+=("$page")
    sleep 4
    kill -0 "$page"
    if [ "$mode" = bare ]; then
      xdotool search --onlyvisible --name 'IME presentation probe' windowfocus
    elif [ "$mode" = x11 ]; then
      xdotool search --onlyvisible --name 'IME presentation probe' windowactivate --sync
    else
      # Shell starts in overview; DOM autofocus does not activate a native window.
      xdotool key alt+Tab
      sleep 1
    fi
    # XTEST enters the nested compositor too; events in JSONL prove whether input reached GTK.
    ibus engine "$engine" >"$out/$name-engine.log" 2>&1 || echo 'engine selection failed' >>"$out/$name-engine.log"
    ibus engine >>"$out/$name-engine.log" 2>&1 || echo 'no active engine' >>"$out/$name-engine.log"
    sleep 1
    xdotool type --clearmodifiers --delay 150 "$keys"
    if [ "$language" = ja ]; then xdotool key Return; fi
    for frame in 1 2 3; do
      sleep 2
      date +%s.%N >"$out/$name-$frame.time"
      import -display :99 -window root "$out/$name-$frame.png"
      tesseract "$out/$name-$frame.png" "$out/$name-$frame" --psm 11 2>"$out/$name-$frame-ocr.log"
    done
    kill "$page"
    wait "$page" || true
    # Do not retain a reaped PID that might be reused during the next iteration.
    unset 'pids[${#pids[@]}-1]'
    if [ -x /usr/bin/app ] && [[ "$module" != native-* ]]; then
      LANG="$locale" LC_ALL="$locale" GTK_IM_MODULE="$module" python3 test/desktop-linux/ime/package.py "$out/$name-package" "$keys"
    fi
  done
done
