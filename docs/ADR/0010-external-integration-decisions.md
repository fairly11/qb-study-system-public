# ADR-0010: 外部連携の未解決事項

- Status: Proposed
- Date: 2026-08-24

## Context

browser取得、Google Sheets同期、QB問題セット作成には、外部権限と公開契約に影響する判断材料が不足しています。

## Decision pending

次は未決であり、このADRがAcceptedになるまで実装しません。

- QB画面で利用可能な明示的・公開の取得手段と最小Chrome権限
- 画面上の選択肢から1始まりindexへの対応規則
- Sheetsの列、認証、同期頻度、再試行、部分失敗の扱い
- 問題セット作成の公開操作方式、dry-run、承認、post-write検証
- 具体的な記憶モデル、復習間隔、優先順位とevidence不足時の挙動

## Temporary consequence

初期manifestは無権限とし、接続・認証・外部操作のコードや設定を追加しません。契約上の不明値を推測せず、未解決として保持します。
