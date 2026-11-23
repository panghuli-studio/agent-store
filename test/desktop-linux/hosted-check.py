#!/usr/bin/env python3
"""Checks a skill installed from ClawHub or SkillHub (#156) against its catalog listing.

shots.sh runs it after the desktop client or aas installed <id>. It reads the resource from
the catalog API, finds the library copy whose marker names that resource, and checks that
every listed file is there with the listed size and SHA-256, that the marker records the
site and version, and that Claude and Codex both link to the copy. Prints the library slug
on success; prints the first mismatch to stderr and exits 1 otherwise.

Usage: hosted-check.py <catalog-url> <id> <library-dir> <home>
"""
import hashlib
import json
import os
import sys
import urllib.parse
import urllib.request


def fail(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


def main():
    if len(sys.argv) != 5:
        fail(__doc__.strip().splitlines()[-1])
    api, rid, lib, home = sys.argv[1:]
    url = f"{api.rstrip('/')}/api/resources/{urllib.parse.quote(rid, safe=':/')}"
    with urllib.request.urlopen(url, timeout=30) as r:
        res = json.load(r)['resource']
    hosted = res.get('hosted')
    if not hosted:
        fail(f'{rid}: the catalog has no hosted listing for it')

    found = None
    for name in sorted(os.listdir(lib)) if os.path.isdir(lib) else []:
        try:
            with open(os.path.join(lib, name, '.agent-store.json')) as f:
                marker = json.load(f)
        except (OSError, ValueError):
            continue
        if marker.get('manifest', {}).get('resourceId') == rid:
            found = name, marker
            break
    if not found:
        fail(f'{rid}: no library copy in {lib} has its marker')
    slug, marker = found
    want = {'site': hosted['site'], 'listingId': hosted['listingId'], 'version': hosted['version']}
    if marker.get('hosted') != want or marker.get('source') is not None:
        fail(f'{rid}: marker records {marker.get("hosted")} / source {marker.get("source")}, want {want}')

    copy = os.path.join(lib, slug)
    for f in res['files']:
        path = os.path.join(copy, f['path'])
        try:
            with open(path, 'rb') as fh:
                data = fh.read()
        except OSError as e:
            fail(f'{rid}: {f["path"]} missing ({e})')
        if len(data) != f['size'] or hashlib.sha256(data).hexdigest() != f['sha256']:
            fail(f'{rid}: {f["path"]} does not match the listed size and SHA-256')

    deployed = marker['runtimeNames']['claude']
    for tool in ('.claude', '.codex'):
        link = os.path.join(home, tool, 'skills', deployed)
        if not os.path.islink(link) or os.readlink(link) != copy:
            fail(f'{rid}: {link} does not link to {copy}')
    print(slug)


main()
