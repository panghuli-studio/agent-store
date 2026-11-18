#!/usr/bin/env python3
"""A minimal W3C WebDriver client for WebKitWebDriver, used by disconnect-probe.sh (#233).

The release build allows automation only with TAURI_WEBVIEW_AUTOMATION=true in the app's
environment (tauri-runtime-wry); WebKitWebDriver passes its own environment on when it
starts the binary.

  wd.py start <port> <binary>        new session; prints its id
  wd.py hook <port> <sid>            records console.error/warn, errors and rejections
  wd.py probe <port> <sid> <prefix>  <prefix>-dom.json (the dialog as the DOM has it, the
                                     focused element, whether the page still runs
                                     requestAnimationFrame) and <prefix>-wd.png (WebKit's own
                                     snapshot of the page, not the X server's pixels)
  wd.py quit <port> <sid>
"""
import base64
import json
import sys
import urllib.request


def call(port, method, path, body=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)['value']


HOOK = r'''
if (!window.__probe) {
  window.__probe = [];
  const keep = (kind, args) => window.__probe.push({ kind, at: Date.now(), text: Array.from(args).map(String).join(' ').slice(0, 500) });
  for (const k of ['error', 'warn']) { const f = console[k].bind(console); console[k] = (...a) => { keep(k, a); f(...a); }; }
  addEventListener('error', (e) => keep('error-event', [e.message, e.filename, e.lineno]));
  addEventListener('unhandledrejection', (e) => keep('rejection', [e.reason && (e.reason.stack || e.reason)]));
}
return true;
'''

DOM = r'''
const q = (s) => document.querySelector(s);
const d = q('[role=dialog]');
const el = document.activeElement;
const box = q('[data-testid=backup-disconnect]');
return {
  at: Date.now(),
  visibility: document.visibilityState,
  step: box ? box.getAttribute('data-step') : null,
  dialog: d ? d.innerText.replace(/\s+/g, ' ').slice(0, 600) : null,
  input: q('#backup-disconnect-confirm') ? q('#backup-disconnect-confirm').value : null,
  buttons: d ? Array.from(d.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim().slice(0, 40), disabled: b.disabled })) : [],
  active: el ? el.tagName + (el.id ? '#' + el.id : '') + ' ' + (el.innerText || el.value || '').trim().slice(0, 40) : null,
  statusbar: (document.body.innerText.split('\n').filter(Boolean).slice(-3)).join(' | '),
  lang: navigator.language,
  probe: window.__probe || null,
};
'''

# Two animation frames within two seconds, or the page has stopped producing frames.
RAF = r'''
const done = arguments[arguments.length - 1];
const t0 = performance.now();
let n = 0;
const tick = () => { n += 1; if (n === 2) done({ frames: 2, ms: Math.round(performance.now() - t0) }); else requestAnimationFrame(tick); };
requestAnimationFrame(tick);
setTimeout(() => done({ frames: n, ms: Math.round(performance.now() - t0) }), 2000);
'''


def main():
    cmd, port = sys.argv[1], sys.argv[2]
    if cmd == 'start':
        caps = {'capabilities': {'alwaysMatch': {'webkitgtk:browserOptions': {'binary': sys.argv[3], 'args': []}}}}
        print(call(port, 'POST', '/session', caps, timeout=120)['sessionId'])
    elif cmd == 'hook':
        call(port, 'POST', f'/session/{sys.argv[3]}/execute/sync', {'script': HOOK, 'args': []})
    elif cmd == 'probe':
        sid, prefix = sys.argv[3], sys.argv[4]
        out = {}
        try:
            out['dom'] = call(port, 'POST', f'/session/{sid}/execute/sync', {'script': DOM, 'args': []}, timeout=20)
        except Exception as e:  # a page that stopped answering is itself the measurement
            out['dom_error'] = repr(e)
        try:
            out['raf'] = call(port, 'POST', f'/session/{sid}/execute/async', {'script': RAF, 'args': []}, timeout=20)
        except Exception as e:
            out['raf_error'] = repr(e)
        try:
            png = call(port, 'GET', f'/session/{sid}/screenshot', timeout=20)
            with open(f'{prefix}-wd.png', 'wb') as f:
                f.write(base64.b64decode(png))
        except Exception as e:
            out['screenshot_error'] = repr(e)
        with open(f'{prefix}-dom.json', 'w') as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
        print(json.dumps(out, ensure_ascii=False)[:1500])
    elif cmd == 'quit':
        call(port, 'DELETE', f'/session/{sys.argv[3]}')


if __name__ == '__main__':
    main()
