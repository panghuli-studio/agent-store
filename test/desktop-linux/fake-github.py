#!/usr/bin/env python3
"""A stand-in for github.com and api.github.com for the backup's GitHub sign-in (#231).

shots.sh points AS_GITHUB_URL at http://127.0.0.1:<port> and AS_GITHUB_API_URL at
http://127.0.0.1:<port>/api. It answers the device flow, the few REST calls the core makes,
and Git's smart HTTP through `git http-backend` for the repositories it "creates" under
<root>/<owner>/<name>.git, with Basic auth that only takes the token it handed out.

The device flow's next answer is set with GET /control/<mode>:
  wait     authorization_pending until changed
  approve  the token
  deny     access_denied
  auto     authorization_pending twice, then the token (for the CLI)
  reset    deletes every repository; the mode becomes wait

Usage: fake-github.py <root> <port> <token>
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ROOT, PORT, TOKEN = sys.argv[1], int(sys.argv[2]), sys.argv[3]
LOGIN = 'me'
state = {'mode': 'wait', 'polls': 0}
lock = threading.Lock()


def repo_dir(full):
    return os.path.join(ROOT, f'{full}.git')


def git(*args, cwd=None):
    return subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True)


def private_of(full):
    try:
        with open(os.path.join(ROOT, 'visibility.json')) as f:
            return json.load(f).get(full, True)
    except FileNotFoundError:
        return True


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        # Paths and statuses only; never headers, so no credential reaches the log.
        sys.stderr.write('%s %s\n' % (self.command, fmt % args))

    def send(self, status, body=b'', headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
            headers = {'Content-Type': 'application/json', **(headers or {})}
        self.send_response(status)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(n) if n else b''

    def do_GET(self):
        self.route('GET')

    def do_POST(self):
        self.route('POST')

    def route(self, method):
        url = urlsplit(self.path)
        path = url.path
        if path.startswith('/control/'):
            mode = path[len('/control/'):]
            with lock:
                if mode == 'reset':
                    for d in os.listdir(ROOT):
                        shutil.rmtree(os.path.join(ROOT, d), ignore_errors=True)
                    os.makedirs(os.path.join(ROOT, LOGIN), exist_ok=True)
                    mode = 'wait'
                state['mode'], state['polls'] = mode, 0
            return self.send(200, {'mode': mode})
        if path == '/login/device/code' and method == 'POST':
            form = parse_qs(self.body().decode())
            if not form.get('client_id'):
                return self.send(200, {'error': 'unauthorized_client'})
            return self.send(200, {
                'device_code': 'fake-device-code', 'user_code': 'WDJB-MJHT',
                'verification_uri': 'https://github.com/login/device', 'expires_in': 900, 'interval': 1,
            })
        if path == '/login/oauth/access_token' and method == 'POST':
            self.body()
            with lock:
                state['polls'] += 1
                mode = state['mode']
                if mode == 'auto':
                    mode = 'approve' if state['polls'] > 2 else 'wait'
            if mode == 'approve':
                return self.send(200, {'access_token': TOKEN, 'token_type': 'bearer', 'scope': 'repo'})
            if mode == 'deny':
                return self.send(200, {'error': 'access_denied'})
            return self.send(200, {'error': 'authorization_pending'})
        if path.startswith('/api/'):
            return self.api(method, path[len('/api'):], url.query)
        if '.git/' in path:
            return self.smart_http(method, path, url.query)
        return self.send(404, {'message': 'Not Found'})

    def api(self, method, path, query):
        if self.headers.get('Authorization') != f'Bearer {TOKEN}':
            return self.send(401, {'message': 'Bad credentials'})
        if path == '/user':
            return self.send(200, {'login': LOGIN})
        if path == '/user/repos' and method == 'POST':
            name = json.loads(self.body() or b'{}')['name']
            full = f'{LOGIN}/{name}'
            if os.path.exists(repo_dir(full)):
                return self.send(422, {'message': 'name already exists on this account'})
            git('init', '--bare', '-q', '--initial-branch=main', repo_dir(full))
            return self.send(201, {'full_name': full, 'private': True, 'html_url': f'https://github.com/{full}'})
        parts = path.strip('/').split('/')
        if len(parts) >= 3 and parts[0] == 'repos':
            full = f'{parts[1]}/{parts[2]}'
            if not os.path.isdir(repo_dir(full)):
                return self.send(404, {'message': 'Not Found'})
            rest = parts[3:]
            if not rest:
                return self.send(200, {'full_name': full, 'private': private_of(full), 'html_url': f'https://github.com/{full}'})
            if rest == ['branches']:
                refs = git('--git-dir', repo_dir(full), 'for-each-ref', '--format=%(refname:short)', 'refs/heads').stdout.split()
                return self.send(200, [{'name': r} for r in refs[:1]])
            if rest[0] == 'contents':
                ok = git('--git-dir', repo_dir(full), 'cat-file', '-e', 'HEAD:' + '/'.join(rest[1:])).returncode == 0
                return self.send(200, {'name': rest[-1]}) if ok else self.send(404, {'message': 'Not Found'})
        return self.send(404, {'message': 'Not Found'})

    def smart_http(self, method, path, query):
        body = self.body()
        auth = self.headers.get('Authorization', '')
        password = ''
        if auth.startswith('Basic '):
            try:
                password = base64.b64decode(auth[6:]).decode().split(':', 1)[1]
            except Exception:
                password = ''
        if password != TOKEN:
            return self.send(401, b'', {'WWW-Authenticate': 'Basic realm="fake-github"'})
        env = {
            **os.environ,
            'GIT_PROJECT_ROOT': ROOT, 'GIT_HTTP_EXPORT_ALL': '1', 'PATH_INFO': path, 'QUERY_STRING': query,
            'REQUEST_METHOD': method, 'CONTENT_TYPE': self.headers.get('Content-Type', ''),
            'CONTENT_LENGTH': str(len(body)), 'REMOTE_USER': LOGIN, 'REMOTE_ADDR': '127.0.0.1',
            'GIT_PROTOCOL': self.headers.get('Git-Protocol', ''),
        }
        out = subprocess.run(['git', 'http-backend'], input=body, env=env, capture_output=True).stdout
        head, _, payload = out.partition(b'\r\n\r\n')
        if not _:
            head, _, payload = out.partition(b'\n\n')
        status, headers = 200, {}
        for line in head.decode(errors='replace').splitlines():
            k, _, v = line.partition(':')
            if k.lower() == 'status':
                status = int(v.strip().split()[0])
            elif k:
                headers[k.strip()] = v.strip()
        self.send(status, payload, headers)


os.makedirs(os.path.join(ROOT, LOGIN), exist_ok=True)
ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
