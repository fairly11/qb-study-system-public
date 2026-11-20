# Windows 11 友人配布版

`template/` はWindowsの導入・起動・操作画面、`docs/` は受領者とClaude向けの説明書です。
`src/` と `scripts/portable-source.mjs` は現行の共有TypeScript実装からWindows用プログラムを組み立てる入口です。
Macのインストール先や実行中のサービスは変更しません。

復習計算とNotionの読取は共有ソースを使います。Windows専用の変更は、保存先、アクセス権の検査、ディレクトリ書込み、終了通知と計画日の固定に限定しています。
共有ソースの置換位置が変わった場合はビルドを停止します。生成済みのJavaScriptを手で修正しないでください。

## 再生成と検証

リポジトリ直下で実行します。

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm --filter @qb-study/windows-friend build
pnpm --filter @qb-study/windows-friend test
```

`test/check-powershell.ps1` は公式PowerShellで構文と配布ファイルを検査します。
Windows以外での実行は、WindowsのインストーラーやACLの実機確認を意味しません。

`dist/QBStudyFriend-Windows11-1.1.0-preview` が生成物です。
`build` はこの生成先だけを作り直します。インストール済みのデータには触れません。
`SOURCE-MANIFEST.json` にコンパイル入力のハッシュ、`CHECKSUMS.sha256` に配布ファイルのハッシュを保存します。

`package.py` は検証結果JSONを受け取り、検証記録、配布ファイルの検査、ZIPとチェックサムを作ります。
検証結果は実際に成功したログから作成してください。この版では共通727テスト、配布版34テスト、PowerShell13検査を要求します。
古いZIPや同名の既存ZIPを上書きしません。

## 配布境界

新規インストール用です。既存の設置先があると安全に停止し、自動更新はしません。
実際のWindows、受領者本人のQB・Notion、Claude経由での初回操作は未検証です。
ユーザーのデータ、設定、秘密、ログ、iPhoneアプリは同梱しません。
