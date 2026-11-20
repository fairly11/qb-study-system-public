#!/usr/bin/env python3
"""Finalize, audit, and archive a verified, credential-free friend distribution."""
import argparse
import hashlib
import json
import re
import stat
import zipfile
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit

ROOT_FILES = {
    'README.txt', 'RELEASE.json', 'SOURCE-MANIFEST.json', 'CHECKSUMS.sha256',
    'THIRD_PARTY_NOTICES.json', 'node-release.json', 'install.cmd', 'start.cmd',
    'stop.cmd', 'autostart-on.cmd', 'autostart-off.cmd',
}
ROOT_DIRS = {'app', 'scripts', 'browser-extension', 'collector', 'docs', 'licenses'}
EXTENSIONS = {'.txt', '.json', '.sha256', '.cmd', '.ps1', '.mjs', '.js', '.css', '.html', '.sql'}
PRIVATE = [
    re.compile(r'/Users/[^/\s"\']+/'),
    re.compile(r'\b(?:ntn|secret)_[a-zA-Z0-9]{20,}\b'),
]


class Links(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.links, self.ids, self.cells = [], set(), []
        self.feed(text)
        if self.cells:
            raise ValueError('HTML_CELL_NOT_CLOSED')

    def handle_starttag(self, tag, attrs):
        if tag in ('td', 'th'):
            if self.cells:
                raise ValueError('HTML_CELL_NOT_CLOSED')
            self.cells.append(tag)
        values = dict(attrs)
        if 'id' in values:
            if values['id'] in self.ids:
                raise ValueError('HTML_DUPLICATE_ID')
            self.ids.add(values['id'])
        for name in ('href', 'src'):
            if name in values:
                self.links.append(values[name])

    def handle_endtag(self, tag):
        if tag in ('td', 'th'):
            if not self.cells or self.cells.pop() != tag:
                raise ValueError('HTML_CELL_MISMATCH')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inventory(root):
    result = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('PACKAGE_SYMLINK_REJECTED')
        relative = path.relative_to(root).as_posix()
        first = relative.split('/')[0]
        if first not in ROOT_DIRS | ROOT_FILES or any(part.startswith('.') for part in path.relative_to(root).parts):
            raise ValueError('PACKAGE_UNEXPECTED_PATH: ' + relative)
        if path.is_dir():
            continue
        if not path.is_file() or path.suffix not in EXTENSIONS:
            raise ValueError('PACKAGE_UNEXPECTED_FILE: ' + relative)
        content = path.read_bytes()
        text = content.decode('utf-8-sig')
        if any(pattern.search(text) for pattern in PRIVATE):
            raise ValueError('PACKAGE_PRIVATE_CONTENT: ' + relative)
        if path.suffix == '.cmd' and re.search(rb'(?<!\r)\n', content):
            raise ValueError('CMD_LINE_ENDINGS: ' + relative)
        result[relative] = content
    if not ROOT_FILES <= set(result):
        raise ValueError('PACKAGE_ROOT_INCOMPLETE')
    required = {
        'app/core.mjs', 'app/launcher.mjs', 'app/server.mjs', 'app/notion-setup.mjs',
        'collector/dist/collector.mjs', 'browser-extension/manifest.json',
        'docs/manual.html', 'docs/Validation-ja.txt',
    }
    if any('review.cmd' in name or 'review-runner' in name or name.endswith('/review.mjs') for name in result):
        raise ValueError('RECORDER_CALCULATOR_ENTRY_REJECTED')
    if not required <= set(result):
        raise ValueError('PACKAGE_CONTENT_INCOMPLETE')
    return result


def check_links(files):
    pages = {name: Links(data.decode('utf-8-sig')) for name, data in files.items() if name.endswith('.html')}
    count = 0
    for name, page in pages.items():
        for link in page.links:
            parsed = urlsplit(link)
            if parsed.scheme or parsed.netloc:
                continue
            if parsed.path.startswith('/'):
                # The dashboard serves a fixed public asset allowlist from app/.
                if name != 'app/index.html' or parsed.path not in ('/style.css', '/client.js'):
                    raise ValueError('HTML_ABSOLUTE_LINK: ' + name)
                target = 'app' + parsed.path
            else:
                target = str(PurePosixPath(name).parent / unquote(parsed.path)) if parsed.path else name
            if '..' in PurePosixPath(target).parts or target not in files:
                raise ValueError('HTML_BROKEN_LINK: ' + name + ' -> ' + link)
            if parsed.fragment and (target not in pages or unquote(parsed.fragment) not in pages[target].ids):
                raise ValueError('HTML_BROKEN_ANCHOR: ' + name + ' -> ' + link)
            count += 1
    return count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--package-root', required=True, type=Path)
    parser.add_argument('--verification', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    root, destination = args.package_root.resolve(), args.output.resolve()
    if destination.exists() or destination.with_suffix('.zip.sha256').exists():
        raise ValueError('ARCHIVE_EXISTS_NO_OVERWRITE')
    evidence = json.loads(args.verification.read_text())
    if any(evidence.get('source', {}).get(key) != 'passed' for key in ('build', 'lint', 'typecheck', 'test')):
        raise ValueError('SOURCE_VERIFICATION_REQUIRED')
    if evidence.get('distribution', {}).get('tests_failed') != 0 or evidence.get('distribution', {}).get('tests_passed', 0) < 1:
        raise ValueError('DISTRIBUTION_VERIFICATION_REQUIRED')
    if evidence.get('powershell', {}).get('status') != 'passed' or evidence.get('node_official_hashes') != 'matched':
        raise ValueError('PLATFORM_VERIFICATION_REQUIRED')
    release_path = root / 'RELEASE.json'
    release = json.loads(release_path.read_text())
    if release['version'] != '0.1.1-preview' or root.name != 'QBRecord-Windows11-0.1.1-preview':
        raise ValueError('RELEASE_VERSION_MISMATCH')
    release['verification'] = {
        'environment': 'macOS development environment', 'automated_checks': evidence,
        'powershell_scope': 'syntax and portable checks only; Windows installer and ACL untested',
        'windows_device_tested': False, 'live_notion_tested': False, 'live_qb_tested': False,
        'html_visual_inspection': False, 'html_visual_inspection_note': 'In-app browser is unavailable.',
    }
    release_path.write_text(json.dumps(release, ensure_ascii=False, indent=2) + '\n')
    validation = 'QB記録 Windows版 0.1.1-preview 検証記録\n\n'
    validation += '共通プログラムの作成、コード検査、型検査、テストに合格しました。\n'
    validation += '配布物のテスト: ' + str(evidence['distribution']['tests_passed']) + '件成功、失敗0件。\n'
    validation += '通常学習と復習、116回以前の記録、再送時の重複防止、終了後の保存、未接続時の受信停止を確認しました。\n'
    validation += '既存Notionへの設定検査は模擬応答を使い、データベース新設・既存設定の上書きがないことを確認しました。\n'
    validation += 'PowerShellの構文と配布ファイルを検査し、Nodeの公式検査値と固定値の一致を確認しました。\n\n'
    validation += '未検証: Windows実機の導入、Windowsのアクセス権、実Chromeの解答、本人のNotionへの到達。\n'
    validation += 'この検証では本番QBやNotionへ試験用データを送信していません。\n'
    (root / 'docs/Validation-ja.txt').write_text(validation, encoding='utf-8-sig')
    files = inventory(root)
    links = check_links(files)
    # Calculator functions must not be reachable from shipped modules.
    for name in ('app/core.mjs', 'collector/dist/collector.mjs'):
        if b'generateDailyReviewPlan' in files[name] or b'class ReviewJournal' in files[name]:
            raise ValueError('RECORDER_CALCULATOR_BUNDLE_REJECTED')
    sums = ''.join(digest(data) + '  ' + name + '\n' for name, data in sorted(files.items()) if name != 'CHECKSUMS.sha256')
    (root / 'CHECKSUMS.sha256').write_text(sums)
    files['CHECKSUMS.sha256'] = sums.encode()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(root.name + '/' + name, date_time=(2026, 11, 17, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    with zipfile.ZipFile(destination) as archive:
        if archive.testzip() is not None or set(archive.namelist()) != {root.name + '/' + name for name in files}:
            raise ValueError('ARCHIVE_VERIFY_FAILED')
        for name, data in files.items():
            if archive.read(root.name + '/' + name) != data:
                raise ValueError('ARCHIVE_READBACK_FAILED')
    sha = digest(destination.read_bytes())
    destination.with_suffix('.zip.sha256').write_text(sha + '  ' + destination.name + '\n')
    print(json.dumps({'event_code': 'RECORDER_ARCHIVE_VERIFIED', 'file': destination.name,
                      'files': len(files), 'local_html_links': links, 'bytes': destination.stat().st_size,
                      'sha256': sha, 'windows_device_tested': False}))


if __name__ == '__main__':
    main()
