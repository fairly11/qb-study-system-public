# Development

## 必要環境

- Node.js 24.19.0
- pnpm 11.19.0
- Git

Nodeとpnpmのversionはroot設定に従ってください。Gitのglobal/local user設定は変更しません。

## 初期化と検証

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm verify
```

特定packageだけを確認する例:

```sh
pnpm verify:browser-extension
pnpm verify:set-builder
pnpm verify:history-collector
pnpm verify:contracts
pnpm verify:storage
pnpm verify:question-normalizer
pnpm verify:review-engine
```

各aliasはrootから `pnpm --filter <package-name> verify` を実行します。個別工程だけを確認するときは、`pnpm --filter @qb-study/review-engine test` のように `build`、`test`、`lint`、`typecheck` を指定できます。

schemaを変更する場合は、contracts packageの生成コマンドでJSON Schemaを更新し、schema checkを含む `pnpm verify` を実行します。既存V1へ破壊的変更を入れません。

## 環境変数

`.env.example` を参照し、実値を含む `.env` はcommitしません。本番SQLiteはiCloudとrepoの外側に置きます。この初期版にはGoogle Sheets認証やQB認証の設定はありません。

## Local history collector

既定のSQLite pathとport `8765`でcollectorを起動します。

```sh
pnpm --filter @qb-study/history-collector start
```

portを変更する場合は`QB_STUDY_COLLECTOR_PORT`、DBを変更する場合はabsolute pathの
`QB_STUDY_DB_PATH`だけを設定します。hostはIPv4 `127.0.0.1`、pathは
`/v1/attempt-events`に固定され、認証情報用の環境変数はありません。停止は
`SIGINT`または`SIGTERM`を使用します。詳細は
`services/history-collector/README.md`とADR-0013を参照してください。

## 信頼ユーザー向けmacOS配布物

commit済みかつcleanなworktreeから、拡張機能とstandalone collectorを1つの
ZIPへまとめます。

```sh
pnpm release:trusted
```

配布コマンドはTypeScriptの全projectを強制再buildし、生成先をgit管理外の
`artifacts/`とします。ZIPにはChromeへ「パッケージ化されていない拡張機能」
として読み込む6ファイル、Node.js 24用collector bundle、migration、第三者
license、導入・更新・削除手順、内部checksumを含みます。利用者のSQLite、outbox、
認証情報、source map、`node_modules`、repository情報は含めません。外部checksumは
同名の`.zip.sha256`で生成されます。

配布前にZIPの`README.ja.md`を確認し、受領者へZIPとchecksumを別経路で共有して
ください。これは信頼ユーザー向けのmacOS betaであり、Chrome Web Storeによる
審査、自動更新、署名付き配布を代替するものではありません。

## 4コンポーネントのworktree

cleanな `main` と初期commitがある状態で、repo rootから次を実行します。directory名とbranch名は例です。

```sh
git worktree add ../qb-study-browser-extension -b feature/browser-extension main
git worktree add ../qb-study-history-collector -b feature/history-collector main
git worktree add ../qb-study-review-engine -b feature/review-engine main
git worktree add ../qb-study-set-builder -b feature/set-builder main
```

各worktreeでは同じlockfileから依存関係を導入し、対象packageをfilterして検証します。共有契約の変更が必要な場合は、利用側worktreeで独自変更せず、contracts変更を先に合意・統合します。

一時的な検証用worktreeは、変更がなく不要であることを確認してから明示的なpathを指定して削除します。

```sh
git worktree remove ../qb-study-browser-extension
git worktree remove ../qb-study-history-collector
git worktree remove ../qb-study-review-engine
git worktree remove ../qb-study-set-builder
git worktree prune
```

## Migration開発

- 連番を飛ばさず、新しいforward-only SQL fileを追加します。
- 適用済みmigrationを編集しません。
- schema変更、index、trigger、rollback挙動をmigration testで確認します。
- production DBに対する手動SQLや破壊的修復を開発手順にしません。

## 外部操作

開発・テストはsynthetic fixtureだけで完結させます。実QBサイト、非公開API、Google Sheetsには接続しません。外部操作を導入する後続作業では、対象、権限、dry-run、承認、監査結果を別途設計します。
