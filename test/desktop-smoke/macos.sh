#!/usr/bin/env bash
# Smoke test of the macOS bundle built by the desktop-smoke workflow, on a GitHub macOS
# runner: install the .dmg like a download, launch, the bundled sidecar, and agent-store://
# links driven by the OS. Writes $OUT/result.txt and screenshots; exits non-zero if a check fails.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${OUT:-$ROOT/out}
SETTLE=${SETTLE:-15}
BUNDLE_DIR=${BUNDLE_DIR:-$ROOT/apps/cli-gui/src-tauri/target/universal-apple-darwin/release/bundle}
SKILL_ID=github:vercel-labs/skills/find-skills
SKILL_SLUG=skills-find-skills
MCP_ID=mcp-registry:io.github.upstash/context7
APP="/Applications/Agent Store.app"
mkdir -p "$OUT"
: > "$OUT/result.txt"
STAMP=$(mktemp)
log() { echo "$*" | tee -a "$OUT/result.txt"; }
failed=0
check() { if eval "$2"; then log "ok: $1"; else log "FAIL: $1"; failed=1; fi; }
enc() { python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
shot() { screencapture -x "$OUT/macos-$1.png" 2>>"$OUT/screencapture.log" || log "screencapture $1 failed"; }
app_pids() { pgrep -x app; }
# Runs a command, killing it after $1 seconds (macOS has no timeout(1)).
bounded() { local t=$1; shift; "$@" & local p=$!; ( sleep "$t"; kill "$p" 2>/dev/null ) & local w=$!; wait "$p"; local rc=$?; kill "$w" 2>/dev/null; return $rc; }
stop_app() { for p in $(app_pids); do kill "$p"; done; sleep 3; }
# Keys go to the frontmost app through System Events (needs Accessibility for this shell).
keys() { osascript -e 'tell application "Agent Store" to activate' -e 'delay 1' -e "tell application \"System Events\" to $1" >>"$OUT/osascript.log" 2>&1; }
confirm() { keys 'key code 48' && sleep 1 && keys 'key code 36'; sleep 20; }
# The live catalog sometimes answers 503 for a moment: if an install did not land, the link is
# opened and confirmed once more. The first attempt's screenshot stays in the artifact.
retry_link() { eval "$2" && return; log "RETRY: $3 did not land; opening the link once more"; open "$1"; sleep "$SETTLE"; confirm; shot "$3-retry"; }
windows_of() { swift "$ROOT/test/desktop-smoke/windows.swift" "$1" 2>>"$OUT/swift.log"; }
new_crash_reports() { find "$HOME/Library/Logs/DiagnosticReports" /Library/Logs/DiagnosticReports -newer "$STAMP" \( -name 'app*' -o -name 'aas*' -o -name 'Agent Store*' \) 2>/dev/null; }

VERSION=$(cd "$ROOT/apps/cli-gui" && bun -e "console.log(require('./src-tauri/tauri.conf.json').version)")
log "expected version: $VERSION"
log "macOS $(sw_vers -productVersion) $(uname -m); Gatekeeper: $(spctl --status 2>&1)"

DMG=$(ls "$BUNDLE_DIR"/dmg/*.dmg | head -1)
log "dmg: $DMG"
check "the dmg was built" '[ -f "$DMG" ]'
[ -f "$DMG" ] || exit 1

# 1. Install like a download: a browser marks the dmg quarantined; the user drags the app
#    into /Applications.
xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;" "$DMG"
MNT=$(mktemp -d)
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" >"$OUT/hdiutil.log" 2>&1 || { log "FAIL: hdiutil attach"; exit 1; }
ditto "$MNT/Agent Store.app" "$APP"
hdiutil detach "$MNT" >>"$OUT/hdiutil.log" 2>&1
check "the dmg holds Agent Store.app" '[ -x "$APP/Contents/MacOS/app" ]'
SIDECAR="$APP/Contents/MacOS/aas"
check "the bundle carries the aas sidecar" '[ -x "$SIDECAR" ]'
check "Info.plist version is $VERSION" '[ "$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist")" = "$VERSION" ]'
check "Info.plist declares agent-store://" 'plutil -extract CFBundleURLTypes xml1 -o - "$APP/Contents/Info.plist" | grep -q "<string>agent-store</string>"'
log "app archs: $(lipo -archs "$APP/Contents/MacOS/app"); sidecar archs: $(lipo -archs "$SIDECAR")"
check "the app is universal" 'lipo -archs "$APP/Contents/MacOS/app" | grep -q x86_64 && lipo -archs "$APP/Contents/MacOS/app" | grep -q arm64'
check "the sidecar is universal" 'lipo -archs "$SIDECAR" | grep -q x86_64 && lipo -archs "$SIDECAR" | grep -q arm64'

{
  echo "\$ xattr -l (app, after copying from the quarantined dmg)"; xattr -l "$APP"
  echo "\$ codesign -dv app"; codesign -dv --verbose=2 "$APP" 2>&1
  echo "\$ codesign --verify --deep --strict"; codesign --verify --deep --strict --verbose=2 "$APP" 2>&1
  echo "\$ codesign -dv aas"; codesign -dv --verbose=2 "$SIDECAR" 2>&1
  echo "\$ spctl --assess --type execute"; spctl --assess --type execute -vv "$APP" 2>&1
} >"$OUT/signature.txt" 2>&1
log "spctl: $(spctl --assess --type execute "$APP" 2>&1 | tr '\n' ' ')"
log "quarantine on the installed app: $(xattr -p com.apple.quarantine "$APP" 2>/dev/null || echo none)"
# The bundle is ad-hoc signed (#196): it must verify, or a quarantined download is reported as damaged.
check "the bundle signature verifies" 'codesign --verify --deep --strict "$APP" 2>>"$OUT/signature.txt"'

# What a user gets on double-clicking the downloaded copy. Escape dismisses the dialog
# (its other button moves the app to the Trash).
# `open` does not return while the dialog is up.
open "$APP" 2>>"$OUT/open.log" &
OPEN_PID=$!
sleep 10
shot gatekeeper-quarantined
log "quarantined app running after open: $([ -n "$(app_pids)" ] && echo yes || echo no)"
log "open returned while the dialog was up: $(kill -0 "$OPEN_PID" 2>/dev/null && echo no || echo yes)"
bounded 30 osascript -e 'tell application "System Events" to tell process "CoreServicesUIAgent" to click button "Done" of window 1' >>"$OUT/osascript.log" 2>&1 \
  || bounded 30 osascript -e 'tell application "System Events" to key code 53' >>"$OUT/osascript.log" 2>&1
sleep 2
shot gatekeeper-dismissed
sleep 2
kill "$OPEN_PID" 2>/dev/null
stop_app
check "the app is still in /Applications after the Gatekeeper dialog" '[ -x "$APP/Contents/MacOS/app" ]'

# What the release notes tell users to run before the first launch.
xattr -cr "$APP"

# 2. The sidecar inside the installed bundle, with throwaway homes.
(cd "$ROOT" && bun test/desktop-smoke/sidecar.ts "$SIDECAR" "$OUT" "$VERSION") || failed=1
if arch -x86_64 /usr/bin/true 2>/dev/null; then
  check "the sidecar's x86_64 slice runs (Rosetta)" '[ "$(arch -x86_64 "$SIDECAR" --version 2>/dev/null)" = "aas $VERSION" ]'
else
  log "skip: no Rosetta on this runner, the x86_64 slices were not run"
fi

# 3. First launch through LaunchServices, like a double click.
# WKWebView only moves Tab focus to buttons with full keyboard access on (off by default).
defaults write NSGlobalDomain AppleKeyboardUIMode -int 3
open "$APP"
sleep "$SETTLE"
PID=$(app_pids | head -1)
log "app pid after launch: ${PID:-none}"
check "the app is running ${SETTLE}s after launch" '[ -n "$PID" ]'
WINS=$(windows_of "${PID:-0}")
log "windows: ${WINS:-none}"
check "the main window is on screen" '[ -n "$WINS" ]'
shot 00-first-launch
sleep 10
check "the app is still running 10s later" '[ -n "$PID" ] && kill -0 "$PID" 2>/dev/null'
stop_app
check "the scheme is registered with LaunchServices" '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -dump 2>/dev/null | grep -q "agent-store:"'

# 4. Cold start from a link, confirmed with the keyboard: the dialog focuses Cancel,
#    Install is the next button.
open "agent-store://install?id=$(enc "$SKILL_ID")"
sleep "$SETTLE"
shot 01-link-confirm
check "a link starts the closed app" '[ -n "$(app_pids)" ]'
confirm
shot 02-link-installed
retry_link "agent-store://install?id=$(enc "$SKILL_ID")" '[ -f "$HOME/.agent-store/skills/$SKILL_SLUG/.agent-store.json" ]' 02-link-installed
log "skills: $(ls "$HOME/.agent-store/skills" 2>/dev/null | tr '\n' ' ')"
check "a cold-start link installs $SKILL_SLUG" '[ -f "$HOME/.agent-store/skills/$SKILL_SLUG/.agent-store.json" ]'
check "Claude Code gets the skill" '[ -e "$HOME/.claude/skills/find-skills/SKILL.md" ]'
stop_app

# 5. Warm start: the link reaches the running window.
open "$APP"
sleep "$SETTLE"
open "agent-store://install?id=$(enc "$MCP_ID")"
sleep "$SETTLE"
shot 03-warm-confirm
log "instances while warm: $(app_pids | wc -l | tr -d ' ')"
check "a warm link does not start a second instance" '[ "$(app_pids | wc -l | tr -d " ")" = 1 ]'
confirm
shot 04-warm-installed
retry_link "agent-store://install?id=$(enc "$MCP_ID")" 'grep -q "@upstash/context7-mcp" "$HOME/.claude.json" 2>/dev/null' 04-warm-installed
check "a warm link installs context7 for Claude Code" 'grep -q "@upstash/context7-mcp" "$HOME/.claude.json" 2>/dev/null'
stop_app

# 6. CLIs that a terminal finds and launchd's PATH does not (#203). Claude Code and Codex come
#    from npm with prefix ~/.npm-global, and the login shell's profile puts that and node on
#    PATH, the way a manual npm or nvm setup leaves a Mac. Neither directory is on the runner's
#    own PATH. Each CLI is wrapped to log its calls. `open` from this script would hand the app
#    the runner's PATH, so the app is opened by Finder, which has launchd's.
USER_SHELL=$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | awk '{print $2}')
log "login shell: ${USER_SHELL:-unknown}; launchctl getenv PATH: $(launchctl getenv PATH 2>&1 || true)"
NPM_BIN="$HOME/.npm-global/bin"
NODE_DIR=$(dirname "$(command -v node)")
bounded 300 npm install -g --prefix "$HOME/.npm-global" --no-fund --no-audit @anthropic-ai/claude-code @openai/codex >"$OUT/npm-install.log" 2>&1 \
  || log "npm install of claude-code and codex failed (npm-install.log)"
for f in .zprofile .bash_profile .profile; do
  printf '\nexport PATH="%s:%s:$PATH"\n' "$NPM_BIN" "$NODE_DIR" >>"$HOME/$f"
done
CALLS="$OUT/cli-calls.log"
for t in claude codex; do
  bin="$NPM_BIN/$t"
  [ -e "$bin" ] || { log "no $bin after npm install"; continue; }
  real=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$bin")
  rm "$bin"
  printf '#!/bin/sh\nprintf "%%s %s %%s | PATH=%%s\\n" "$(date +%%T)" "$*" "$PATH" >>"%s"\nexec "%s" "$@"\n' "$t" "$CALLS" "$real" >"$bin"
  chmod +x "$bin"
done
check "a login shell finds claude in ~/.npm-global/bin" '[ "$("${USER_SHELL:-/bin/zsh}" -l -c "command -v claude" 2>/dev/null | tail -1)" = "$NPM_BIN/claude" ]'
check "a login shell runs claude" '"${USER_SHELL:-/bin/zsh}" -l -c "claude --version" >>"$OUT/cli-version.log" 2>&1'
check "a login shell runs codex" '"${USER_SHELL:-/bin/zsh}" -l -c "codex --version" >>"$OUT/cli-version.log" 2>&1'
: >"$CALLS"

mkdir -p "$HOME/.codex"
cat >>"$HOME/.codex/config.toml" <<'TOML'

# smoke: comment above a server Agent Store does not own
[mcp_servers.smoke-own]
command = "echo" # smoke: inline comment
TOML
cp "$HOME/.codex/config.toml" "$OUT/codex-config-before.toml"
cp "$HOME/.claude.json" "$OUT/claude-json-before.json" 2>/dev/null

envof() { ps eww -o command= -p "$1" 2>/dev/null | tr ' ' '\n' | grep -E "^$2=" | head -1; }
bounded 60 osascript -e "tell application \"Finder\" to open (POSIX file \"$APP\" as alias)" >>"$OUT/osascript.log" 2>&1 \
  || log "Finder did not open the app (osascript.log)"
sleep "$SETTLE"
PID=$(app_pids | head -1)
{
  echo "Finder pid $(pgrep -x Finder | head -1): $(envof "$(pgrep -x Finder | head -1)" PATH)"
  echo "app pid $PID: $(envof "$PID" PATH) $(envof "$PID" SHELL)"
  for p in $(pgrep -x aas); do echo "aas pid $p ($(ps -o command= -p "$p")): $(envof "$p" PATH)"; done
} >"$OUT/gui-env.txt"
while IFS= read -r l; do log "$l"; done <"$OUT/gui-env.txt"
check "the app opened by Finder is running" '[ -n "$PID" ]'
# ps shows the environment a process was started with, so the app itself still shows launchd's
# PATH after it changed its own; the sidecar it started shows the result.
check "the sidecar's PATH has ~/.npm-global/bin" 'envof "$(pgrep -x aas | head -1)" PATH | tr ":=" "\n\n" | grep -qx "$NPM_BIN"'
shot 05-finder-launch
keys 'key code 53'
sleep 1
keys 'keystroke "," using command down'
sleep 3
# The tab's AX role varies with WebKit, so it is found by its text and clicked by position.
# Written to a file: bounded runs its command in the background, where stdin is /dev/null.
CLICK=$(mktemp)
cat >"$CLICK" <<'APPLESCRIPT'
on run argv
  set pid to (item 1 of argv) as integer
  tell application "System Events" to tell (first process whose unix id is pid)
    set frontmost to true
    repeat with e in (entire contents of window 1)
      try
        set label to ""
        try
          set label to (value of e) as text
        end try
        if label is not in {"Agents", "Agent"} then set label to (name of e) as text
        if label is in {"Agents", "Agent"} then
          set {x, y} to position of e
          set {w, h} to size of e
          if x > 120 and y < 300 then
            click at {x + w div 2, y + h div 2}
            return "clicked Agents at " & x & "," & y
          end if
        end if
      end try
    end repeat
  end tell
  error "no Agents tab"
end run
APPLESCRIPT
# The web view's tabs are not always in the AX tree; the fallback is where the tab is drawn on
# the runner's 1024x768 screen (macos-06-settings-agents.png shows which one was opened).
bounded 120 osascript "$CLICK" "${PID:-0}" >>"$OUT/osascript.log" 2>&1 \
  || bounded 30 osascript -e 'tell application "System Events" to click at {238, 139}' >>"$OUT/osascript.log" 2>&1 \
  || log "the Agents tab was not clicked (osascript.log)"
sleep 8
shot 06-settings-agents
log "cli calls while the app ran (detection):"; while IFS= read -r l; do log "  $l"; done <"$CALLS"
check "the app opened by Finder finds claude (detection ran claude --version)" 'grep -q " claude --version" "$CALLS"'

MCP2_ID=mcp-registry:io.github.microsoft/playwright-mcp
open "agent-store://install?id=$(enc "$MCP2_ID")"
sleep "$SETTLE"
shot 07-cli-confirm
confirm
shot 08-cli-installed
retry_link "agent-store://install?id=$(enc "$MCP2_ID")" 'grep -q "@playwright/mcp" "$HOME/.claude.json" 2>/dev/null' 08-cli-installed
stop_app
cp "$HOME/.codex/config.toml" "$OUT/codex-config-after.toml"
cp "$HOME/.claude.json" "$OUT/claude-json-after.json" 2>/dev/null
log "cli calls (all):"; while IFS= read -r l; do log "  $l"; done <"$CALLS"
diff -u "$OUT/codex-config-before.toml" "$OUT/codex-config-after.toml" >"$OUT/codex-config.diff"
log "codex config.toml diff: $(wc -l <"$OUT/codex-config.diff" | tr -d ' ') lines (codex-config.diff)"
check "playwright-mcp written to ~/.claude.json" 'grep -q "@playwright/mcp" "$HOME/.claude.json" 2>/dev/null'
check "playwright-mcp written to ~/.codex/config.toml" 'grep -q "@playwright/mcp" "$HOME/.codex/config.toml"'
check "Claude Code's entry went through claude mcp add-json" 'grep -qE " claude mcp add-json --scope user .*@playwright/mcp" "$CALLS"'
check "Codex's entry went through codex mcp add" 'grep -qE " codex mcp add .*@playwright/mcp" "$CALLS"'
log "comments kept in config.toml: $(grep -c '# smoke:' "$HOME/.codex/config.toml") of 2"

CRASHES=$(new_crash_reports)
[ -n "$CRASHES" ] && { log "crash reports:"; log "$CRASHES"; while IFS= read -r f; do cp "$f" "$OUT/"; done <<<"$CRASHES"; }
check "no crash report was written" '[ -z "$CRASHES" ]'
log "result: $([ $failed = 0 ] && echo PASS || echo FAIL)"
[ $failed = 0 ]
