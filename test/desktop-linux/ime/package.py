#!/usr/bin/env python3
"""Exercise the released app's real command-palette input through native keys.

WebDriver reads composition events and DOM state; screenshots always come from the
outer X server. It does not supply text or synthesize composition events.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wd import call

prefix, keys = sys.argv[1:]
port = '9515'
state = Path.home() / '.local/share/com.aas.cli-gui/agent-store-cli'
state.mkdir(parents=True, exist_ok=True)
(state / 'welcome.json').write_text('{"seenAt":"2026-11-18T00:00:00Z"}')
(state / 'first-launch-backup.json').write_text('true')
log = open(prefix + '-driver.log', 'w')
env = dict(os.environ, TAURI_WEBVIEW_AUTOMATION='true', AS_STORE_URL='http://127.0.0.1:9')
driver = subprocess.Popen(['WebKitWebDriver', '--port=' + port], env=env,
                          stdout=log, stderr=log, start_new_session=True)
sid = None
try:
    for _ in range(50):
        try:
            call(port, 'GET', '/status', timeout=1)
            break
        except OSError:
            time.sleep(.1)
    sid = call(port, 'POST', '/session', {'capabilities': {'alwaysMatch': {
        'webkitgtk:browserOptions': {'binary': '/usr/bin/app', 'args': []}}}}, timeout=40)['sessionId']

    def js(script):
        return call(port, 'POST', f'/session/{sid}/execute/sync', {'script': script, 'args': []}, timeout=10)

    time.sleep(5)
    if os.environ['GDK_BACKEND'] == 'x11' and os.environ.get('IME_SESSION') == 'bare':
        subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', 'Agent Store', 'windowfocus'], check=True)
    elif os.environ['GDK_BACKEND'] == 'x11':
        subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', 'Agent Store', 'windowactivate', '--sync'], check=True)
    else:
        subprocess.run(['xdotool', 'key', 'alt+Tab'], check=True)
        time.sleep(1)
    js('''window.__imeEvents = [];
      for (const kind of ['compositionstart','compositionupdate','compositionend','input','focusin'])
        document.addEventListener(kind, e => window.__imeEvents.push({kind,
          tag:e.target.tagName, text:e.target.value, trusted:e.isTrusted}), true);
      return true;''')
    subprocess.run(['xdotool', 'key', 'ctrl+k'], check=True)
    time.sleep(2)
    subprocess.run(['import', '-display', ':99', '-window', 'root', prefix + '-before.png'], check=True)
    subprocess.run(['xdotool', 'type', '--clearmodifiers', '--delay', '150', keys], check=True)
    if os.environ.get('LC_ALL', '').startswith('ja_'):
        subprocess.run(['xdotool', 'key', 'Return'], check=True)
    for frame in range(1, 4):
        time.sleep(2)
        # Capture native pixels before any WebKit snapshot/DOM request can stimulate painting.
        subprocess.run(['import', '-display', ':99', '-window', 'root', f'{prefix}-{frame}.png'], check=True)
        data = js('''return {events:window.__imeEvents, active:document.activeElement.tagName,
          text:document.activeElement.value, focused:document.hasFocus(), palette:!!document.querySelector('[cmdk-input]'),
          body:document.body.innerText.slice(0,4000)};''')
        Path(f'{prefix}-{frame}.json').write_text(json.dumps(data, ensure_ascii=False, indent=2))
finally:
    if sid:
        try:
            call(port, 'DELETE', '/session/' + sid, timeout=10)
        except Exception as error:
            print('session cleanup:', repr(error), file=sys.stderr)
    try:
        os.killpg(driver.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        driver.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(driver.pid, signal.SIGKILL)
        driver.wait(timeout=5)
    log.close()
