#!/usr/bin/env python3
"""Native presentation/IME probe. Logs only this disposable page's test text."""
import json
import time
import gi

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2

manager = WebKit2.UserContentManager()
manager.register_script_message_handler('probe')
manager.connect('script-message-received::probe', lambda _, result: print(
    json.dumps({'time': time.time(), 'page': json.loads(result.get_js_value().to_string())}), flush=True))
view = WebKit2.WebView.new_with_user_content_manager(manager)
view.load_html('''<!doctype html><meta charset="utf-8">
<style>body {background:#14141a;color:white;font:32px sans-serif} input {font:32px sans-serif}
#frame {padding:40px;background:#163f63}</style>
<p>Native IME presentation probe 中文 日本語 한국어</p><input id="i" autofocus>
<div id="frame"></div><script>
const field = document.getElementById('i'), frame = document.getElementById('frame');
let ticks = 0;
function report(kind) { window.webkit.messageHandlers.probe.postMessage(JSON.stringify({
  kind, ticks, text: field.value, active: document.activeElement === field})); }
for (const kind of ['focus', 'compositionstart', 'compositionupdate', 'compositionend', 'input'])
  field.addEventListener(kind, () => report(kind));
setInterval(() => { frame.textContent = 'FRAME ' + (++ticks);
  frame.style.background = ticks % 2 ? '#163f63' : '#633f16'; report('tick'); }, 1000);
</script>''', 'file:///')
win = Gtk.Window(title='IME presentation probe')
win.set_default_size(900, 600)
win.add(view)
win.connect('destroy', Gtk.main_quit)
win.show_all()
Gtk.main()
