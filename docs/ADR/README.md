# 設計判断の記録

ADR（Architecture Decision Record）は、実装方針とその理由を記録する文書です。
過去の判断が変更された場合は、状態欄と本文に置換先を示しています。
現行構成を先に知りたい場合は [アーキテクチャ](../ARCHITECTURE.md) を参照してください。

| ADR | 状態 | 決定 |
|---|---|---|
| [0001](0001-typescript-pnpm-monorepo.md) | 採用 | TypeScriptとpnpmによるモノレポ |
| [0002](0002-sqlite-source-of-truth.md) | 一部変更 | SQLiteによる端末内保存。Notion同期時は0014に従う |
| [0003](0003-versioned-json-contracts.md) | 採用 | バージョン付きJSON契約 |
| [0004](0004-attempts-and-snapshots.md) | 採用 | 解答イベントと履歴スナップショットの分離 |
| [0005](0005-attempt-idempotency.md) | 採用 | 再送と解き直しの区別、追記専用の履歴 |
| [0006](0006-time-and-calendar-policy.md) | 採用 | UTCの時刻とAsia/Tokyoの日付 |
| [0007](0007-question-identifiers.md) | 採用 | 問題識別子の正規化 |
| [0008](0008-data-minimization-and-safe-logs.md) | 採用 | 保存項目とログの制限 |
| [0009](0009-model-neutral-review-v1.md) | 採用 | 記憶モデルに依存しないV1の復習データ |
| [0010](0010-external-integration-decisions.md) | 一部解決 | 外部連携の課題と決定先 |
| [0011](0011-append-only-derived-records.md) | 採用 | 計算の現在値と過去の実行記録の分離 |
| [0012](0012-browser-extension-qb-capture-consent.md) | 一部置換 | 当初のページ別開始方式と取得条件。開始方式は0017へ移行 |
| [0013](0013-local-loopback-history-collector.md) | 採用 | 同じ端末での解答受信と、保存確定後の応答 |
| [0014](0014-notion-shared-original.md) | 採用 | Notionを複数端末共通の原本とする |
| [0015](0015-daily-review-model-and-selector.md) | 採用 | 記憶予測と日次復習候補の選択 |
| [0016](0016-daily-review-publication.md) | 一部変更 | 日次候補の固定と問題セット照合。学習区分は0017に従う |
| [0017](0017-automatic-qb-capture.md) | 採用 | 自動記録と学習区分の判定 |
| [0018](0018-recovered-answer-evidence.md) | 採用 | 解答時刻と選択番号が不明な記録の補完 |
| [0019](0019-ios-safari-recording.md) | 採用 | iPhone / iPadの端末内保存とNotion同期 |
