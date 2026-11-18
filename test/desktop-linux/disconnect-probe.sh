#!/usr/bin/env bash
# Measurements for the Chinese delete-remote screens that stayed stale in shots.sh (#233):
#   1. which layer: after each action, the DOM as WebDriver reads it next to the X server's
#      pixels and WebKit's own snapshot of the page;
#   2. the fonts and versions on this runner, and a minimal WebKitGTK page with only the same
#      copy, in Chinese and English;
#   3. the app's and WebKit's output and the WebKit processes (pid, state, CPU) at each step.
# The flow runs in several variants (order, locale, input method, with and without WebDriver)
# so each can be compared with the others. It records; it does not decide pass or fail.
# Writes /out/probe/*: env.txt, result.txt and, per step, .png, .ocr.txt, .ps.txt and, with
# WebDriver, -dom.json and -wd.png.
set -uo pipefail

OUT=${OUT:-/out}/probe
SETTLE=${SETTLE:-12}
WD_PORT=4444
mkdir -p "$OUT"
: > "$OUT/result.txt"
log() { echo "$*" | tee -a "$OUT/result.txt"; }

export DISPLAY=:99
# The same display and WebKit settings as shots.sh.
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
sleep 2
eval "$(dbus-launch --sh-syntax)"
export XDG_DATA_HOME=$HOME/.local/share XDG_CONFIG_HOME=$HOME/.config

# 2. The environment.
{
  echo "## fc-list :lang=zh"; fc-list :lang=zh
  echo; echo "## fc-match (the app's --font and --mono stacks)"
  for f in 'Plus Jakarta Sans' 'PingFang SC' 'Noto Sans SC' 'Microsoft YaHei' 'system-ui' 'sans-serif:lang=zh-cn' 'Geist Mono' 'monospace:lang=zh-cn'; do
    echo "$f -> $(fc-match "$f")"
  done
  echo; echo "## packages"; dpkg-query -W libwebkit2gtk-4.1-0 webkit2gtk-driver gir1.2-webkit2-4.1 libgtk-3-0 xvfb fonts-noto-cjk mesa-utils libgl1-mesa-dri 2>&1
  echo; echo "## GTK input method modules"; cat /usr/lib/x86_64-linux-gnu/gtk-3.0/3.0.0/immodules.cache 2>&1 | grep -v '^#'
  echo; echo "## input method environment"; env | grep -E '^(GTK_IM_MODULE|XMODIFIERS|QT_IM_MODULE|LANG|LC_ALL|LANGUAGE)=' || echo '(none set)'
  echo; echo "## kernel"; uname -a
} >"$OUT/env.txt" 2>&1
log "environment written to env.txt"

