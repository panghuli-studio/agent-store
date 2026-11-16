import argparse
import hashlib
from pathlib import Path
import shutil
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
DESTINATION = ROOT / 'apps/cli-gui/src-tauri/vendor/glib'
SHA256 = '233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5'


def inventory(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file()}


def main(check):
    with tempfile.TemporaryDirectory() as temporary:
        temporary = Path(temporary)
        archive = temporary / 'glib.crate'
        with urllib.request.urlopen('https://static.crates.io/crates/glib/glib-0.18.5.crate', timeout=60) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != SHA256:
            raise SystemExit('glib archive checksum mismatch')
        archive.write_bytes(data)
        with tarfile.open(archive) as bundle:
            bundle.extractall(temporary, filter='data')
        source = temporary / 'glib-0.18.5'
        target = source / 'src/variant_iter.rs'
        text = target.read_text()
        before = 'let p: *mut libc::c_char = std::ptr::null_mut();'
        if text.count(before) != 1 or text.count('                &p,') != 1:
            raise SystemExit('unexpected upstream VariantStrIter implementation')
        text = text.replace(before, 'let mut p: *mut libc::c_char = std::ptr::null_mut();')
        text = text.replace('                &p,', '                &mut p,')
        target.write_text(text)
        if check:
            if inventory(source) != inventory(DESTINATION):
                raise SystemExit('vendored glib differs from the verified upstream archive plus the security backport')
            print('Vendored glib matches upstream 0.18.5 plus gtk-rs-core#1343.')
        else:
            if DESTINATION.exists():
                raise SystemExit('vendor directory already exists; use --check to verify it')
            DESTINATION.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source, DESTINATION)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Reproduce the glib 0.18.5 backport of gtk-rs-core#1343.')
    parser.add_argument('--check', action='store_true')
    main(parser.parse_args().check)
