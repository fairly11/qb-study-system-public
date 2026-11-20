# AGENTS.md

このファイルはリポジトリ全体に適用されます。

## リポジトリ構成

- `apps/browser-extension`: QB解答イベント取得Chrome拡張の骨格
- `apps/ios-safari`: iPhone / iPad共通のSafari拡張、設定アプリ、Swiftの保存・Notion同期処理
- `apps/windows-recorder`: Windows向け記録専用アプリ
- `apps/set-builder`: 復習用問題セット生成アプリの骨格
- `services/history-collector`: 演習履歴収集・照合サービスの骨格
- `packages/contracts`: バージョン付きTypeScript型とJSON Schema
- `packages/storage`: SQLite、migration、永続化境界
- `packages/question-normalizer`: 国試問題番号の正規化
- `packages/review-engine`: 記憶状態・復習計画の純粋計算
- `tests/fixtures`: 内容を含まない安全な共通fixture
- `docs`: 仕様、設計、ADR

## 必須コマンド

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm verify
```

package単位では `pnpm --filter <package-name> <script>` を使います。作業完了前に必ず `build`、`test`、`lint`、`typecheck` をすべて実行してください。

## 変更ルール

- `packages/contracts` の公開型と生成済みJSON Schemaはコンポーネント間契約です。利用側だけの都合で勝手に変更しないでください。破壊的変更は既存V1を書き換えず、新しいversionを追加し、ADRと移行方針を用意します。
- `AttemptEventV1` と `HistorySnapshotV1` は異なる証拠です。snapshotから架空のattemptを生成してはいけません。
- `attempts`、選択番号、snapshots、plans/items、set/sync runs、system logsは追記専用です。`question_states` だけをupsert可能とし、review-engineから元証拠を変更する経路を追加してはいけません。
- 認証情報、cookie、token、個人情報をコミットしないでください。秘密をfixtureやログへコピーしてはいけません。
- QBの問題文、選択肢本文、解説、画像を取得・保存・fixture化・ログ出力してはいけません。
- QBの非公開APIを解析またはリバースエンジニアリングしてはいけません。
- 実サイトへのアクセスや操作は、対象と範囲についてその時点の明示的な許可がない限り行わないでください。
- 不確実な由来や精度を推測で補わず、契約の品質フィールドまたは未解決事項として残してください。
- SQLiteを正本とし、Google Sheetsを入力元や競合解決元にしないでください。
  Notion同期を有効にした範囲はADR-0014の例外です。ユーザーの指定によりNotionを複数Mac共通の原本、各MacのSQLiteを耐久性のある送信待ちと控えにします。既存V1とGoogle Sheets契約は変更しません。

## コード品質

- TypeScript strict設定を弱めないでください。
- package間依存は `workspace:*` を使用し、循環依存を作らないでください。
- `packages/review-engine` は純粋計算に保ち、`packages/storage` をimportしないでください。
- ログはallowlist型の安全な識別子・件数・event codeだけに限定してください。自由形式payloadを追加しないでください。
- 日時の瞬間はoffset付きISO 8601として扱い、保存時にUTC `Z` へ正規化します。date-only値に架空の時刻を付けません。

## iPhone / iPad版の検証

iPhone / iPad版を変更した場合は、上記に加えて `pnpm test:ios-native` を実行します。
SwiftのmacOSテスト成功は、iOSビルドや実機確認の代わりにはしません。
XcodeとiOS SDKが利用できる場合は `sh apps/ios-safari/scripts/check-ios-build.sh` で署名なしのシミュレータ向けビルドを確認します。
端末の接続キーや署名用のローカル設定をGit、配布物、ログへ含めません。
