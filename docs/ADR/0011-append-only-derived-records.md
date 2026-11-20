# ADR-0011: 派生状態と追記専用実行記録の分離

- Status: Accepted
- Date: 2026-08-24

## Context

復習計算の現在値と、生成済みplan・外部処理run・監査logでは更新の意味が異なります。現在値は再計算で置き換える必要がありますが、過去の計画や実行結果を上書きすると監査可能性が失われます。

## Decision

`question_states` はquestionごとの派生した現在値としてupsert可能にします。`review_plans`、`review_plan_items`、`review_plan_item_reasons`、`set_creation_runs`、`sync_runs`、`system_logs`、`system_log_counters` は追記専用とし、DB triggerでUPDATE/DELETEを拒否します。

review planとそのitems/reasonsは1 transactionで追加します。set/sync runは終了状態が確定してから1行を追加し、途中経過は構造化logとして追記します。再試行時は既存行を変更せず新しいrun IDを発行します。

## Consequences

再計算された現在状態を効率よく保存しながら、計画・実行・監査履歴を改変せず保持できます。将来のwriter APIはplan一式のtransactional insertとterminal run insertを提供し、これらのtableへ汎用update APIを公開してはいけません。
