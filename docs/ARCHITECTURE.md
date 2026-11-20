# Architecture

## 全体像

```text
browser-extension ──AttemptEventV1──┐
                                    ├─> history-collector ─> SQLite (source of truth)
external baseline ─HistorySnapshotV1┘                             │
                                                                  v
                                                        review-engine
                                                                  │
                                                QuestionStateV1 / ReviewPlanV1
                                                                  v
                                                           set-builder

SQLite ──future one-way summary──> Google Sheets (reporting only)
```

外部baselineは将来の入力境界を示す概念であり、この初期版に取得処理はありません。

## 依存方向

- `apps/*` と `services/*` は必要な公開packageだけへ依存します。
- `packages/contracts` と `packages/question-normalizer` は下位の共有基盤です。
- `packages/storage` はcontractsを保存するadapterです。
- `packages/review-engine` はI/Oを持たない純粋計算packageとし、storageをimportしません。
- package間依存は `workspace:*` とし、循環依存を禁止します。

## データフロー上の不変条件

1. 入力境界でJSON Schemaと意味制約を検証します。
2. 問題番号は共通normalizerで正規化し、推測できない形式を拒否します。
3. exactな瞬間はoffset必須で受け、保存時はUTC `Z` とします。
4. date-only値は `YYYY-MM-DD` と `Asia/Tokyo` を保持し、時刻へ変換しません。
5. attemptとsnapshotは別API・別table・別discriminatorのまま保存します。
6. review-engineは元証拠を書き換えません。
7. set-builderと将来の同期はrun単位で結果を追記し、SQLiteの履歴を正本とします。

## ストレージ

SQLite接続は `StorageDriver` 境界の内側に置きます。初期adapterはNode.js 24の `node:sqlite` を使用します。DBはrepoやiCloud同期対象ではなく、原則として利用者のApplication Support配下へ置きます。

Migrationはforward-onlyの連番SQLです。各migrationのSHA-256を記録し、番号欠落、適用済みchecksumの変更、部分適用をfail closedにします。attempts、選択番号、history snapshots、review plans/items、set/sync runs、system logsはUPDATE/DELETE拒否triggerで追記専用にします。`question_states` だけは再計算結果のupsert対象として更新可能に保ちます。

review planはitems/reasonsを含めて1 transactionで追加します。set/sync runの行は終了状態が確定した時点で1回だけ追加し、途中経過は構造化された追記専用logへ記録します。再試行は既存runを更新せず、新しいrun IDを使います。

## コンポーネントの実行境界

- browser-extensionはChrome MV3のstatic bootstrapをQBのdefault HTTPS port上のexact `/quiz` targetへ限定し、document単位の明示同意後だけproduction DOM adapterとcapture用`MutationObserver`を開始します。tab更新時はevent順序ではなくexact document identityをprobeして同意sessionを照合し、同じdocument内では問題数に依存せずcaptureを継続します。outboxは `storage.local`、ephemeral consentは `storage.session` に分離し、collector通信はloopbackだけです。popupはextension-page-only routeからallowlist済み診断codeと、outbox・送信済みcache由来のsafeな直近記録summaryだけを取得します。詳細は [ADR-0012](ADR/0012-browser-extension-qb-capture-consent.md) に従います。
- history-collectorだけがattempt append APIの利用者になります。Node.js 24の
  local serverはIPv4 `127.0.0.1`へだけbindし、exact
  `POST /v1/attempt-events`でstrict `AttemptEventV1`を受けます。既存storage
  transactionが`inserted`または`duplicate`を返した後だけ、同じevent IDの
  exact ACKを返します。詳細は [ADR-0013](ADR/0013-local-loopback-history-collector.md)
  に従います。
- review-engineは受け取った値から結果を返し、DB、ネットワーク、環境変数を直接読みません。
- set-builder初期版はpackage骨格だけで、外部サイト操作を行いません。

## バージョニング

公開wire contractは `schema_version` と固定 `record_type` を持ちます。V1公開後の破壊的変更はV1を上書きせずV2として追加します。生成済みschemaの差分は検証対象です。

## Worktree並行開発

単一commitを基点に、4コンポーネントを別branch/worktreeで開発できます。contractsの変更は独立branchで先行合意し、利用側が独自に変更しない運用とします。具体的コマンドは [DEVELOPMENT.md](DEVELOPMENT.md) に記載します。
