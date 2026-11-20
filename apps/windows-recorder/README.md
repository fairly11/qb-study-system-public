# QB Record for Windows

Windows 11のChromeで解いたQBの記録を、MacやiPhoneと共通のNotionへ送るアプリです。
Windowsでは解答の記録と同期を行い、復習候補の計算とセット作成はMacで行います。
すでにNotionの解答ログ、問題マスター、復習計画ページを使っている環境に追加します。

ZIPから導入する場合は、[導入手順](docs/manual.html)を参照してください。
WindowsだけでNotionの初期設定と復習計算まで行う構成には、[QB Study Friend](../windows-friend/README.md)を使います。

## ビルドと検証

リポジトリ直下で実行します。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm verify
pnpm build:windows-recorder
pnpm test:windows-recorder
```

配布用テストは、一時フォルダーと模擬Notion応答を使って保存・同期・設定画面を検査します。
PowerShellの構文検査は `test/check-powershell.ps1` で行います。

Windows PowerShell 5.1の通常ユーザーで `test/check-windows-acl.ps1 -PackageRoot <展開先>` を実行すると、保存先のアクセス権を一時フォルダーで検査できます。
検査対象は、初回設定、再設定、作成後のファイルの保護、不要な読み取り許可の拒否です。
保存先は、実行したユーザー、SYSTEM、Administratorsだけがアクセスできる設定にします。

## ZIPの作成

`scripts/package.py` は検証結果と配布ファイルを検査してZIPを作成します。
接続先は、解答ログ・問題マスター・復習計画ページの3つのIDを記した `connection-targets.json` で指定します。
Notion接続キーはインストール後の操作画面から入力します。

Windows実機での導入、アクセス権、実際のQB解答からNotionへの同期は未検証です。
導入先での確認手順は [導入手順](docs/manual.html)に記載しています。
