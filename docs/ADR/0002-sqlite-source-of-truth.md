# ADR-0002: SQLiteを正本とする

- Status: Accepted
- Date: 2026-08-24

## Context

演習履歴には一貫した重複排除、追記専用制約、transaction、migrationが必要です。Google Sheetsは人が閲覧・集計するには便利ですが、同時更新や厳密な制約の正本には適しません。

## Decision

SQLiteを唯一の正本とし、Google Sheetsは将来の片方向同期先に限定します。初期adapterはNode.js 24の `node:sqlite` を使用し、`StorageDriver` 境界の内側へ隔離します。本番DBはrepoとiCloud同期領域の外側に置きます。

## Consequences

一貫性をローカルtransactionで守れます。一方、Node 24での `node:sqlite` Release Candidate状態を受容します。APIや安定性の問題があれば、公開storage境界を保ったままadapterを差し替えます。
