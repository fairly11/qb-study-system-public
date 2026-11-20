# ADR-0005: Attemptのidempotencyと追記専用性

- Status: Accepted
- Date: 2026-08-24

## Context

collectorの再送は安全に無視する必要がありますが、同じ問題への正当な反復解答を内容一致だけで削除してはいけません。

## Decision

event IDを一意とし、source record IDがある場合はsource systemとの組にも部分一意制約を置きます。同じ識別子・同じ安全fieldは `duplicate`、同じ識別子・異なる内容は `IDEMPOTENCY_CONFLICT` とします。内容hashだけには一意制約を置きません。attemptsと選択番号はDB triggerでもUPDATE/DELETEを拒否します。

## Consequences

正当な反復解答が保持されます。producerは安定したevent IDまたはsource record IDを供給する必要があり、衝突は自動上書きされません。
