#!/usr/bin/env python3
"""Native presentation/IME probe. Logs only this disposable page's test text."""
import json
import os
import sys
import time
import gi

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import GLib, Gtk, WebKit2

manager = WebKit2.UserContentManager()
manager.register_script_message_handler('probe')
manager.connect('script-message-received::probe', lambda _, result: print(
    json.dumps({'time': time.time(), 'page': json.loads(result.get_js_value().to_string())}), flush=True))
view = WebKit2.WebView.new_with_user_content_manager(manager)
draws = [0]
def did_draw(*_):
    draws[0] += 1
    return False
view.connect_after('draw', did_draw)
view.load_html('''<!doctype html><meta charset="utf-8">
<style>body {background:#14141a;color:white;font:32px sans-serif} input {font:32px sans-serif}
#frame {padding:40px;background:white;color:black;font:32px monospace}</style>
<p>Native IME presentation probe 中文 日本語 한국어</p><input id="i" autofocus>
<div id="frame"></div><script>
const field = document.getElementById('i'), frame = document.getElementById('frame');
let ticks = 0;
function report(kind) { window.webkit.messageHandlers.probe.postMessage(JSON.stringify({
  kind, ticks, text: field.value, active: document.activeElement === field, focused: document.hasFocus()})); }
for (const kind of ['focus', 'compositionstart', 'compositionupdate', 'compositionend', 'input'])
  field.addEventListener(kind, () => report(kind));
setInterval(() => { frame.textContent = 'FRAME ' + (++ticks);
  report('tick'); }, 1000);
</script>''', 'file:///')
win = Gtk.Window(title='IME presentation probe')
win.set_default_size(900, 600)
win.add(view)
win.connect('destroy', Gtk.main_quit)
win.show_all()
def native_state():
    window = view.get_window()
    print('GTK_WINDOW ' + json.dumps({'time': time.time(), 'native': window.has_native(),
          'focused': win.is_active(), 'draws': draws[0]}), file=sys.stderr, flush=True)
    return True
native_state()
def promote_native():
    view.get_window().ensure_native()
    native_state()
    return False
if os.environ.get('IME_FORCE_NATIVE') == 'early':
    promote_native()
elif os.environ.get('IME_FORCE_NATIVE') == 'late':
    GLib.timeout_add(2000, promote_native)
GLib.timeout_add(1000, native_state)
Gtk.main()
