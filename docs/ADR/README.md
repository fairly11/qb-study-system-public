# Architecture decision records

Accepted ADRは実装上の制約です。Proposed ADRは未解決事項であり、Acceptedになるまで関連する外部機能を実装しません。

| ADR | Status | Decision |
|---|---|---|
| [0001](0001-typescript-pnpm-monorepo.md) | Accepted | TypeScript pnpm monorepo |
| [0002](0002-sqlite-source-of-truth.md) | Accepted | SQLiteを正本とする |
| [0003](0003-versioned-json-contracts.md) | Accepted | バージョン付きJSON契約 |
| [0004](0004-attempts-and-snapshots.md) | Accepted | AttemptとSnapshotの分離 |
| [0005](0005-attempt-idempotency.md) | Accepted | Attemptのidempotencyと追記専用性 |
| [0006](0006-time-and-calendar-policy.md) | Accepted | UTC瞬間とAsia/Tokyo暦日 |
| [0007](0007-question-identifiers.md) | Accepted | 問題識別子の正規化 |
| [0008](0008-data-minimization-and-safe-logs.md) | Accepted | データ最小化と安全なログ |
| [0009](0009-model-neutral-review-v1.md) | Accepted | モデル中立のreview V1 |
| [0010](0010-external-integration-decisions.md) | Proposed | 外部連携の未解決事項 |
| [0011](0011-append-only-derived-records.md) | Accepted | 派生状態と追記専用実行記録の分離 |
| [0012](0012-browser-extension-qb-capture-consent.md) | Accepted | QB取得のdocument単位同意とfail-closed境界 |
| [0013](0013-local-loopback-history-collector.md) | Accepted | local loopback collectorとcommit後exact ACK |

| [0017](0017-automatic-qb-capture.md) | Accepted | QBの自動記録とセット由来に基づく学習区分 |
| [0018](0018-recovered-answer-evidence.md) | Accepted | 解答日時と選択番号が不明な確認済み解答の補完 |

| [0019](0019-ios-safari-recording.md) | Accepted（実機確認前） | iPhoneのSafariから端末保存とNotion同期 |

既存のAccepted ADRを編集して過去の判断を上書きせず、変更は新しいADRで置き換え関係と移行方針を記録します。
