# QB Study Friend for Windows

Windows 11でQBの解答を記録し、Notionに集めた履歴から毎日の復習候補を選ぶアプリです。
Chromeの記録拡張、Notionの初期設定画面、復習計算、QBセットの照合機能をまとめています。
Macで復習計算を行う構成には、[Windows記録専用版](../windows-recorder/README.md)を使います。

ZIPから導入する場合は、[導入と毎日の使い方](docs/manual.html)を参照してください。
Claudeに導入やセット作成を任せる場合は、[Claude用の手順](docs/Claude-guide.html)を使えます。

## ソースの構成

- `template/`: インストーラー、起動スクリプト、操作画面。
- `docs/`: 導入手順とClaudeへ渡す依頼文。
- `src/`: 共有する記録・復習処理をWindows版へ組み込む入口。
- `scripts/portable-source.mjs`: 保存先、アクセス権、終了処理などをWindows向けに調整する処理。

復習計算とNotionの読み取りは、Mac版と同じ共有ソースを使います。
Windows向けの調整はビルド時に適用し、対応するコードが見つからない場合は停止します。
変更は元ソースへ加え、生成済みのJavaScriptは直接編集しないでください。

## ビルドと検証

リポジトリ直下で実行します。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm verify
pnpm --filter @qb-study/windows-friend build
pnpm --filter @qb-study/windows-friend test
```

生成先は `dist/QBStudyFriend-Windows11-1.1.0-preview` です。
ビルドをやり直すと、このフォルダーの内容を置き換えます。
`SOURCE-MANIFEST.json` には入力ソース、`CHECKSUMS.sha256` には配布ファイルのハッシュを記録します。

PowerShellの構文と配布ファイルは `test/check-powershell.ps1` で検査できます。
Windowsのアクセス権とインストーラーの動作は、Windows実機で別途確認してください。

## ZIPの作成と更新

`scripts/package.py` は検証結果のJSONを読み、配布ファイルと文書内のリンクを検査してZIPを作成します。
1.1.0-preview向けに、共通727テスト、配布版34テスト、PowerShell13検査の結果を受け取る仕様です。
共有コードの更新で件数が変わった場合は、検証条件も見直す必要があります。実際と異なる件数を入力して通さないでください。

インストーラーは新規導入用です。
既存の設置先がある場合は停止するため、更新のために履歴フォルダーを削除しないでください。
Windows実機での導入、実際のQBとNotionでの記録、Claudeからの操作は未検証です。
