#!/usr/bin/env bash
# Run only in the desktop-shots CI container: actual Tauri IPC, a real Git backup,
# and native-window screenshots of first launch and restore in both locales.
set -euo pipefail
OUT=${OUT:-/out/first-launch}
mkdir -p "$OUT"
export DISPLAY=:99 WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
Xvfb :99 -screen 0 1280x800x24 >"$OUT/xvfb.log" 2>&1 &
xvfb_pid=$!
app_pid=''
cleanup() {
  if [ -n "$app_pid" ]; then kill "$app_pid" 2>/dev/null || true; wait "$app_pid" 2>/dev/null || true; fi
  kill "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT
sleep 2
eval "$(dbus-launch --sh-syntax)"
sudo dpkg -i /bundles/*.deb >"$OUT/install.log" 2>&1
TASK_HOME=$(mktemp -d)
REMOTE=$TASK_HOME/backup.git
git init --bare -q --initial-branch=main "$REMOTE"
mkdir -p "$TASK_HOME/source"
(cd /work && bun test/desktop-linux/seed-old-home.ts "$TASK_HOME/source")
HOME="$TASK_HOME/source" /usr/bin/aas backup connect "$REMOTE" >"$OUT/seed.log" 2>&1
HOME="$TASK_HOME/source" /usr/bin/aas backup now >>"$OUT/seed.log" 2>&1
stop_app() { kill "$app_pid"; wait "$app_pid" || true; app_pid=''; sleep 2; }
for lang in zh en; do
  export HOME=$TASK_HOME/$lang
  export XDG_DATA_HOME=$HOME/.local/share XDG_CONFIG_HOME=$HOME/.config
  mkdir -p "$HOME/.claude" "$HOME/.codex" "$XDG_DATA_HOME"
  if [ "$lang" = zh ]; then locale_name=zh_CN.UTF-8; else locale_name=en_US.UTF-8; fi
  env LANG="$locale_name" LC_ALL="$locale_name" LANGUAGE="$lang" /usr/bin/app >"$OUT/app-$lang.log" 2>&1 &
  app_pid=$!
  sleep 15
  win=$(xdotool search --onlyvisible --name 'Agent Store' | head -1)
  xdotool windowfocus --sync "$win"
  import -window "$win" "$OUT/$lang-choice.png"
  # The default focus is Start fresh; restore is the next button.
  xdotool key Tab Return
  sleep 3
  import -window "$win" "$OUT/$lang-connect.png"
  xdotool type --clearmodifiers "$REMOTE"
  xdotool key Return
  sleep 12
  import -window "$win" "$OUT/$lang-confirm.png"
  xdotool key Return
  sleep 15
  import -window "$win" "$OUT/$lang-restored.png"
  test -f "$HOME/.agent-store/skills/legacy-skill/SKILL.md"
  test -n "$(find "$XDG_DATA_HOME" -path '*/agent-store-cli/first-launch-backup.json' -print -quit)"
  stop_app
  env LANG="$locale_name" LC_ALL="$locale_name" LANGUAGE="$lang" /usr/bin/app >>"$OUT/app-$lang.log" 2>&1 &
  app_pid=$!
  sleep 12
  win=$(xdotool search --onlyvisible --name 'Agent Store' | head -1)
  import -window "$win" "$OUT/$lang-relaunch.png"
  stop_app
  echo "ok: $lang restored from first launch and relaunched" >>"$OUT/result.txt"
done
