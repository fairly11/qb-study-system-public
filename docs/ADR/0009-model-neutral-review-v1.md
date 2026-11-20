# ADR-0009: V1 review contractをモデル中立にする

- Status: Accepted
- Date: 2026-08-24

## Context

具体的な記憶モデル、復習間隔、優先順位はまだ評価されていません。初期基盤で特定モデルを公開契約へ固定すると、検証前の仮定が互換性制約になります。

## Decision

V1のquestion stateとreview planはalgorithm ID/version、evidence情報、nullableな次回復習日、順位、選定理由を運べるモデル中立契約にします。具体的な記憶強度式や間隔規則は実装しません。

## Consequences

複数algorithmを同じ外側の契約で比較できます。後続実装ではalgorithmごとの決定とacceptance criteriaを別ADRに記録する必要があります。