sudo dpkg -i /bundles/*.deb >"$OUT/install.log" 2>&1 || { log "FAIL: dpkg -i"; exit 0; }
APP=/usr/bin/app
SIDECAR=/usr/bin/aas
# Seen the welcome already: the flow starts on the shell.
mkdir -p "$XDG_DATA_HOME/com.aas.cli-gui/agent-store-cli"
printf '{"seenAt":"2026-01-01T00:00:00.000Z"}' >"$XDG_DATA_HOME/com.aas.cli-gui/agent-store-cli/welcome.json"

point_at_window() {
  WIN=$(xdotool search --onlyvisible --name "${1:-Agent Store}" | head -1)
  eval "$(xdotool getwindowgeometry --shell "$WIN")"
  xdotool mousemove $((X + WIDTH / 2)) $((Y + HEIGHT / 2))
  xdotool windowfocus "$WIN" 2>/dev/null || true
}
settings_tab() {
  xdotool mousemove $((X + 204 + 22 + 20)) $((Y + 118)) click 1
  sleep 1
  for _ in $(seq "$1"); do xdotool key Right; sleep 0.3; done
  sleep "${2:-2}"
}
backup_page() { point_at_window; xdotool key ctrl+6; sleep 2; settings_tab 3 "${1:-10}"; }

GH_PORT=18790
GH_ROOT=$(mktemp -d)
GH_TOKEN=gho_desktopShots0123456789abcdefABCDEF01
python3 -I /work/test/desktop-linux/fake-github.py "$GH_ROOT" "$GH_PORT" "$GH_TOKEN" >"$OUT/fake-github.log" 2>&1 &
GH_PID=$!
sleep 1
gh_mode() { curl -s "http://127.0.0.1:$GH_PORT/control/$1" >/dev/null; }
export AS_GITHUB_CLIENT_ID=Iv1.desktop-shots AS_GITHUB_URL=http://127.0.0.1:$GH_PORT AS_GITHUB_API_URL=http://127.0.0.1:$GH_PORT/api
CONN=$HOME/.agent-store/backup/connection.json

SID=
# One step: the X server's pixels and their OCR, the WebKit processes, and with WebDriver the
# DOM, whether frames still run and WebKit's own snapshot.
probe() {
  local n=$1 expect=$2
  import -window root "$OUT/$n.png"
  tesseract "$OUT/$n.png" stdout -l eng+chi_sim 2>/dev/null | tr -d '[:space:]' >"$OUT/$n.ocr.txt"
  ps -eo pid,ppid,stat,etime,time,rss,args | grep -E 'WebKit|/usr/bin/app' | grep -v grep >"$OUT/$n.ps.txt"
  local screen=stale dom=-
  grep -Eq "$expect" "$OUT/$n.ocr.txt" && screen=shown
  if [ -n "$SID" ]; then
    python3 -I /work/test/desktop-linux/wd.py probe "$WD_PORT" "$SID" "$OUT/$n" >/dev/null 2>>"$OUT/wd-errors.txt"
    dom=$(python3 -c 'import json,sys; o=json.load(open(sys.argv[1])); d=o.get("dom") or {}; r=o.get("raf") or {}; print("step=%s input=%r active=%r frames=%s/%sms dom_has_expected=%s errors=%d" % (d.get("step"), d.get("input"), d.get("active"), r.get("frames"), r.get("ms"), sys.argv[2] in (d.get("dialog") or ""), len(d.get("probe") or [])) if d else o)' "$OUT/$n-dom.json" "$3" 2>&1)
  fi
  log "$n: screen ${screen} ($expect) | dom: $dom | webkit: $(awk '/WebKitWebProcess/ {printf "%s %s cpu=%s; ", $1, $3, $5}' "$OUT/$n.ps.txt")"
}

# run_variant <name> plain|wd zh|en [VAR=value ...]: shots.sh's 13b flow with a probe after each step.
run_variant() {
  local name=$1 mode=$2 lang=$3
  shift 3
  local loc=(LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LANGUAGE=en_US:en) code_text='HQLC.RT4P' done_text=Disconnected
  [ "$lang" = zh ] && loc=(LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 LANGUAGE=zh_CN:zh) done_text='已断开'
  log "== $name: $mode, $lang ${*:-}"
  "$SIDECAR" backup disconnect >/dev/null 2>&1
  gh_mode reset
  gh_mode auto
  "$SIDECAR" backup connect --github --device desk-a </dev/null >>"$OUT/cli.txt" 2>&1
  "$SIDECAR" backup now >>"$OUT/cli.txt" 2>&1
  local repo
  repo=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["github"]["repo"])' "$CONN" 2>/dev/null)
  [ -n "$repo" ] || { log "$name: could not connect; skipped"; return; }
  gh_mode wait
  SID=
  if [ "$mode" = wd ]; then
    env "${loc[@]}" TAURI_WEBVIEW_AUTOMATION=true "$@" WebKitWebDriver --port=$WD_PORT >"$OUT/$name-driver.log" 2>&1 &
    local drv=$!
    sleep 2
    SID=$(python3 -I /work/test/desktop-linux/wd.py start "$WD_PORT" "$APP" 2>>"$OUT/wd-errors.txt")
    [ -n "$SID" ] || log "$name: no WebDriver session (see wd-errors.txt, $name-driver.log)"
    sleep "$SETTLE"
    [ -n "$SID" ] && python3 -I /work/test/desktop-linux/wd.py hook "$WD_PORT" "$SID" 2>>"$OUT/wd-errors.txt"
  else
    env "${loc[@]}" "$@" "$APP" >"$OUT/$name-app.log" 2>&1 &
    sleep "$SETTLE"
  fi
  backup_page 8
  xdotool key Tab Tab Tab Tab Tab Return
  sleep 2
  probe "$name-1-dialog" "me/agent-store-backup|agent-store|Disconnect|断开" ""
  xdotool key shift+Tab Down
  sleep 1
  xdotool key Down
  sleep 1
  xdotool key Tab
  xdotool type --delay 40 "$repo"
  xdotool key ctrl+a ctrl+c
  sleep 2
  probe "$name-2-typed" "$repo" "$repo"
  xdotool key Tab Tab Return
  sleep 5
  probe "$name-3-code-5s" "$code_text" "HQLC"
  sleep 20
  probe "$name-4-code-25s" "$code_text" "HQLC"
  gh_mode approve
  sleep 15
  probe "$name-5-done-15s" "$done_text" "$done_text"
  sleep 30
  probe "$name-6-done-45s" "$done_text" "$done_text"
  log "$name: repository deleted on disk: $([ ! -e "$GH_ROOT/$repo.git" ] && echo yes || echo no); local backup removed: $([ ! -e "$HOME/.agent-store/backup" ] && echo yes || echo no)"
  if [ -n "$SID" ]; then python3 -I /work/test/desktop-linux/wd.py quit "$WD_PORT" "$SID" 2>>"$OUT/wd-errors.txt"; SID=; fi
  pkill -x app
  [ "$mode" = wd ] && kill "$drv" 2>/dev/null
  sleep 3
}

# English first this time: shots.sh ran Chinese first, so a failure that follows the order
# rather than the language shows here.
run_variant plain-en plain en
run_variant plain-zh plain zh
run_variant wd-zh wd zh
# GTK picks an input method by locale: XIM for zh, which this container has no server for.
run_variant plain-zh-im-simple plain zh GTK_IM_MODULE=gtk-im-context-simple
# A desktop with an input method: IBus serving XIM, GTK still on its default (XIM) module.
if command -v ibus-daemon >/dev/null; then
  ibus-daemon --xim --daemonize --replace >"$OUT/ibus.log" 2>&1
  sleep 3
  run_variant plain-zh-xim-ibus plain zh XMODIFIERS=@im=ibus
  ibus exit >/dev/null 2>&1
fi

# 2b. The minimal page: same WebKitGTK, fonts, locale and display, only the copy; then the
#     Chinese one again with GTK's simple input method.
for v in zh en zh-im-simple; do
  lang=${v%%-*}
  loc=(LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LANGUAGE=en_US:en)
  [ "$lang" = zh ] && loc=(LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 LANGUAGE=zh_CN:zh)
  [ "$v" = zh-im-simple ] && loc+=(GTK_IM_MODULE=gtk-im-context-simple)
  log "== minimal-$v"
  env "${loc[@]}" python3 -I /work/test/desktop-linux/minimal-page.py "$lang" >"$OUT/minimal-$v.log" 2>&1 &
  mpid=$!
  sleep 6
  point_at_window 'Minimal Page'
  xdotool type --delay 40 me/agent-store-backup
  xdotool key ctrl+a ctrl+c
  sleep 2
  probe "minimal-$v-1-typed" 'me/agent-store-backup' ''
  xdotool key Tab Tab Return
  sleep 5
  probe "minimal-$v-2-code-5s" 'HQLC.RT4P' ''
  sleep 20
  probe "minimal-$v-3-code-25s" 'HQLC.RT4P' ''
  kill "$mpid" 2>/dev/null
  sleep 2
done

kill "$GH_PID" 2>/dev/null
# 3. Anything WebKit or GTK printed, and core files.
grep -hiE 'crash|segv|abort|terminated|critical|error' "$OUT"/*-app.log "$OUT"/*-driver.log "$OUT"/minimal-*.log 2>/dev/null | sort | uniq -c | sort -rn | head -40 >"$OUT/log-errors.txt"
find / -xdev -name 'core*' -newer "$OUT/env.txt" -type f 2>/dev/null >>"$OUT/log-errors.txt"
log "done"
exit 0
