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
        'html_visual_inspection_note': 'Browser capability disabled in this development session.',
    }
    release_path.write_text(json.dumps(release, ensure_ascii=False, indent=2) + '\n')
    validation = '''QB Study Friend 1.1.0-preview 検証記録（2026年10月29日）

【完了した検証】
Macの開発環境で、共通プログラムのコード検査・型検査・ビルドと727件のテストが成功しました。
生成されたWindows配布版について34件のテストが成功しました。
・Chrome/Safariの記録、ページをまたぐ履歴の読取、重複の抑制
・通常学習／復習／未分類、復習実施数の条件
・翌04:00の境界、最大100問、同日計画の固定
・新規設定と既存設定の保持、設定失敗時のエラー保持
・秘密を出力しないClaude用コマンド、確認済みの番号による登録、途中再開
・記録を保存後に終了し、再起動しても履歴を保持する動作
PowerShell（Windowsの導入・起動用スクリプト）には13件の構文・ファイル整合性検査を行いました。
公式Node.jsのWindows x64/ARM64の配布ハッシュと、同梱の固定値は一致しています。
ZIP内の全ファイルをチェックサムで照合し、文書内のローカルリンク、秘密の接続キーの形式、
開発者個人のフォルダー・端末名・学習データの混入を検査しました。

【未実施】
Windows 11実機でのインストール、アクセス権、実際のChromeでの記録、本人のQB/Notionへの送信。
Claude Desktopからの実操作と予約実行。iPhoneアプリの配布・本人端末での接続確認。
説明書のブラウザ表示の目視確認（開発環境のブラウザ操作機能が無効のため）。
PowerShell検査はMac上の公式実行環境で行っており、Windowsの設定は変更していません。

【受領者による最初の確認】
docs/manual.html に沿って自分のNotionへ接続し、普段の学習で1〜2問解答します。
PCとNotionの問題番号・正誤・選択記号・日時が一致するまで、導入完了とは扱いません。
iPhoneアプリはこのZIPに含みません。既存インストールの自動更新も含みません。
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
