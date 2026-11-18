#!/usr/bin/env python3
"""A WebKitGTK window with nothing but the copy of the backup's delete-remote dialog (#233),
for disconnect-probe.sh: the same WebKitGTK, fonts, locale and display as the app, without
Tauri, React or the app's CSS. Typing the repository name enables the button; pressing it
swaps the form for the sign-in code, as the app does.

Usage: minimal-page.py zh|en
"""
import sys

import gi

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2  # noqa: E402

COPY = {
    'zh': {
        'title': '断开备份连接',
        'levels': ['只断开本机', '断开并撤销 GitHub 授权', '删除远端仓库'],
        'desc': '在 GitHub 上删除 me/agent-store-backup 和全部备份记录，再撤销授权、断开本机。删除后无法恢复。',
        'will': '再用 GitHub 登录一次，授予 delete_repo 权限，只用于这次删除',
        'confirm': '输入仓库名 me/agent-store-backup 确认删除',
        'order': '先做 GitHub 上的步骤，最后才删除本机的数据；任何一步失败都会停下并说明是哪一步，本机的数据保持不动。',
        'cancel': '取消',
        'go': '登录 GitHub 并删除',
        'code': '授权删除仓库 代码 HQLC-RT4P',
    },
    'en': {
        'title': 'Disconnect the backup',
        'levels': ['This computer only', 'Disconnect and revoke the GitHub authorization', 'Delete the remote repository'],
        'desc': 'Deletes me/agent-store-backup and every backup commit in it on GitHub, then revokes and disconnects here. It cannot be undone.',
        'will': 'You sign in with GitHub once more to grant the delete_repo scope, used for this deletion only',
        'confirm': 'Type the repository name, me/agent-store-backup, to confirm',
        'order': 'The GitHub steps run first and this computer’s data is deleted last.',
        'cancel': 'Cancel',
        'go': 'Sign in with GitHub and delete',
        'code': 'Authorize deleting the repository Code HQLC-RT4P',
    },
}

c = COPY[sys.argv[1]]
levels = ''.join(f'<label><input type="radio" name="l" {"checked" if i == 2 else ""}> <b>{t}</b></label><br>' for i, t in enumerate(c['levels']))
HTML = f'''<!doctype html><html><head><meta charset="utf-8"><style>
body {{ background:#14141a; color:#e8e8ee; font: 400 13.5px/1.55 'Plus Jakarta Sans','PingFang SC','Noto Sans SC','Microsoft YaHei',system-ui,sans-serif; }}
#d {{ width:460px; margin:40px auto; padding:18px; border:1px solid #333; border-radius:12px; background:#1b1b22; }}
input[type=text] {{ font-family:'Geist Mono',monospace; width:100%; }}
button:disabled {{ opacity:.5 }}
#code {{ font-size:28px; letter-spacing:4px; }}
</style></head><body><div id="d">
<h3>{c["title"]}</h3>{levels}<p>{c["desc"]}</p><p>› {c["will"]}</p>
<p>{c["confirm"]}</p><input type="text" id="i" autocomplete="off" spellcheck="false" placeholder="me/agent-store-backup">
<p>{c["order"]}</p><button id="cancel">{c["cancel"]}</button> <button id="go" disabled>{c["go"]}</button>
</div><script>
const i = document.getElementById('i'), go = document.getElementById('go');
i.addEventListener('input', () => {{ go.disabled = i.value !== 'me/agent-store-backup'; }});
go.addEventListener('click', () => {{ document.getElementById('d').innerHTML = '<h3>{c["title"]}</h3><p id="code">{c["code"]}</p><button>{c["cancel"]}</button>'; }});
i.focus();
</script></body></html>'''

win = Gtk.Window(title='Minimal Page')
win.set_default_size(1200, 760)
view = WebKit2.WebView()
view.load_html(HTML, 'file:///')
win.add(view)
win.connect('destroy', Gtk.main_quit)
win.show_all()
Gtk.main()
