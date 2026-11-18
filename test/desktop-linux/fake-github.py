#!/usr/bin/env python3
"""A stand-in for github.com and api.github.com for the backup's GitHub sign-in (#231) and
disconnecting from it (#233).

shots.sh points AS_GITHUB_URL at http://127.0.0.1:<port> and AS_GITHUB_API_URL at
http://127.0.0.1:<port>/api. It answers the device flow, the few REST calls the core makes,
and Git's smart HTTP through `git http-backend` for the repositories it "creates" under
<root>/<owner>/<name>.git, with Basic auth that only takes the tokens it handed out.

Every approval hands out a new token, <token><n>, so revoking one leaves the others working.
A sign-in that asked for delete_repo gets that scope, and only its token may
DELETE /repos/<owner>/<name>. POST /credentials/revoke takes no authentication, like GitHub's.
GET /control/revoked lists the scopes of the tokens revoked so far, never the tokens.

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
# token -> {'scope': ..., 'revoked': bool}
tokens = {}


def live(token):
    t = tokens.get(token)
    return t is not None and not t['revoked']
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

    def do_DELETE(self):
        self.route('DELETE')

    def route(self, method):
        url = urlsplit(self.path)
        path = url.path
        if path == '/control/revoked':
            with lock:
                return self.send(200, {'revoked': sorted(t['scope'] for t in tokens.values() if t['revoked'])})
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
            delete = 'delete_repo' in (form.get('scope') or [''])[0]
            return self.send(200, {
                'device_code': 'fake-delete-code' if delete else 'fake-device-code', 'user_code': 'HQLC-RT4P' if delete else 'WDJB-MJHT',
                'verification_uri': 'https://github.com/login/device', 'expires_in': 900, 'interval': 1,
            })
        if path == '/login/oauth/access_token' and method == 'POST':
            form = parse_qs(self.body().decode())
            delete = (form.get('device_code') or [''])[0] == 'fake-delete-code'
            with lock:
                state['polls'] += 1
                mode = state['mode']
                if mode == 'auto':
                    mode = 'approve' if state['polls'] > 2 else 'wait'
            if mode == 'approve':
                scope = 'repo,delete_repo' if delete else 'repo'
                with lock:
                    token = f'{TOKEN}{len(tokens) + 1:02d}'
                    tokens[token] = {'scope': scope, 'revoked': False}
                return self.send(200, {'access_token': token, 'token_type': 'bearer', 'scope': scope})
            if mode == 'deny':
                return self.send(200, {'error': 'access_denied'})
            return self.send(200, {'error': 'authorization_pending'})
        if path.startswith('/api/'):
            return self.api(method, path[len('/api'):], url.query)
        if '.git/' in path:
            return self.smart_http(method, path, url.query)
        return self.send(404, {'message': 'Not Found'})

    def api(self, method, path, query):
        if path == '/credentials/revoke' and method == 'POST':
            # GitHub refuses an authenticated call here.
            if self.headers.get('Authorization'):
                self.body()
                return self.send(403, {'message': 'Forbidden'})
            with lock:
                for c in json.loads(self.body() or b'{}').get('credentials', []):
                    if c in tokens:
                        tokens[c]['revoked'] = True
            return self.send(202, {})
        auth = self.headers.get('Authorization', '')
        bearer = auth[len('Bearer '):] if auth.startswith('Bearer ') else ''
        if not live(bearer):
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
            if not rest and method == 'DELETE':
                if 'delete_repo' not in tokens[bearer]['scope']:
                    return self.send(403, {'message': 'Must have admin rights to Repository.'})
                shutil.rmtree(repo_dir(full))
                return self.send(204)
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
        if not live(password):
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
