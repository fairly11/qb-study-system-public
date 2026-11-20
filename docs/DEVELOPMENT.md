# 開発手順

## 必要環境

- Node.js 24.19.0
- pnpm 11.19.0
- Git
- iPhone・iPad版をビルドする場合は、macOSとXcode

バージョンの指定はルートの `package.json`、依存ライブラリの固定値は `pnpm-lock.yaml` で管理しています。

## 初回ビルドと検証

リポジトリ直下で実行します。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm verify
```

最初のビルドで、他のパッケージが参照する型定義と拡張のJavaScriptを生成します。
`pnpm verify` は `lint`、`typecheck`、`test`、`build` を順に実行します。
各工程だけを実行する場合は、`pnpm test` のように指定できます。

特定のパッケージを検証する例です。

```sh
pnpm verify:browser-extension
pnpm verify:history-collector
pnpm --filter @qb-study/review-engine test
```

全体の検査対象と個別テストの場所は [テスト方針](TEST_STRATEGY.md) に記載しています。

## 端末別のビルドとテスト

iPhone・iPad版は、共通処理のSwiftテストと、署名なしのシミュレータ向けビルドを行います。

```sh
pnpm test:ios-native
sh apps/ios-safari/scripts/check-ios-build.sh
```

Windows記録専用版は、配布構成を生成した後、その構成を使うテストを実行します。

```sh
pnpm build:windows-recorder
pnpm test:windows-recorder
```

復習計算を含む別構成のWindowsアプリは、次で検証します。

```sh
pnpm --filter @qb-study/windows-friend build
pnpm --filter @qb-study/windows-friend test
```

これらのテストは合成データと模擬通信を使用します。
Windowsのアクセス権やiOSの署名、Safariの権限は、対象OS上で別に確認します。

## ローカルの収集サービス

次のコマンドは収集サービスをビルドして起動します。
既定の待ち受け先は `127.0.0.1:8765` です。

```sh
pnpm --filter @qb-study/history-collector start
```

保存先を変更する場合は `QB_STUDY_DB_PATH` に絶対パスを指定します。
ポートは `QB_STUDY_COLLECTOR_PORT` で変更できます。
`.env.example` は設定例であり、サービスが `.env` を自動で読み込むわけではありません。
運用データはリポジトリやiCloud同期フォルダの外に置きます。

収集サービスの詳細は [README](../services/history-collector/README.md)、Notionの接続設定は [Notion同期](NOTION_SYNC.md) を参照してください。

## macOS配布物の生成

未記録の変更がない作業フォルダで、次を実行します。

```sh
pnpm release:trusted
```

拡張機能、Node.js用の収集プログラム、データ構造の更新用SQL、導入手順、第三者ライセンスを `artifacts/` 内のZIPへまとめます。
ファイルの一致確認用に `.zip.sha256` も生成します。
Chromeへの導入は「パッケージ化されていない拡張機能」の読み込みを使い、更新も手動で行います。
収集サービスの実行にはNode.jsが必要です。

## データ形式を変更する場合

TypeScript型とJSON Schemaは、`packages/contracts` の共通定義から生成します。

```sh
pnpm schemas:generate
pnpm verify
```

既存V1の必須項目、フィールドの意味、許可する値を壊す変更は行わず、新しい版を追加します。
変更理由と移行方針を [設計判断の記録](ADR/README.md) に残し、利用するパッケージを同時に確認してください。

SQLiteの構造変更は、`packages/storage/migrations/` に新しい連番SQLを追加します。
適用済みファイルは編集しません。
空のデータベースからの作成、再実行、失敗時の取り消し、追記専用の制約をテストします。
開発時の修復を、本番データへの手動SQLで行わないでください。
