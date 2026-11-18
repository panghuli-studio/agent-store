#!/usr/bin/env bash
# Invoked in a disposable CI HOME and private D-Bus session. No production settings.
set -euo pipefail
mode=$1
out=$2
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
if [ "$mode" = wayland ]; then
  # A real GNOME compositor nested in Xvfb; screenshots sample its host surface.
  gnome-shell --nested --wayland >"$out/gnome.log" 2>&1 & pids+=("$!")
  export WAYLAND_DISPLAY=wayland-0 GDK_BACKEND=wayland
  for _ in {1..100}; do [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && break; sleep .2; done
  test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
else
  gnome-shell --x11 >"$out/gnome.log" 2>&1 & pids+=("$!")
  export GDK_BACKEND=x11
fi
sleep 5
kill -0 "${pids[1]}"
ibus-daemon --xim --replace >"$out/ibus.log" 2>&1 & pids+=("$!")
for _ in {1..50}; do ibus list-engine >"$out/engines.txt" 2>/dev/null && break; sleep .2; done
export XMODIFIERS=@im=ibus
for language in zh ja ko; do
  case "$language" in
    zh) locale=zh_CN.UTF-8; engine=libpinyin; keys='nihao ' ;;
    ja) locale=ja_JP.UTF-8; engine=anthy; keys='nihongo ' ;;
    ko) locale=ko_KR.UTF-8; engine=hangul; keys='gksrmf ' ;;
  esac
  ibus engine "$engine"
  for module in ibus xim gtk-im-context-simple; do
    name="$language-$module"
    LANG="$locale" LC_ALL="$locale" GTK_IM_MODULE="$module" python3 test/desktop-linux/ime/probe.py >"$out/$name.jsonl" 2>"$out/$name.log" &
    page=$!; pids+=("$page")
    sleep 4
    kill -0 "$page"
    # XTEST enters the nested compositor too; events in JSONL prove whether input reached GTK.
    xdotool mousemove 400 180 click 1
    xdotool type --clearmodifiers --delay 150 "$keys"
    for frame in 1 2 3; do
      sleep 2
      import -display :99 -window root "$out/$name-$frame.png"
    done
    kill "$page"
    wait "$page" || true
    # Do not retain a reaped PID that might be reused during the next iteration.
    unset 'pids[${#pids[@]}-1]'
  done
done
