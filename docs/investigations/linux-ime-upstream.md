# Upstream report draft: GTK3/X11 native child window stops presenting WebKit content

Status: prepared for a maintainer to submit to WebKitGTK; **not submitted**. Tracking in this repository: #239. No production workaround is shipped by PR #240.

## Environment

Ubuntu 22.04 GitHub Actions VM; Xvfb with GNOME Shell/Mutter 42.9 as X11 window/compositing manager; Mesa software GL. GTK 3.24.33-1ubuntu2.2, WebKitGTK 2.50.4-0ubuntu0.22.04.1. The issue also reproduces without GNOME, so absence of a desktop compositor is not a sufficient explanation. Physical GPUs have not been tested.

## Reproducer

Install Python GI with its Cairo converter, GTK3 and WebKit2 4.1 typelibs. Run [probe.py](../../test/desktop-linux/ime/probe.py) in an existing GNOME X11 session:

```sh
LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 LIBGL_ALWAYS_SOFTWARE=1 \
  GDK_BACKEND=x11 GTK_IM_MODULE=gtk-im-context-simple \
  IME_FORCE_NATIVE=late WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  python3 test/desktop-linux/ime/probe.py
```

This uses neither XIM nor an IME server: after the first page frame, the test calls `view.get_window().ensure_native()` once, two seconds after startup. The visible counter then stays on its old value although JavaScript messages report increasing values and input continues to reach the page. Compare with `IME_FORCE_NATIVE=none`, which keeps presenting. Using the normal renderer without either disable flag also keeps presenting after native promotion. Separately setting `WEBKIT_DISABLE_DMABUF_RENDERER=1` reproduces the stale presentation too.

With an IBus XIM server configured, the user-facing trigger is focusing a field with `GTK_IM_MODULE=xim` instead of directly calling `ensure_native()`. The XIM context obtains the client XID and the GDK child becomes native; the native page can stay white or keep a frame from before focus. An IBus GTK module and a simple input context provide controls. Simple is an ASCII diagnostic control, not a proposed CJK workaround.

The same presentation discrepancy occurs in the Agent Store 0.4.0 published `.deb`: WebDriver sees an open command palette and trusted input events, while a native display capture still shows the page before the palette opened. The standalone GTK/WebKit page establishes that React and Tauri are not required.

## Evidence and interpretation

The [investigation record](linux-ime.md) contains the runs, versions, per-case native/DOM measurements, CJK coverage and the limits of each run. Native screenshots are captured before any WebDriver DOM read, with no window resizing or WebKit snapshot used to force a repaint. OCR misses are retained as unknowns; a blank/stale window is checked directly against the original PNG.

Relevant source chain:

- [WebKit's GTK context passes the widget's GDK window to GTK](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebKit/UIProcess/API/gtk/WebKitInputMethodContextImplGtk.cpp).
- [GTK XIM obtains its client window XID](https://github.com/GNOME/gtk/blob/3.24.33/modules/input/gtkimcontextxim.c).
- [GDK obtains an XID by ensuring that a non-native window is native](https://github.com/GNOME/gtk/blob/3.24.33/gdk/x11/gdkwindow-x11.c).

The controlled test removes the XIM protocol and still reproduces the presentation failure. It identifies native child-window promotion interacting with these rendering paths as a sufficient trigger. It does not claim a particular untested C++ patch or establish which lower-level repaint operation needs changing. A fix should preserve real CJK input and restore native presentation, rather than force a simple input context.
