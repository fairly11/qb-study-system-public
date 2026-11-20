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
    'stop.cmd', 'review.cmd', 'autostart-on.cmd', 'autostart-off.cmd',
}
ROOT_DIRS = {'app', 'scripts', 'browser-extension', 'collector', 'docs', 'licenses'}
EXTENSIONS = {'.txt', '.json', '.sha256', '.cmd', '.ps1', '.mjs', '.js', '.css', '.html', '.sql'}
PRIVATE = [
    re.compile(r'/Users/[^/\s"\']+/'),
    re.compile(r'\b[A-Za-z0-9][A-Za-z0-9-]*\.local\b', re.I),
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
        'app/core.mjs', 'app/launcher.mjs', 'app/review-runner.mjs',
        'collector/dist/collector.mjs', 'collector/dist/review.mjs',
        'browser-extension/manifest.json', 'docs/manual.html', 'docs/Claude-guide.html',
        'docs/CLAUDE_SETUP_PROMPT.txt', 'docs/CLAUDE_DAILY_PROMPT.txt', 'docs/Validation-ja.txt',
    }
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
    if set(evidence) != {'source', 'distribution', 'powershell'}:
        raise ValueError('VERIFICATION_FIELDS_INVALID')
    if evidence['source'] != {'lint': 'passed', 'typecheck': 'passed', 'build': 'passed', 'tests_passed': 727}:
        raise ValueError('SOURCE_VERIFICATION_REQUIRED')
    if evidence['distribution'] != {'tests_passed': 34, 'tests_failed': 0} or evidence['powershell'] != {'checks_passed': 13}:
        raise ValueError('DISTRIBUTION_VERIFICATION_REQUIRED')
    release_path = root / 'RELEASE.json'
    release = json.loads(release_path.read_text())
    if release['version'] != '1.1.0-preview' or root.name != 'QBStudyFriend-Windows11-1.1.0-preview':
        raise ValueError('RELEASE_VERSION_MISMATCH')
    release['verification'] = {
        'environment': 'macOS development environment', 'automated_checks': evidence,
        'powershell_scope': 'syntax and portable validation; no Windows installer or ACL execution',
        'windows_device_tested': False, 'live_friend_notion_tested': False, 'live_friend_qb_tested': False,
        'html_links_checked': True, 'html_visual_inspection': False,
        'html_visual_inspection_note': 'Rendered HTML appearance has not been checked.',
    }
    release_path.write_text(json.dumps(release, ensure_ascii=False, indent=2) + '\n')
    validation = '''QB Study Friend 1.1.0-preview 検証の範囲

【自動テスト】
検査項目と成功件数は RELEASE.json の verification.automated_checks を参照してください。
記録と同期は合成データ、模擬Notion応答、一時的な保存先を使って検査します。
対象には、再送時の重複防止、学習区分、復習対象日の境界、同日計画の固定、
初期設定の再開、コマンド操作、記録を保持したままの終了が含まれます。
PowerShell検査は構文と配布ファイルを対象とします。

【未検証】
Windows 11実機でのインストールとアクセス権。
実際のChromeでの解答記録とNotionへの同期。
Claudeデスクトップからの操作と定期実行。
HTML説明書の表示。

【導入後の確認】
docs/manual.html に従ってNotionへ接続し、普段の学習で1〜2問解答します。
PCとNotionの問題番号、正誤、選択記号、日時が一致することを確認してください。
'''
    (root / 'docs/Validation-ja.txt').write_text(validation, encoding='utf-8-sig')
    files = inventory(root)
    links = check_links(files)
    sums = ''.join(digest(data) + '  ' + name + '\n' for name, data in sorted(files.items()) if name != 'CHECKSUMS.sha256')
    (root / 'CHECKSUMS.sha256').write_text(sums)
    files['CHECKSUMS.sha256'] = sums.encode()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(root.name + '/' + name, date_time=(2026, 10, 29, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    with zipfile.ZipFile(destination) as archive:
        if archive.testzip() is not None or len(archive.namelist()) != len(files):
            raise ValueError('ARCHIVE_VERIFY_FAILED')
        expected_names = {root.name + '/' + name for name in files}
        if set(archive.namelist()) != expected_names:
            raise ValueError('ARCHIVE_PATHS_FAILED')
        for name, data in files.items():
            if archive.read(root.name + '/' + name) != data:
                raise ValueError('ARCHIVE_READBACK_FAILED')
    sha = digest(destination.read_bytes())
    destination.with_suffix('.zip.sha256').write_text(sha + '  ' + destination.name + '\n')
    print(json.dumps({'event_code': 'FRIEND_ARCHIVE_VERIFIED', 'file': destination.name,
                      'files': len(files), 'local_html_links': links, 'bytes': destination.stat().st_size,
                      'sha256': sha, 'windows_device_tested': False}))


if __name__ == '__main__':
    main()
