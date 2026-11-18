# Upstream report draft: GTK3/X11 native child window stops presenting WebKit content

Status: 上游报告已备好、待所有者提交 (prepared for the owner to submit to WebKitGTK; **not submitted**). Tracking in this repository: #239. No production workaround is shipped by PR #240.

## Environment

Ubuntu 22.04 GitHub Actions VM; Xvfb with GNOME Shell/Mutter 42.9 as X11 window/compositing manager; Mesa software GL. GTK 3.24.33-1ubuntu2.2, WebKitGTK 2.50.4-0ubuntu0.22.04.1. The issue also reproduces without GNOME, so absence of a desktop compositor is not a sufficient explanation. Physical GPUs have not been tested.

## Reproducer

Use a clean **Ubuntu 22.04 GNOME desktop**, logged into “Ubuntu on Xorg” (select it at the login screen). Open Terminal inside that session as the desktop user, not via SSH or as root. No Agent Store installation, repository checkout, IME configuration, Node, Rust, or application build is needed. Internet access and sudo are needed only for setup. The software-rendering flag below matches the measured VM; this is not a claim about physical GPU rendering.

Install the dependencies and download the exact standalone probe used for the recorded measurements:

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends curl python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-webkit2-4.1 fonts-noto-cjk locales
sudo locale-gen zh_CN.UTF-8
mkdir -p "$HOME/webkit-native-probe"
cd "$HOME/webkit-native-probe"
curl --fail --location https://raw.githubusercontent.com/panghuli-studio/agent-store/7af939915a325553b2b44fd70f5fd950306309c6/test/desktop-linux/ime/probe.py --output probe.py
printf 'Session: %s; display: %s\n' "$XDG_SESSION_TYPE" "$DISPLAY"
dpkg-query -W gnome-shell mutter-common libgtk-3-0 libwebkit2gtk-4.1-0 python3-gi python3-gi-cairo | tee versions.txt
```

The session must print `x11` and a nonempty display. If it says `wayland`, log out and select the Xorg session before continuing. Package repositories may now supply newer versions than those recorded above; keep `versions.txt` with any new result rather than assuming an identical outcome.

Paste this function and run the four cases sequentially in the same terminal. Each window closes after 15 seconds. Do not resize, minimize, obscure or take a WebKit-internal snapshot of the window during observation; these can change repaint behavior. The terminal logs remain in the current directory.

```sh
run_probe() {
  case_name="$1"
  shift
  timeout --kill-after=3s 15s env \
    -u WEBKIT_DISABLE_COMPOSITING_MODE -u WEBKIT_DISABLE_DMABUF_RENDERER \
    LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 LIBGL_ALWAYS_SOFTWARE=1 \
    GDK_BACKEND=x11 GTK_IM_MODULE=gtk-im-context-simple \
    "$@" /usr/bin/python3 probe.py > "$case_name.log" 2>&1
  probe_status=$?
  if [ "$probe_status" -ne 124 ]; then
    printf 'Unexpected exit %s; inspect %s.log\n' "$probe_status" "$case_name"
    return 1
  fi
}
run_probe control IME_FORCE_NATIVE=none WEBKIT_DISABLE_COMPOSITING_MODE=1
run_probe native-default IME_FORCE_NATIVE=late
run_probe native-compositing-off IME_FORCE_NATIVE=late WEBKIT_DISABLE_COMPOSITING_MODE=1
run_probe native-dmabuf-off IME_FORCE_NATIVE=late WEBKIT_DISABLE_DMABUF_RENDERER=1
```

Exit 124 is the intentional timeout, not a failed reproduction. For each case, observe the visible `FRAME` counter around seconds 7–11, and optionally type ASCII into the input. The `page` entries in each log contain JavaScript `ticks` and input events; `GTK_WINDOW` entries contain the native-window state and GTK draw count. If the program exits early, inspect its log before interpreting any result.

**Expected:** all four windows keep presenting an increasing counter; typing remains visible after native promotion. **Actual on the recorded stack:** `control` and `native-default` keep presenting. In the two disabled-renderer cases, the visible counter stays stale (FRAME 1 in the measured late-promotion case), while logged ticks advance through 7, 9 and 11, and GTK draw callbacks continue. `native` changes from false to true approximately two seconds after startup. A newer stack that keeps presenting in all cases is a useful non-reproduction; record the versions and rendering environment.

This uses neither XIM nor an IME server: after the first page frame, the test calls `view.get_window().ensure_native()` once, two seconds after startup. The two controls distinguish the rendering flag alone from native promotion with the normal renderer. The function explicitly clears inherited rendering-disable flags before each case.

With an IBus XIM server configured, the user-facing trigger is focusing a field with `GTK_IM_MODULE=xim` instead of directly calling `ensure_native()`. The XIM context obtains the client XID and the GDK child becomes native; the native page can stay white or keep a frame from before focus. An IBus GTK module and a simple input context provide controls. Simple is an ASCII diagnostic control, not a proposed CJK workaround.

The same presentation discrepancy occurs in the Agent Store 0.4.0 published `.deb`: WebDriver sees an open command palette and trusted input events, while a native display capture still shows the page before the palette opened. The standalone GTK/WebKit page establishes that React and Tauri are not required.

## Evidence and interpretation

The [investigation record](https://github.com/panghuli-studio/agent-store/blob/superagent/407906d27456fddd4ee7eb3bb81b649e/docs/investigations/linux-ime.md) contains the runs, versions, per-case native/DOM measurements, CJK coverage and the limits of each run. Native screenshots are captured before any WebDriver DOM read, with no window resizing or WebKit snapshot used to force a repaint. OCR misses are retained as unknowns; a blank/stale window is checked directly against the original PNG.

Relevant source chain:

- [WebKit's GTK context passes the widget's GDK window to GTK](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebKit/UIProcess/API/gtk/WebKitInputMethodContextImplGtk.cpp).
- [GTK XIM obtains its client window XID](https://github.com/GNOME/gtk/blob/3.24.33/modules/input/gtkimcontextxim.c).
- [GDK obtains an XID by ensuring that a non-native window is native](https://github.com/GNOME/gtk/blob/3.24.33/gdk/x11/gdkwindow-x11.c).

The controlled test removes the XIM protocol and still reproduces the presentation failure. It identifies native child-window promotion interacting with these rendering paths as a sufficient trigger. It does not claim a particular untested C++ patch or establish which lower-level repaint operation needs changing. A fix should preserve real CJK input and restore native presentation, rather than force a simple input context.
