# ADR-0004: AttemptとHistory Snapshotを分離する

- Status: Accepted
- Date: 2026-08-24

## Context

確実に観測した個々の解答と、最終日・最終状態しか分からない履歴表示では証拠の粒度が異なります。両者を同じeventとして扱うと、存在しない時刻や正誤系列を捏造します。

## Decision

`AttemptEventV1` と `HistorySnapshotV1` を別schema、別discriminator、別table、別storage APIにします。snapshotからattemptへの変換APIを作りません。由来と時間・状態精度を各recordに保持します。

## Consequences

review algorithmは証拠の不足を明示的に扱う必要があります。単純なevent列へ統合する利便性より、証拠の忠実性を優先します。
